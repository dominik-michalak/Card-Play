import type { GameResult, GameState, TerminationReason } from '@cardplay/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { gameRecordPlayers, gameRecords, gameRooms, userRatings } from '../../db/schema';
import { HttpError } from '../../http-error';
import { eloGain } from './elo';

export type RatingChange = { userId: string; eloBefore: number; eloChange: number };

export type GameOutcome = {
  recordId: string;
  // null for a draw, a cancelled game or a win by a bot
  winnerId: string | null;
  // empty unless the game was rated
  ratings: RatingChange[];
};

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
        if (rank !== undefined) {
          await tx
            .update(gameRecordPlayers)
            .set({ finalRank: rank })
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

      return { recordId, winnerId, ratings };
    });
  }

  return { startGame, finishGame };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
