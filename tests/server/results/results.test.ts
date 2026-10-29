import type { GamePlayer, GameResult, GameState, TerminationReason } from '@cardplay/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  gameRecordPlayers,
  gameRecords,
  gameRooms,
  roomPlayers,
  userRatings,
} from '../../../server/src/db/schema';
import { createResultsService } from '../../../server/src/modules/results/results.service';
import { startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;
let results: ReturnType<typeof createResultsService>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb(app.db);
  results = createResultsService(app.db);
});

type Mode = 'competitive' | 'unrated' | 'private' | 'bot';
type Gamer = { id: string; username: string };

async function seedGame(options: {
  mode: Mode;
  gameType?: 'war' | 'poker';
  humans?: number;
  bots?: number;
}) {
  const { mode, gameType = 'war', humans = 2, bots = 0 } = options;
  const gamers: Gamer[] = [];
  for (let i = 0; i < humans; i++) {
    gamers.push(await seedUser(app.db, `player_${i}`));
  }
  const [room] = await app.db
    .insert(gameRooms)
    .values({ gameType, mode, targetPlayers: humans + bots, createdBy: gamers[0]!.id })
    .returning();
  await app.db
    .insert(roomPlayers)
    .values(gamers.map((g, seatIndex) => ({ roomId: room!.id, userId: g.id, seatIndex })));

  const players: GamePlayer[] = [
    ...gamers.map((g) => ({ id: g.id, username: g.username, isBot: false })),
    ...Array.from({ length: bots }, (_, i) => ({
      id: `bot-${i}`,
      username: `Bot ${i}`,
      isBot: true,
    })),
  ];
  const state: GameState = { gameKey: gameType, players, currentPlayerId: null };
  return { roomId: room!.id, gamers, state };
}

// placements in finishing order: the first id gets rank 1, the second rank 2, …
const finished = (reason: TerminationReason, order: string[]): GameResult => ({
  terminationReason: reason,
  placements: order.map((playerId, i) => ({ playerId, rank: i + 1 })),
});
const draw = (reason: TerminationReason, ids: string[]): GameResult => ({
  terminationReason: reason,
  placements: ids.map((playerId) => ({ playerId, rank: 1 })),
});

const ratingOf = async (userId: string, gameType: 'war' | 'poker' = 'war') =>
  (
    await app.db
      .select()
      .from(userRatings)
      .where(and(eq(userRatings.userId, userId), eq(userRatings.gameType, gameType)))
  )[0];
const recordOf = async (id: string) =>
  (await app.db.select().from(gameRecords).where(eq(gameRecords.id, id)))[0]!;
const playerRowsOf = (recordId: string) =>
  app.db.select().from(gameRecordPlayers).where(eq(gameRecordPlayers.recordId, recordId));
const roomStatus = async (roomId: string) =>
  (await app.db.select().from(gameRooms).where(eq(gameRooms.id, roomId)))[0]?.status;

describe('startGame', () => {
  it('opens an unfinished record, lists the players and moves the room to in_progress', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });

    const recordId = await results.startGame(roomId, state);

    const record = await recordOf(recordId);
    expect(record).toMatchObject({
      roomId,
      gameType: 'war',
      mode: 'competitive',
      state,
      terminationReason: null,
      finishedAt: null,
    });
    expect((await playerRowsOf(recordId)).map((r) => r.userId).sort()).toEqual(
      gamers.map((g) => g.id).sort(),
    );
    expect(await roomStatus(roomId)).toBe('in_progress');
  });

  it('stores bots without a user id', async () => {
    const { roomId, state } = await seedGame({ mode: 'bot', humans: 1, bots: 1 });
    const recordId = await results.startGame(roomId, state);
    expect(
      (await playerRowsOf(recordId)).map((r) => r.userId).filter((id) => id === null),
    ).toHaveLength(1);
  });

  it('refuses a room whose game already started', async () => {
    const { roomId, state } = await seedGame({ mode: 'competitive' });
    await results.startGame(roomId, state);
    await expect(results.startGame(roomId, state)).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_ACTION',
    });
  });

  it('answers ROOM_NOT_FOUND for an unknown room', async () => {
    const { state } = await seedGame({ mode: 'competitive' });
    await expect(
      results.startGame('00000000-0000-4000-8000-000000000000', state),
    ).rejects.toMatchObject({ status: 404, code: 'ROOM_NOT_FOUND' });
  });
});

describe('startGame checks the table', () => {
  it('refuses a game whose players differ from the people in the room', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    await app.db
      .delete(roomPlayers)
      .where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.userId, gamers[1]!.id)));

    await expect(results.startGame(roomId, state)).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_ACTION',
    });
    expect(await roomStatus(roomId)).toBe('waiting');
  });
});

describe('cancelUnfinishedGames', () => {
  it('closes every running game as cancelled without touching Elo', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);

    const count = await results.cancelUnfinishedGames();

    expect(count).toBe(1);
    expect(await recordOf(recordId)).toMatchObject({
      terminationReason: 'cancelled',
      winnerId: null,
    });
    expect(await roomStatus(roomId)).toBe('finished');
    expect(await ratingOf(gamers[0]!.id)).toBeUndefined();
  });

  it('leaves finished games alone', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'private' });
    const recordId = await results.startGame(roomId, state);
    await results.finishGame(
      recordId,
      finished('all_cards', [gamers[0]!.id, gamers[1]!.id]),
      state,
    );

    expect(await results.cancelUnfinishedGames()).toBe(0);
    expect((await recordOf(recordId)).terminationReason).toBe('all_cards');
  });
});

describe('finishGame in a ranked 1v1', () => {
  it.each(['all_cards', 'round_limit', 'timeout_forfeit', 'disconnect_forfeit'] as const)(
    'moves Elo after %s',
    async (reason) => {
      const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
      const [winner, loser] = [gamers[0]!, gamers[1]!];
      const recordId = await results.startGame(roomId, state);

      const outcome = await results.finishGame(
        recordId,
        finished(reason, [winner.id, loser.id]),
        state,
      );

      expect(outcome.winnerId).toBe(winner.id);
      expect(outcome.ratings).toEqual(
        expect.arrayContaining([
          { userId: winner.id, eloBefore: 1000, eloChange: 16 },
          { userId: loser.id, eloBefore: 1000, eloChange: -16 },
        ]),
      );
      expect(await ratingOf(winner.id)).toMatchObject({ elo: 1016, gamesPlayed: 1 });
      expect(await ratingOf(loser.id)).toMatchObject({ elo: 984, gamesPlayed: 1 });
    },
  );

  it('writes the record, the placements and the room status', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const [winner, loser] = [gamers[1]!, gamers[0]!];
    const recordId = await results.startGame(roomId, state);
    const finalState = { ...state, currentPlayerId: winner.id };

    await results.finishGame(recordId, finished('all_cards', [winner.id, loser.id]), finalState);

    const record = await recordOf(recordId);
    expect(record).toMatchObject({
      terminationReason: 'all_cards',
      winnerId: winner.id,
      state: finalState,
    });
    expect(record.finishedAt).toBeInstanceOf(Date);
    const rows = await playerRowsOf(recordId);
    expect(rows.find((r) => r.userId === winner.id)).toMatchObject({
      finalRank: 1,
      eloBefore: 1000,
      eloChange: 16,
    });
    expect(rows.find((r) => r.userId === loser.id)).toMatchObject({
      finalRank: 2,
      eloBefore: 1000,
      eloChange: -16,
    });
    expect(await roomStatus(roomId)).toBe('finished');
  });

  it('builds on the existing ratings', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const [underdog, favourite] = [gamers[0]!, gamers[1]!];
    await app.db.insert(userRatings).values([
      { userId: underdog.id, gameType: 'war', elo: 1000, gamesPlayed: 3 },
      { userId: favourite.id, gameType: 'war', elo: 1200, gamesPlayed: 9 },
    ]);
    const recordId = await results.startGame(roomId, state);

    await results.finishGame(recordId, finished('all_cards', [underdog.id, favourite.id]), state);

    expect(await ratingOf(underdog.id)).toMatchObject({ elo: 1024, gamesPlayed: 4 });
    expect(await ratingOf(favourite.id)).toMatchObject({ elo: 1176, gamesPlayed: 10 });
  });

  it('keeps ratings separate per game', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);
    await results.finishGame(
      recordId,
      finished('all_cards', [gamers[0]!.id, gamers[1]!.id]),
      state,
    );

    expect(await ratingOf(gamers[0]!.id, 'poker')).toBeUndefined();
  });

  it('never lets a rating drop below zero', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const [winner, loser] = [gamers[0]!, gamers[1]!];
    await app.db.insert(userRatings).values([
      { userId: winner.id, gameType: 'war', elo: 5 },
      { userId: loser.id, gameType: 'war', elo: 5 },
    ]);
    const recordId = await results.startGame(roomId, state);

    const outcome = await results.finishGame(
      recordId,
      finished('all_cards', [winner.id, loser.id]),
      state,
    );

    expect(await ratingOf(loser.id)).toMatchObject({ elo: 0 });
    expect(outcome.ratings.find((r) => r.userId === loser.id)?.eloChange).toBe(-5);
  });

  it.each([
    ['draw', 'draw'],
    ['double_timeout', 'double_timeout'],
    ['draw', 'round_limit'],
  ] as const)('leaves Elo alone after a %s result (%s)', async (_label, reason) => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);

    const outcome = await results.finishGame(
      recordId,
      draw(
        reason,
        gamers.map((g) => g.id),
      ),
      state,
    );

    expect(outcome).toMatchObject({ winnerId: null, ratings: [] });
    // the game was completed, so it counts as played, but nobody gains or loses points
    expect(await ratingOf(gamers[0]!.id)).toMatchObject({ elo: 1000, gamesPlayed: 1 });
    expect((await playerRowsOf(recordId)).every((r) => r.eloChange === null)).toBe(true);
    expect((await recordOf(recordId)).winnerId).toBeNull();
    expect(await roomStatus(roomId)).toBe('finished');
  });

  it('records a cancelled game without ranks, winner or Elo', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);

    const outcome = await results.finishGame(
      recordId,
      { terminationReason: 'cancelled', placements: [] },
      state,
    );

    expect(outcome).toMatchObject({ winnerId: null, ratings: [] });
    expect((await recordOf(recordId)).terminationReason).toBe('cancelled');
    expect((await playerRowsOf(recordId)).every((r) => r.finalRank === null)).toBe(true);
    expect(await ratingOf(gamers[0]!.id)).toBeUndefined();
  });
});

describe('getRating', () => {
  it('is 1000 for a player who has no rating yet', async () => {
    const { gamers } = await seedGame({ mode: 'competitive' });
    expect(await results.getRating(gamers[0]!.id, 'war')).toBe(1000);
  });

  it('returns the stored rating of that game only', async () => {
    const { gamers } = await seedGame({ mode: 'competitive' });
    await app.db.insert(userRatings).values([
      { userId: gamers[0]!.id, gameType: 'war', elo: 1234 },
      { userId: gamers[0]!.id, gameType: 'macao', elo: 888 },
    ]);
    expect(await results.getRating(gamers[0]!.id, 'war')).toBe(1234);
    expect(await results.getRating(gamers[0]!.id, 'macao')).toBe(888);
  });
});

describe('finishGame after a turn limit', () => {
  it('accepts turn_limit and rates a clear winner like any other result', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);

    const outcome = await results.finishGame(
      recordId,
      finished('turn_limit', [gamers[0]!.id, gamers[1]!.id]),
      state,
    );

    expect(outcome.winnerId).toBe(gamers[0]!.id);
    expect(outcome.ratings).toHaveLength(2);
    expect((await recordOf(recordId)).terminationReason).toBe('turn_limit');
  });
});

describe('finishGame in unranked games', () => {
  it.each(['private', 'unrated'] as const)('counts a %s 1v1 but keeps Elo', async (mode) => {
    const { roomId, gamers, state } = await seedGame({ mode });
    const recordId = await results.startGame(roomId, state);

    const outcome = await results.finishGame(
      recordId,
      finished('all_cards', [gamers[0]!.id, gamers[1]!.id]),
      state,
    );

    expect(outcome).toMatchObject({ winnerId: gamers[0]!.id, ratings: [] });
    expect(await ratingOf(gamers[0]!.id)).toMatchObject({ elo: 1000, gamesPlayed: 1 });
    expect(await ratingOf(gamers[1]!.id)).toMatchObject({ elo: 1000, gamesPlayed: 1 });
  });

  it('adds to the games played without touching an existing rating', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'private' });
    await app.db
      .insert(userRatings)
      .values({ userId: gamers[0]!.id, gameType: 'war', elo: 1100, gamesPlayed: 3 });
    const recordId = await results.startGame(roomId, state);

    await results.finishGame(
      recordId,
      finished('all_cards', [gamers[0]!.id, gamers[1]!.id]),
      state,
    );

    expect(await ratingOf(gamers[0]!.id)).toMatchObject({ elo: 1100, gamesPlayed: 4 });
  });

  it('stores every rank of a multiplayer game but changes no Elo', async () => {
    const { roomId, gamers, state } = await seedGame({
      mode: 'private',
      gameType: 'poker',
      humans: 3,
    });
    const recordId = await results.startGame(roomId, state);

    await results.finishGame(
      recordId,
      finished(
        'completed',
        gamers.map((g) => g.id),
      ),
      state,
    );

    const rows = await playerRowsOf(recordId);
    expect(gamers.map((g) => rows.find((r) => r.userId === g.id)?.finalRank)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.eloChange === null)).toBe(true);
    expect((await recordOf(recordId)).winnerId).toBe(gamers[0]!.id);
    for (const gamer of gamers) {
      expect(await ratingOf(gamer.id, 'poker')).toMatchObject({ elo: 1000, gamesPlayed: 1 });
    }
  });

  it('records bot games without counting them as games against humans', async () => {
    const humanWins = await seedGame({ mode: 'bot', humans: 1, bots: 1 });
    const firstRecord = await results.startGame(humanWins.roomId, humanWins.state);
    const human = humanWins.gamers[0]!;
    const won = await results.finishGame(
      firstRecord,
      finished('all_cards', [human.id, 'bot-0']),
      humanWins.state,
    );
    expect(won.winnerId).toBe(human.id);
    expect(await ratingOf(human.id)).toBeUndefined();

    await resetDb(app.db);
    const botWins = await seedGame({ mode: 'bot', humans: 1, bots: 1 });
    const secondRecord = await results.startGame(botWins.roomId, botWins.state);
    const lost = await results.finishGame(
      secondRecord,
      finished('all_cards', ['bot-0', botWins.gamers[0]!.id]),
      botWins.state,
    );
    expect(lost.winnerId).toBeNull();
    expect(await ratingOf(botWins.gamers[0]!.id)).toBeUndefined();
  });
});

describe('finishGame guards', () => {
  it('refuses to finish a game twice', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);
    const result = finished('all_cards', [gamers[0]!.id, gamers[1]!.id]);
    await results.finishGame(recordId, result, state);

    await expect(results.finishGame(recordId, result, state)).rejects.toMatchObject({
      status: 409,
      code: 'GAME_OVER',
    });
    expect(await ratingOf(gamers[0]!.id)).toMatchObject({ elo: 1016, gamesPlayed: 1 });
  });

  it('applies Elo once when the same game is finished twice at the same moment', async () => {
    const { roomId, gamers, state } = await seedGame({ mode: 'competitive' });
    const recordId = await results.startGame(roomId, state);
    const result = finished('all_cards', [gamers[0]!.id, gamers[1]!.id]);

    const settled = await Promise.allSettled([
      results.finishGame(recordId, result, state),
      results.finishGame(recordId, result, state),
    ]);

    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await ratingOf(gamers[0]!.id)).toMatchObject({ elo: 1016, gamesPlayed: 1 });
  });

  it('answers NOT_FOUND for an unknown record', async () => {
    const { gamers, state } = await seedGame({ mode: 'competitive' });
    await expect(
      results.finishGame(
        '00000000-0000-4000-8000-000000000000',
        finished('all_cards', [gamers[0]!.id, gamers[1]!.id]),
        state,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
