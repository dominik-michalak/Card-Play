import type { ErrorPayload, RoomPlayer } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRecords, gameRooms } from '../../../server/src/db/schema';
import { api, ORIGIN } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer, waitUntil, type TestClient } from '../../helpers/realtime';
import { signAccessToken } from '../../../server/src/modules/auth/tokens';
import { seedUser, tokenFor } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));

type PlayersEvent = { roomId: string; players: RoomPlayer[] };
type CountdownEvent = { roomId: string; startsAt: string | null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = async (roomId: string) =>
  (await server.db.select().from(gameRooms).where(eq(gameRooms.id, roomId)))[0]?.status;

// two seated players with sockets attached to the room
async function table(gameType: 'war' | 'poker' = 'war') {
  const host = await seedUser(server.db, 'host');
  const guest = await seedUser(server.db, 'guest');
  const room = await server.roomService.createRoom(host.id, { gameType });
  if (gameType === 'war') await server.roomService.joinByCode(guest.id, room.inviteCode!);
  const hostSocket = await server.connectAs(host.id);
  hostSocket.emit('room:join', { roomId: room.id });
  await hostSocket.next('room:players');
  let guestSocket: TestClient | undefined;
  if (gameType === 'war') {
    guestSocket = await server.connectAs(guest.id);
    guestSocket.emit('room:join', { roomId: room.id });
    await guestSocket.next('room:players');
  }
  return { host, guest, room, roomId: room.id, hostSocket, guestSocket: guestSocket! };
}

describe('connecting', () => {
  it.each([
    ['no token', ''],
    ['a forged token', 'not.a.jwt'],
  ])('refuses %s', async (_name, token) => {
    await expect(server.connectWithToken(token)).rejects.toThrow('UNAUTHORIZED');
  });

  it('closes the connection when the access token expires', async () => {
    const user = await seedUser(server.db, 'short_lived');
    const token = signAccessToken({ userId: user.id, role: 'user' }, server.config.jwtSecret, 2);
    const client = await server.connectWithToken(token);

    const error = await client.next<ErrorPayload>('error', () => true, 4000);

    expect(error.code).toBe('UNAUTHORIZED');
    await waitUntil(() => !client.socket.connected);
  });

  it('keeps one live connection per user, the newest', async () => {
    const user = await seedUser(server.db, 'solo');
    const first = await server.connectAs(user.id);
    const second = await server.connectAs(user.id);

    expect((await first.next<ErrorPayload>('error')).code).toBe('FORBIDDEN');
    await waitUntil(() => !first.socket.connected);
    expect(second.socket.connected).toBe(true);
  });
});

describe('room:join', () => {
  it('sends the table to a member', async () => {
    const { hostSocket, room, host } = await table();
    hostSocket.emit('room:join', { roomId: room.id });
    const event = await hostSocket.next<PlayersEvent>('room:players');
    expect(event.players.map((p) => [p.userId, p.ready])).toContainEqual([host.id, false]);
  });

  it('refuses someone who is not in the room', async () => {
    const { roomId } = await table();
    const stranger = await seedUser(server.db, 'stranger');
    const socket = await server.connectAs(stranger.id);

    socket.emit('room:join', { roomId });

    expect((await socket.next<ErrorPayload>('error')).code).toBe('ROOM_NOT_FOUND');
  });

  it('shows REST joins to the sockets in the room (one shared service)', async () => {
    const host = await seedUser(server.db, 'host');
    const guest = await seedUser(server.db, 'guest');
    const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
    const hostSocket = await server.connectAs(host.id);
    hostSocket.emit('room:join', { roomId: room.id });
    await hostSocket.next('room:players');

    const token = tokenFor(server.config, guest.id);
    const res = await api(server.url, '/api/v1/lobbies/join', {
      token,
      body: { code: room.inviteCode },
      origin: ORIGIN,
    });

    expect(res.status).toBe(200);
    const update = await hostSocket.next<PlayersEvent>(
      'room:players',
      (e) => e.players.length === 2,
    );
    expect(update.players.map((p) => p.userId)).toContain(guest.id);
  });
});

describe('room:seat and room:validation', () => {
  it('moves the player and tells the room', async () => {
    const host = await seedUser(server.db, 'host');
    const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
    const socket = await server.connectAs(host.id);
    socket.emit('room:join', { roomId: room.id });
    await socket.next('room:players');

    socket.emit('room:seat', { roomId: room.id, seatIndex: 1 });

    const update = await socket.next<PlayersEvent>('room:players');
    expect(update.players[0]?.seatIndex).toBe(1);
  });

  it.each([
    ['a seat that is not a number', 'room:seat', { seatIndex: '1' }],
    ['a ready flag that is not a boolean', 'room:ready', { ready: 'yes' }],
  ] as const)('rejects %s', async (_name, event, extra) => {
    const { hostSocket, roomId } = await table();
    hostSocket.emit(event as 'room:seat', { roomId, ...extra } as never);
    expect((await hostSocket.next<ErrorPayload>('error')).code).toBe('INVALID_PAYLOAD');
  });

  it('rejects a room id that is not a uuid', async () => {
    const { hostSocket } = await table();
    hostSocket.emit('room:join', { roomId: 'nope' });
    expect((await hostSocket.next<ErrorPayload>('error')).code).toBe('INVALID_PAYLOAD');
  });

  it('slows down a client that floods events', async () => {
    const { hostSocket } = await table();
    for (let i = 0; i < 60; i++) hostSocket.emit('room:join', { roomId: 'nope' });
    const limited = await hostSocket.next<ErrorPayload>('error', (e) => e.code === 'RATE_LIMITED');
    expect(limited.code).toBe('RATE_LIMITED');
  });
});

describe('ready and the start countdown', () => {
  it('needs the player to be in the room first', async () => {
    const host = await seedUser(server.db, 'host');
    const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
    const socket = await server.connectAs(host.id);

    socket.emit('room:ready', { roomId: room.id, ready: true });

    expect((await socket.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });

  it('answers GAME_RULES_NOT_DEFINED for Texas Clinch and never starts a countdown', async () => {
    const host = await seedUser(server.db, 'host');
    const guest = await seedUser(server.db, 'guest');
    const room = await server.roomService.createRoom(host.id, { gameType: 'texas_clinch' });
    await server.roomService.joinByCode(guest.id, room.inviteCode!);
    const socket = await server.connectAs(host.id);
    socket.emit('room:join', { roomId: room.id });
    await socket.next('room:players');

    socket.emit('room:ready', { roomId: room.id, ready: true });

    expect((await socket.next<ErrorPayload>('error')).code).toBe('GAME_RULES_NOT_DEFINED');
    await socket.quiet('room:countdown', 250);
  });

  it('starts the game after the countdown once the table is full and ready', async () => {
    const { hostSocket, guestSocket, roomId } = await table();

    hostSocket.emit('room:ready', { roomId, ready: true });
    const half = await hostSocket.next<PlayersEvent>('room:players', (e) =>
      e.players.some((p) => p.ready),
    );
    expect(half.players.filter((p) => p.ready)).toHaveLength(1);
    guestSocket.emit('room:ready', { roomId, ready: true });

    const countdown = await hostSocket.next<CountdownEvent>('room:countdown');
    expect(new Date(countdown.startsAt!).getTime()).toBeGreaterThan(Date.now() - 20);
    for (const socket of [hostSocket, guestSocket]) {
      const update = await socket.next<{
        state: { gameKey: string; turnDeadlineAt: string | null };
      }>('game:state_update');
      expect(update.state.gameKey).toBe('war');
      expect(update.state.turnDeadlineAt).not.toBeNull();
    }
    expect(await statusOf(roomId)).toBe('in_progress');
    expect(await server.db.select().from(gameRecords)).toHaveLength(1);
  });

  it('is cancelled when a player takes the ready flag back', async () => {
    const { hostSocket, guestSocket, roomId } = await table();
    hostSocket.emit('room:ready', { roomId, ready: true });
    guestSocket.emit('room:ready', { roomId, ready: true });
    await hostSocket.next<CountdownEvent>('room:countdown', (e) => e.startsAt !== null);

    guestSocket.emit('room:ready', { roomId, ready: false });

    await hostSocket.next<CountdownEvent>('room:countdown', (e) => e.startsAt === null);
    await hostSocket.quiet('game:state_update', 250);
    expect(await statusOf(roomId)).toBe('waiting');
  });

  it('is cancelled when a player leaves, and the room shrinks', async () => {
    const { hostSocket, guestSocket, roomId } = await table();
    hostSocket.emit('room:ready', { roomId, ready: true });
    guestSocket.emit('room:ready', { roomId, ready: true });
    await hostSocket.next<CountdownEvent>('room:countdown', (e) => e.startsAt !== null);

    guestSocket.emit('room:leave', { roomId });

    await hostSocket.next<CountdownEvent>('room:countdown', (e) => e.startsAt === null);
    const update = await hostSocket.next<PlayersEvent>(
      'room:players',
      (e) => e.players.length === 1,
    );
    expect(update.players[0]?.ready).toBe(true);
    await hostSocket.quiet('game:state_update', 250);
    expect(await statusOf(roomId)).toBe('waiting');
  });
});

describe('room:leave and dropped connections', () => {
  it('deletes the room when the last player leaves', async () => {
    const host = await seedUser(server.db, 'host');
    const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
    const socket = await server.connectAs(host.id);
    socket.emit('room:join', { roomId: room.id });
    await socket.next('room:players');

    socket.emit('room:leave', { roomId: room.id });

    await waitUntil(async () => (await server.roomService.findRoom(room.id)) === null);
  });

  it('clears the ready flag at once and frees the seat after the grace period', async () => {
    const { hostSocket, guestSocket, roomId, guest } = await table();
    guestSocket.emit('room:ready', { roomId, ready: true });
    await hostSocket.next<PlayersEvent>('room:players', (e) => e.players.some((p) => p.ready));

    guestSocket.close();

    const cleared = await hostSocket.next<PlayersEvent>('room:players', (e) =>
      e.players.every((p) => !p.ready),
    );
    expect(cleared.players).toHaveLength(2);
    const gone = await hostSocket.next<PlayersEvent>('room:players', (e) => e.players.length === 1);
    expect(gone.players.map((p) => p.userId)).not.toContain(guest.id);
  });

  it('keeps the seat of a player who is back within the grace period', async () => {
    const { guestSocket, roomId, guest } = await table();
    guestSocket.close();
    await sleep(100);

    const again = await server.connectAs(guest.id);
    again.emit('room:join', { roomId });
    await again.next('room:players');
    await sleep(500);

    expect((await server.roomService.findRoom(roomId))?.players).toHaveLength(2);
  });
});
