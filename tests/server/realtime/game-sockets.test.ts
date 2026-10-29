import type { ClientGameState, ErrorPayload, GameResult, RatingChange } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRecords, gameRooms } from '../../../server/src/db/schema';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer, type TestClient } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));

type StateEvent = { roomId: string; state: ClientGameState };
type FinishedEvent = { roomId: string; result: GameResult; ratings: RatingChange[] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roomStatus = async (roomId: string) =>
  (await server.db.select().from(gameRooms).where(eq(gameRooms.id, roomId)))[0]?.status;
const flip = (client: TestClient, roomId: string) =>
  client.emit('game:action', { roomId, action: { type: 'flip' } });

// a running private War game between two connected players
async function runningGame() {
  const host = await seedUser(server.db, 'host');
  const guest = await seedUser(server.db, 'guest');
  const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
  await server.roomService.joinByCode(guest.id, room.inviteCode!);
  const a = await server.connectAs(host.id);
  const b = await server.connectAs(guest.id);
  for (const socket of [a, b]) {
    socket.emit('room:join', { roomId: room.id });
    await socket.next('room:players');
    socket.emit('room:ready', { roomId: room.id, ready: true });
  }
  const first = await a.next<StateEvent>('game:state_update');
  await b.next<StateEvent>('game:state_update');
  return { host, guest, roomId: room.id, a, b, first };
}

describe('playing a round', () => {
  it('resolves a round when both flip and opens a fresh window', async () => {
    const { a, b, roomId, first } = await runningGame();

    flip(a, roomId);
    flip(b, roomId);

    const event = await a.next<{ event: { type: string } }>(
      'game:event',
      (e) => e.event.type === 'round_resolved',
    );
    expect(event.event.type).toBe('round_resolved');
    const after = await a.next<StateEvent>(
      'game:state_update',
      (e) => (e.state as { round?: number }).round === 1,
    );
    expect(new Date(after.state.turnDeadlineAt!).getTime()).toBeGreaterThan(
      new Date(first.state.turnDeadlineAt!).getTime(),
    );
    await b.next<StateEvent>(
      'game:state_update',
      (e) => (e.state as { round?: number }).round === 1,
    );
  });

  it('refuses a second flip in the same round', async () => {
    const { a, roomId } = await runningGame();
    flip(a, roomId);
    flip(a, roomId);
    expect((await a.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });

  it('refuses an action type the game does not know', async () => {
    const { a, roomId } = await runningGame();
    a.emit('game:action', { roomId, action: { type: 'cheat' } });
    expect((await a.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });

  it('refuses actions from a socket that is not in the room', async () => {
    const { roomId } = await runningGame();
    const outsider = await seedUser(server.db, 'outsider');
    const socket = await server.connectAs(outsider.id);
    flip(socket, roomId);
    expect((await socket.next<ErrorPayload>('error')).code).toBe('ROOM_NOT_FOUND');
  });
});

describe('the decision window', () => {
  it('ends in a double timeout when nobody flips', async () => {
    const { a, roomId } = await runningGame();

    const done = await a.next<FinishedEvent>('game:finished');

    expect(done.result.terminationReason).toBe('double_timeout');
    expect(done.ratings).toEqual([]);
    expect(await roomStatus(roomId)).toBe('finished');
  });

  it('makes the player who did not flip lose by timeout', async () => {
    const { a, b, roomId, host } = await runningGame();

    flip(a, roomId);
    const done = await b.next<FinishedEvent>('game:finished');

    expect(done.result.terminationReason).toBe('timeout_forfeit');
    expect(done.result.placements.find((p) => p.rank === 1)?.playerId).toBe(host.id);
    const [record] = await server.db.select().from(gameRecords);
    expect(record).toMatchObject({ terminationReason: 'timeout_forfeit', winnerId: host.id });
  });

  it('frees the players for a new room once the game is over', async () => {
    const { a, host } = await runningGame();
    await a.next('game:finished');
    await expect(
      server.roomService.createRoom(host.id, { gameType: 'war' }),
    ).resolves.toBeDefined();
  });
});

describe('disconnects', () => {
  it('pauses the game and stops the counter while a player is away', async () => {
    const { a, b, roomId } = await runningGame();

    b.close();

    const paused = await a.next<StateEvent>(
      'game:state_update',
      (e) => e.state.turnDeadlineAt === null,
    );
    expect(paused.roomId).toBe(roomId);
    flip(a, roomId);
    expect((await a.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });

  it('resumes with a full window when the player comes back in time', async () => {
    const { a, guest, roomId } = await runningGame();
    const gone = (await server.connectAs(guest.id)).socket; // replaces the old socket
    gone.close();
    await a.next<StateEvent>('game:state_update', (e) => e.state.turnDeadlineAt === null);

    const back = await server.connectAs(guest.id);
    back.emit('room:join', { roomId });

    const resumed = await a.next<StateEvent>(
      'game:state_update',
      (e) => e.state.turnDeadlineAt !== null,
    );
    expect(new Date(resumed.state.turnDeadlineAt!).getTime()).toBeGreaterThan(Date.now());
    await back.next<StateEvent>('game:state_update', (e) => e.state.turnDeadlineAt !== null);
  });

  it('treats a replaced connection as a drop followed by a return', async () => {
    const { a, guest, roomId } = await runningGame();

    const replacement = await server.connectAs(guest.id);
    await a.next<StateEvent>('game:state_update', (e) => e.state.turnDeadlineAt === null);
    replacement.emit('room:join', { roomId });

    await a.next<StateEvent>('game:state_update', (e) => e.state.turnDeadlineAt !== null);
  });

  it('forfeits the player who stays away for too long', async () => {
    const { a, b, roomId, host } = await runningGame();

    b.close();
    const done = await a.next<FinishedEvent>('game:finished');

    expect(done.result.terminationReason).toBe('disconnect_forfeit');
    expect(done.result.placements.find((p) => p.rank === 1)?.playerId).toBe(host.id);
    expect(await roomStatus(roomId)).toBe('finished');
  });

  it('cancels the game when everybody is gone', async () => {
    const { a, b, roomId } = await runningGame();

    a.close();
    b.close();
    await sleep(700);

    const [record] = await server.db.select().from(gameRecords);
    expect(record).toMatchObject({ terminationReason: 'cancelled', winnerId: null });
    expect(await roomStatus(roomId)).toBe('finished');
  });
});
