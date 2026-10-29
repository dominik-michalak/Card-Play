import type { ErrorPayload, GameResult, RatingChange } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRecords, userRatings } from '../../../server/src/db/schema';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer, type TestClient } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

// widens fast enough to be seen in a test: 0 extra at first, +100 every 150 ms
const RULES = { base: 200, step: 100, everyMs: 150 };

beforeAll(async () => {
  server = await startRealtimeServer(undefined, { matchRules: RULES });
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));
afterEach(() => server.closeClients());

type Found = { roomId: string };
type Status = { queued: boolean; reason?: string };
type StateEvent = { state: { gameKey: string } };
type FinishedEvent = { result: GameResult; ratings: RatingChange[] };

async function player(name: string, elo?: number) {
  const user = await seedUser(server.db, name);
  if (elo !== undefined) {
    await server.db.insert(userRatings).values({ userId: user.id, gameType: 'war', elo });
  }
  return { user, client: await server.connectAs(user.id) };
}

const queue = (
  client: TestClient,
  mode: 'competitive' | 'unrated' = 'competitive',
  gameType: 'war' | 'macao' = 'war',
) => client.emit('matchmaking:join', { gameType, mode });

describe('matchmaking', () => {
  it('pairs two players of similar strength and starts a rated game by itself', async () => {
    const a = await player('player_a');
    const b = await player('player_b');

    queue(a.client);
    queue(b.client);
    const [foundA, foundB] = await Promise.all([
      a.client.next<Found>('matchmaking:found'),
      b.client.next<Found>('matchmaking:found'),
    ]);
    expect(foundA.roomId).toBe(foundB.roomId);

    // the clients enter the room; joining is being ready in a matchmaking room
    a.client.emit('room:join', { roomId: foundA.roomId });
    b.client.emit('room:join', { roomId: foundA.roomId });
    const start = await a.client.next<StateEvent>('game:state_update');
    expect(start.state.gameKey).toBe('war');

    const [record] = await server.db.select().from(gameRecords);
    expect(record).toMatchObject({ mode: 'competitive', roomId: foundA.roomId });
  });

  it('tells the player they are queued, and lets them leave', async () => {
    const a = await player('player_a');
    queue(a.client, 'unrated', 'macao');
    expect(await a.client.next<Status & { gameType: string }>('matchmaking:status')).toEqual({
      queued: true,
      gameType: 'macao',
      mode: 'unrated',
    });

    a.client.emit('matchmaking:leave');

    expect(await a.client.next<Status>('matchmaking:status', (s) => !s.queued)).toEqual({
      queued: false,
      reason: 'left',
    });
  });

  it('never pairs players of different modes or games', async () => {
    const a = await player('player_a');
    const b = await player('player_b');
    const c = await player('player_c');
    queue(a.client, 'competitive', 'war');
    queue(b.client, 'unrated', 'war');
    queue(c.client, 'competitive', 'macao');

    for (const p of [a, b, c]) await p.client.quiet('matchmaking:found', 400);
  });

  it('keeps players of very different strength apart until the window has widened', async () => {
    const a = await player('player_a', 1000);
    const b = await player('player_b', 1450);
    const started = Date.now();

    queue(a.client);
    queue(b.client);
    await a.client.next<Found>('matchmaking:found', () => true, 3000);

    // a 450 point gap needs 200 + 3 * 100 = 500 > 450, so at least three widenings (450 ms)
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it('removes a player from the queue when they disconnect', async () => {
    const a = await player('player_a');
    const b = await player('player_b');
    queue(a.client);
    await a.client.next('matchmaking:status');
    a.client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    queue(b.client);
    await b.client.quiet('matchmaking:found', 400);
  });

  it('allows only one queue per player and none while they sit in a room', async () => {
    const a = await player('player_a');
    queue(a.client);
    await a.client.next('matchmaking:status');
    queue(a.client, 'unrated');
    expect((await a.client.next<ErrorPayload>('error')).code).toBe('ROOM_MEMBERSHIP_CONFLICT');

    const b = await player('player_b');
    await server.roomService.createRoom(b.user.id, { gameType: 'war' });
    queue(b.client);
    expect((await b.client.next<ErrorPayload>('error')).code).toBe('ROOM_MEMBERSHIP_CONFLICT');
  });

  it('refuses a game that has no queue', async () => {
    const a = await player('player_a');
    a.client.emit('matchmaking:join', { gameType: 'poker', mode: 'competitive' } as never);
    expect((await a.client.next<ErrorPayload>('error')).code).toBe('INVALID_PAYLOAD');
  });

  it('moves Elo after a rated match, the winner being the player who did not time out', async () => {
    const a = await player('player_a');
    const b = await player('player_b');
    queue(a.client);
    queue(b.client);
    const { roomId } = await a.client.next<Found>('matchmaking:found');
    await b.client.next<Found>('matchmaking:found');
    for (const p of [a, b]) p.client.emit('room:join', { roomId });
    await a.client.next('game:state_update');

    a.client.emit('game:action', { roomId, action: { type: 'flip' } });
    const done = await b.client.next<FinishedEvent>('game:finished', () => true, 3000);

    expect(done.result.terminationReason).toBe('timeout_forfeit');
    expect(done.ratings.map((r) => r.eloChange).sort((x, y) => x - y)).toEqual([-16, 16]);
    const [record] = await server.db
      .select()
      .from(gameRecords)
      .where(eq(gameRecords.roomId, roomId));
    expect(record?.winnerId).toBe(a.user.id);
  });

  it('drops a match whose players never join, and frees them', async () => {
    const a = await player('player_a');
    const b = await player('player_b');
    queue(a.client);
    queue(b.client);
    const { roomId } = await a.client.next<Found>('matchmaking:found');

    // only a enters the room
    a.client.emit('room:join', { roomId });
    const status = await a.client.next<Status>(
      'matchmaking:status',
      (s) => s.reason === 'opponent_missing',
      4000,
    );

    expect(status.queued).toBe(false);
    expect(await server.roomService.findRoom(roomId)).toBeNull();
    // both are free to queue again
    queue(a.client);
    await a.client.next<Status>('matchmaking:status', (s) => s.queued);
  });

  it('drops a player who joined a room meanwhile and keeps the other one queued', async () => {
    const a = await player('player_a');
    const b = await player('player_b');
    const c = await player('player_c');
    queue(a.client);
    await a.client.next('matchmaking:status');
    // a takes a private room while still queued
    await server.roomService.createRoom(a.user.id, { gameType: 'war' });

    queue(b.client);

    expect(
      (await a.client.next<Status>('matchmaking:status', (s) => s.reason === 'match_failed'))
        .queued,
    ).toBe(false);
    queue(c.client);
    await b.client.next<Found>('matchmaking:found', () => true, 3000);
    await c.client.next<Found>('matchmaking:found');
  });
});
