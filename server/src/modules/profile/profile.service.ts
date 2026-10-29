import type { GameKey, GameMode, TerminationReason } from '@cardplay/shared';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { gameRecordPlayers, userRatings, users } from '../../db/schema';
import { HttpError } from '../../http-error';
import { findUserById, type UserRow } from '../users/users.queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Page = { limit: number; offset: number };

export type GameStats = {
  played: number;
  wins: number;
  losses: number;
  draws: number;
  // percent of played games that were won, one decimal
  winRate: number;
};

export type Profile = {
  id: string;
  username: string;
  createdAt: Date;
  games: (GameStats & { gameType: GameKey; elo: number | null })[];
  totals: GameStats;
};

export type HistoryItem = {
  recordId: string;
  gameType: GameKey;
  mode: GameMode;
  startedAt: Date;
  finishedAt: Date;
  terminationReason: TerminationReason;
  result: 'win' | 'loss' | 'draw' | 'cancelled';
  finalRank: number | null;
  eloChange: number | null;
  // a bot has no user id
  opponents: { userId: string | null; username: string }[];
};

export type LeaderboardItem = {
  rank: number;
  userId: string;
  username: string;
  elo: number;
  gamesPlayed: number;
};

const winRate = (wins: number, played: number): number =>
  played === 0 ? 0 : Math.round((wins / played) * 1000) / 10;

export function createProfileService(db: Db) {
  // a user is found by id or by user name, in any letter case
  async function findUser(ref: string): Promise<UserRow> {
    const user = UUID.test(ref)
      ? await findUserById(db, ref)
      : (
          await db
            .select()
            .from(users)
            .where(sql`lower(${users.username}) = ${ref.toLowerCase()}`)
        )[0];
    if (!user) throw new HttpError(404, 'NOT_FOUND', 'user not found');
    return user;
  }

  // Counted games match the rules of games_played: finished, not cancelled, only against humans.
  async function getProfile(user: UserRow): Promise<Profile> {
    const stats = await db.execute<{
      gameType: GameKey;
      played: number;
      wins: number;
      losses: number;
      draws: number;
    }>(sql`
      select r.game_type as "gameType",
             count(*)::int as played,
             (count(*) filter (where r.winner_id = ${user.id}))::int as wins,
             (count(*) filter (where r.winner_id is not null and r.winner_id <> ${user.id}))::int as losses,
             (count(*) filter (where r.winner_id is null))::int as draws
      from game_record_players me
      join game_records r on r.id = me.record_id
      where me.user_id = ${user.id}
        and r.finished_at is not null
        and r.termination_reason <> 'cancelled'
        and not exists (
          select 1 from game_record_players other
          where other.record_id = r.id and other.user_id is null
        )
      group by r.game_type
      order by r.game_type`);
    const ratings = await db.select().from(userRatings).where(eq(userRatings.userId, user.id));

    const byGame = new Map<GameKey, Profile['games'][number]>();
    for (const row of stats.rows) {
      byGame.set(row.gameType, { ...row, winRate: winRate(row.wins, row.played), elo: null });
    }
    for (const rating of ratings) {
      const entry = byGame.get(rating.gameType) ?? {
        gameType: rating.gameType,
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: 0,
        elo: null,
      };
      byGame.set(rating.gameType, { ...entry, elo: rating.elo });
    }
    const games = [...byGame.values()].filter((g) => g.played > 0 || g.elo !== null);
    const sum = (key: 'played' | 'wins' | 'losses' | 'draws') =>
      games.reduce((total, g) => total + g[key], 0);
    const totals = {
      played: sum('played'),
      wins: sum('wins'),
      losses: sum('losses'),
      draws: sum('draws'),
      winRate: winRate(sum('wins'), sum('played')),
    };
    return { id: user.id, username: user.username, createdAt: user.createdAt, games, totals };
  }

  async function getHistory(
    userId: string,
    { limit, offset }: Page,
  ): Promise<{ total: number; items: HistoryItem[] }> {
    const base = sql`
      from game_record_players me
      join game_records r on r.id = me.record_id
      where me.user_id = ${userId} and r.finished_at is not null`;
    const total = await db.execute<{ total: number }>(sql`select count(*)::int as total ${base}`);
    const rows = await db.execute<{
      id: string;
      gameType: GameKey;
      mode: GameMode;
      // raw SQL hands timestamps back as text
      startedAt: string;
      finishedAt: string;
      terminationReason: TerminationReason;
      winnerId: string | null;
      finalRank: number | null;
      eloChange: number | null;
    }>(sql`
      select r.id, r.game_type as "gameType", r.mode, r.started_at as "startedAt",
             r.finished_at as "finishedAt", r.termination_reason as "terminationReason",
             r.winner_id as "winnerId", me.final_rank as "finalRank", me.elo_change as "eloChange"
      ${base}
      order by r.finished_at desc, r.id desc
      limit ${limit} offset ${offset}`);

    const ids = rows.rows.map((row) => row.id);
    const others =
      ids.length === 0
        ? []
        : await db
            .select({
              recordId: gameRecordPlayers.recordId,
              userId: gameRecordPlayers.userId,
              username: users.username,
            })
            .from(gameRecordPlayers)
            .leftJoin(users, eq(users.id, gameRecordPlayers.userId))
            .where(
              and(
                inArray(gameRecordPlayers.recordId, ids),
                or(isNull(gameRecordPlayers.userId), ne(gameRecordPlayers.userId, userId)),
              ),
            );

    const items = rows.rows.map((row): HistoryItem => {
      let result: HistoryItem['result'] = 'loss';
      if (row.terminationReason === 'cancelled') result = 'cancelled';
      else if (row.winnerId === userId) result = 'win';
      else if (row.winnerId === null) result = 'draw';
      return {
        recordId: row.id,
        gameType: row.gameType,
        mode: row.mode,
        startedAt: new Date(row.startedAt),
        finishedAt: new Date(row.finishedAt),
        terminationReason: row.terminationReason,
        result,
        finalRank: row.finalRank,
        eloChange: row.eloChange,
        opponents: others
          .filter((o) => o.recordId === row.id)
          .map((o) => ({ userId: o.userId, username: o.username ?? 'Bot' })),
      };
    });
    return { total: total.rows[0]?.total ?? 0, items };
  }

  async function getLeaderboard(
    gameType: GameKey,
    { limit, offset }: Page,
  ): Promise<{ total: number; items: LeaderboardItem[] }> {
    const played = and(eq(userRatings.gameType, gameType), gt(userRatings.gamesPlayed, 0));
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(userRatings)
      .where(played);
    const rows = await db
      .select({
        userId: userRatings.userId,
        username: users.username,
        elo: userRatings.elo,
        gamesPlayed: userRatings.gamesPlayed,
      })
      .from(userRatings)
      .innerJoin(users, eq(users.id, userRatings.userId))
      .where(played)
      .orderBy(desc(userRatings.elo), desc(userRatings.gamesPlayed), asc(users.username))
      .limit(limit)
      .offset(offset);
    return { total, items: rows.map((row, i) => ({ rank: offset + i + 1, ...row })) };
  }

  return { findUser, getProfile, getHistory, getLeaderboard };
}

export type ProfileService = ReturnType<typeof createProfileService>;
