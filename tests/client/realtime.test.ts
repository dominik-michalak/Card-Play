import type { ClientGameState } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../server/src/db/schema';
import { createApi } from '../../client/src/api';
import { connectRealtime, type RealtimeSocket } from '../../client/src/realtime';
import { signAccessToken } from '../../server/src/modules/auth/tokens';
import { resetDb } from '../helpers/db';
import { cookieFetch } from '../helpers/cookie-fetch';
import { startRealtimeServer, waitUntil } from '../helpers/realtime';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;
const sockets: RealtimeSocket[] = [];

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));

async function player(name: string) {
  const api = createApi({ baseUrl: server.url, fetchFn: cookieFetch() });
  const user = await api.register({
    username: name,
    email: `${name}@example.com`,
    password: 'correct horse',
  });
  const socket = connectRealtime(api, { url: server.url });
  sockets.push(socket);
  return { api, user, socket };
}

const once = <T>(socket: RealtimeSocket, event: string, match: (p: T) => boolean = () => true) =>
  new Promise<T>((resolve) => {
    const handler = (payload: T) => {
      if (match(payload)) {
        socket.off(event as never, handler as never);
        resolve(payload);
      }
    };
    socket.on(event as never, handler as never);
  });

describe('client realtime flow', () => {
  it('plays a War game through the same modules the UI uses', async () => {
    const host = await player('host_player');
    const guest = await player('guest_player');

    const room = await host.api.createRoom({ gameType: 'war' });
    await guest.api.joinRoom(room.inviteCode!);
    const started = [host, guest].map((p) =>
      once<{ state: ClientGameState }>(p.socket, 'game:state_update'),
    );
    for (const p of [host, guest]) {
      await waitUntil(() => p.socket.connected);
      const joined = once(p.socket, 'room:players');
      p.socket.emit('room:join', { roomId: room.id });
      await joined; // events of one socket are not ordered, so ready must wait for the join
      p.socket.emit('room:ready', { roomId: room.id, ready: true });
    }
    const [first] = await Promise.all(started);
    expect(first?.state.gameKey).toBe('war');

    const finished = once<{ result: { terminationReason: string } }>(host.socket, 'game:finished');
    host.socket.emit('game:action', { roomId: room.id, action: { type: 'flip' } });
    guest.socket.emit('game:action', { roomId: room.id, action: { type: 'flip' } });
    // both flipped, so the round resolves; leaving the table idle ends the game by timeout
    expect((await finished).result.terminationReason).toBe('double_timeout');
    expect(await host.api.currentRoom()).toBeNull();
  });

  it('does not fight back when another connection of the same user replaced it', async () => {
    const first = await player('two_tabs');
    await waitUntil(() => first.socket.connected);
    let connects = 0;
    first.socket.on('connect', () => connects++);

    const second = connectRealtime(first.api, { url: server.url });
    sockets.push(second);
    await waitUntil(() => second.connected);
    await waitUntil(() => !first.socket.connected);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // without the guard the two tabs would keep replacing each other
    expect(connects).toBe(0);
    expect(second.connected).toBe(true);
    expect(first.socket.connected).toBe(false);
  });

  it('finds an opponent through the queue and starts a game in the match room', async () => {
    const first = await player('queue_a');
    const second = await player('queue_b');
    await waitUntil(() => first.socket.connected && second.socket.connected);
    const found = [first, second].map((p) =>
      once<{ roomId: string }>(p.socket, 'matchmaking:found'),
    );

    for (const p of [first, second]) {
      p.socket.emit('matchmaking:join', { gameType: 'war', mode: 'unrated' });
    }
    const [firstFound] = await Promise.all(found);
    const roomId = firstFound!.roomId;

    // what the lobby does after "found": fetch the room, then join it
    const room = await first.api.currentRoom();
    expect(room).toMatchObject({ id: roomId, mode: 'unrated', inviteCode: null });
    const started = once<{ state: ClientGameState }>(first.socket, 'game:state_update');
    for (const p of [first, second]) p.socket.emit('room:join', { roomId });
    expect((await started).state.gameKey).toBe('war');
  });

  it('signs the app out when the server cuts the connection because of a ban', async () => {
    const { api, user, socket } = await player('soon_banned');
    await waitUntil(() => socket.connected);
    let signedOut = 0;
    api.onSessionLost(() => signedOut++);

    await server.db.update(users).set({ isBanned: true }).where(eq(users.id, user.id));
    server.banEvents.banned(user.id);

    await waitUntil(() => !socket.connected);
    await waitUntil(() => signedOut === 1);
    // and it does not keep trying to come back
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(socket.connected).toBe(false);
  });

  it('waits for connect() when autoConnect is off', async () => {
    const { api, socket: eager } = await player('lazy');
    const lazy = connectRealtime(api, { url: server.url, autoConnect: false });
    sockets.push(lazy);
    await waitUntil(() => eager.connected);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(lazy.connected).toBe(false);

    lazy.connect();

    await waitUntil(() => lazy.connected);
  });

  it('reconnects with a fresh token after the server closed the expired socket', async () => {
    const api = createApi({ baseUrl: server.url, fetchFn: cookieFetch() });
    const user = await api.register({
      username: 'short_lived',
      email: 'short@example.com',
      password: 'correct horse',
    });
    // a token that dies in 2 s replaces the real one; the refresh cookie is still valid
    api.setAccessToken(
      signAccessToken({ userId: user.id, role: 'user' }, server.config.jwtSecret, 2),
    );
    const socket = connectRealtime(api, { url: server.url });
    sockets.push(socket);
    await waitUntil(() => socket.connected);

    await waitUntil(() => !socket.connected, 4000);
    await waitUntil(() => socket.connected, 4000);

    expect(api.getAccessToken()).not.toBeNull();
  });
});
