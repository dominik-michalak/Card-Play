import type {
  AchievementId,
  GameFacts,
  GameKey,
  GameResult,
  GameState,
  RatingChange,
  TerminationReason,
} from '@cardplay/shared';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  gameRecordPlayers,
  gameRecords,
  gameRooms,
  roomPlayers,
  userAchievements,
  userRatings,
} from '../../db/schema';
import { HttpError } from '../../http-error';
import { eloGain } from './elo';

export type GameOutcome = {
  recordId: string;
  // null for a draw, a cancelled game or a win by a bot
  winnerId: string | null;
  // empty unless the game was rated
  ratings: RatingChange[];
  // achievements this game unlocked, each reported once
  achievements: { userId: string; achievementId: AchievementId; unlockedAt: Date }[];
};

const FAIR_PLAY_GAMES = 10;
const STREAK_LENGTH = 5;

// a result that decides nobody's strength, so it never moves Elo
const UNRATED_REASONS: TerminationReason[] = ['draw', 'double_timeout', 'cancelled'];

// called by the game runner (socket layer): once when a game starts, once when it ends
export function createResultsService(db: Db) {
  async function startGame(roomId: string, state: GameState): Promise<string> {
    return db.transaction(async (tx) => {
      const [room] = await tx
        .select()
        .from(gameRooms)
        .where(eq(gameRooms.id, roomId))
        .for('update');
      if (!room) {
        throw new HttpError(404, 'ROOM_NOT_FOUND', 'room not found');
      }
      if (room.status !== 'waiting') {
        throw new HttpError(409, 'INVALID_ACTION', 'the game has already started');
      }

      // a player may have left while the countdown was running
      const seated = await tx
        .select({ userId: roomPlayers.userId })
        .from(roomPlayers)
        .where(eq(roomPlayers.roomId, roomId));
      const seatedIds = seated.map((s) => s.userId).sort();
      const playingIds = state.players
        .filter((p) => !p.isBot)
        .map((p) => p.id)
        .sort();
      if (seatedIds.join() !== playingIds.join()) {
        throw new HttpError(409, 'INVALID_ACTION', 'the players differ from the room');
      }
      await tx.update(gameRooms).set({ status: 'in_progress' }).where(eq(gameRooms.id, roomId));

      const [record] = await tx
        .insert(gameRecords)
        .values({ roomId, gameType: room.gameType, mode: room.mode, state })
        .returning({ id: gameRecords.id });
      await tx
        .insert(gameRecordPlayers)
        .values(
          state.players.map((p) => ({ recordId: record!.id, userId: p.isBot ? null : p.id })),
        );
      return record!.id;
    });
  }

  async function finishGame(
    recordId: string,
    result: GameResult,
    finalState: GameState,
    facts: GameFacts = {},
  ): Promise<GameOutcome> {
    return db.transaction(async (tx) => {
      // the lock makes a duplicate finish wait, then see `finishedAt` and fail
      const [record] = await tx
        .select()
        .from(gameRecords)
        .where(eq(gameRecords.id, recordId))
        .for('update');
      if (!record) {
        throw new HttpError(404, 'NOT_FOUND', 'game record not found');
      }
      if (record.finishedAt) {
        throw new HttpError(409, 'GAME_OVER', 'game already finished');
      }

      const rows = await tx
        .select()
        .from(gameRecordPlayers)
        .where(eq(gameRecordPlayers.recordId, recordId));
      const rankOf = new Map(result.placements.map((p) => [p.playerId, p.rank]));
      for (const row of rows) {
        const rank = row.userId ? rankOf.get(row.userId) : undefined;
        const forfeited = row.userId ? facts[row.userId]?.forfeited === true : false;
        if (rank !== undefined || forfeited) {
          await tx
            .update(gameRecordPlayers)
            .set({ ...(rank !== undefined && { finalRank: rank }), forfeited })
            .where(eq(gameRecordPlayers.id, row.id));
        }
      }

      const winners = result.placements.filter((p) => p.rank === 1);
      const winnerId =
        result.terminationReason !== 'cancelled' && winners.length === 1
          ? (rows.find((r) => r.userId === winners[0]!.playerId)?.userId ?? null)
          : null;

      const humanIds = rows.flatMap((r) => (r.userId ? [r.userId] : []));
      // a completed game against humans counts as played in every mode
      const counted = result.terminationReason !== 'cancelled' && humanIds.length === rows.length;
      // Elo moves only in a competitive 1v1 with a clear winner
      const rated =
        counted &&
        record.mode === 'competitive' &&
        rows.length === 2 &&
        winnerId !== null &&
        !UNRATED_REASONS.includes(result.terminationReason);

      const ratings = counted
        ? await updateRatings(tx, record.gameType, humanIds, rated ? winnerId : null)
        : [];
      for (const change of ratings) {
        await tx
          .update(gameRecordPlayers)
          .set({ eloBefore: change.eloBefore, eloChange: change.eloChange })
          .where(
            and(
              eq(gameRecordPlayers.recordId, recordId),
              eq(gameRecordPlayers.userId, change.userId),
            ),
          );
      }

      await tx
        .update(gameRecords)
        .set({
          state: finalState,
          terminationReason: result.terminationReason,
          winnerId,
          finishedAt: new Date(),
        })
        .where(eq(gameRecords.id, recordId));
      await tx.update(gameRooms).set({ status: 'finished' }).where(eq(gameRooms.id, record.roomId));

      const achievements = counted
        ? await unlockAchievements(tx, record.gameType, record.mode, humanIds, winnerId, facts)
        : [];
      return { recordId, winnerId, ratings, achievements };
    });
  }

  // after a restart no runner holds these games, and they are not resumed
  async function cancelUnfinishedGames(): Promise<number> {
    const open = await db
      .select({ id: gameRecords.id, state: gameRecords.state })
      .from(gameRecords)
      .where(isNull(gameRecords.finishedAt));
    for (const record of open) {
      await finishGame(
        record.id,
        { terminationReason: 'cancelled', placements: [] },
        record.state as GameState,
      );
    }
    return open.length;
  }

  // 1000 until the player has finished a game of that kind
  async function getRating(userId: string, gameType: GameKey): Promise<number> {
    const [row] = await db
      .select({ elo: userRatings.elo })
      .from(userRatings)
      .where(and(eq(userRatings.userId, userId), eq(userRatings.gameType, gameType)));
    return row?.elo ?? 1000;
  }

  return { startGame, finishGame, cancelUnfinishedGames, getRating };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// finished games against humans that this player did not lose by a forfeit
async function countCleanGames(tx: Tx, userId: string): Promise<number> {
  const result = await tx.execute<{ total: number }>(sql`
    select count(*)::int as total
    from game_record_players me
    join game_records r on r.id = me.record_id
    where me.user_id = ${userId}
      and me.forfeited = false
      and r.finished_at is not null
      and r.termination_reason <> 'cancelled'
      and not exists (
        select 1 from game_record_players other
        where other.record_id = r.id and other.user_id is null
      )`);
  return result.rows[0]?.total ?? 0;
}

// the last ranked games of the player in this game were all won (a draw breaks the run)
async function hasWinStreak(tx: Tx, userId: string, gameType: GameKey): Promise<boolean> {
  const recent = await tx
    .select({ winnerId: gameRecords.winnerId })
    .from(gameRecordPlayers)
    .innerJoin(gameRecords, eq(gameRecords.id, gameRecordPlayers.recordId))
    .where(
      and(
        eq(gameRecordPlayers.userId, userId),
        eq(gameRecords.gameType, gameType),
        eq(gameRecords.mode, 'competitive'),
        ne(gameRecords.terminationReason, 'cancelled'),
      ),
    )
    .orderBy(desc(gameRecords.finishedAt), desc(gameRecords.id))
    .limit(STREAK_LENGTH);
  return recent.length === STREAK_LENGTH && recent.every((game) => game.winnerId === userId);
}

// Decided by the backend after the game is saved. The facts come from the game module on the
// server, never from a client. Inserting an existing achievement does nothing, so a repeat or a
// race unlocks it once, and only the insert that won reports it.
async function unlockAchievements(
  tx: Tx,
  gameType: GameKey,
  mode: string,
  humanIds: string[],
  winnerId: string | null,
  facts: GameFacts,
): Promise<GameOutcome['achievements']> {
  const unlocked: GameOutcome['achievements'] = [];
  for (const userId of humanIds) {
    const own = facts[userId] ?? {};
    const earned: AchievementId[] = [];
    if (winnerId === userId) earned.push('first_win');
    if (own.warChain3) earned.push('war_chain_3');
    if (own.macaoCleanFinish) earned.push('macao_clean_finish');
    if (own.macaoComeback) earned.push('macao_comeback');
    if (own.pokerAllInWin) earned.push('poker_all_in_win');
    if (own.pokerEliminator) earned.push('poker_eliminator');
    if (!own.forfeited && (await countCleanGames(tx, userId)) >= FAIR_PLAY_GAMES) {
      earned.push('fair_play_10');
    }
    if (mode === 'competitive' && (await hasWinStreak(tx, userId, gameType))) {
      earned.push('streak_5');
    }
    if (earned.length === 0) continue;
    const inserted = await tx
      .insert(userAchievements)
      .values(earned.map((achievementId) => ({ userId, achievementId })))
      .onConflictDoNothing()
      .returning();
    unlocked.push(...inserted);
  }
  return unlocked;
}

// Adds one played game to every human and, when `winnerId` is set, moves Elo from the other
// player of the 1v1 to the winner. Returns the Elo movements only.
async function updateRatings(
  tx: Tx,
  gameType: (typeof userRatings.$inferSelect)['gameType'],
  userIds: string[],
  winnerId: string | null,
): Promise<RatingChange[]> {
  // rows are created lazily; the defaults give a new player 1000
  await tx
    .insert(userRatings)
    .values(userIds.map((userId) => ({ userId, gameType })))
    .onConflictDoNothing();
  // locked in user id order, so games sharing a player cannot deadlock
  const locked = await tx
    .select()
    .from(userRatings)
    .where(and(eq(userRatings.gameType, gameType), inArray(userRatings.userId, userIds)))
    .orderBy(userRatings.userId)
    .for('update');

  const winner = locked.find((r) => r.userId === winnerId);
  const loser = winner ? locked.find((r) => r !== winner) : undefined;
  const gain = winner && loser ? eloGain(winner.elo, loser.elo) : 0;

  const changes: RatingChange[] = [];
  for (const row of locked) {
    let elo = row.elo;
    if (row === winner) elo += gain;
    if (row === loser) elo = Math.max(0, elo - gain);
    await tx
      .update(userRatings)
      .set({ elo, gamesPlayed: row.gamesPlayed + 1 })
      .where(and(eq(userRatings.userId, row.userId), eq(userRatings.gameType, gameType)));
    if (row === winner || row === loser) {
      changes.push({ userId: row.userId, eloBefore: row.elo, eloChange: elo - row.elo });
    }
  }
  return changes;
}

export type ResultsService = ReturnType<typeof createResultsService>;
