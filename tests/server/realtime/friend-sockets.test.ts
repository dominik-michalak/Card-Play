import type { ErrorPayload, GameKey } from '@cardplay/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer, waitUntil } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));
afterEach(() => server.closeClients());

type Invited = { fromUserId: string; fromUsername: string; gameType: GameKey; inviteCode: string };

// two friends, the first holding a private room with a free seat
async function friendsWithRoom(options: { online?: boolean; befriended?: boolean } = {}) {
  const { online = true, befriended = true } = options;
  const host = await seedUser(server.db, 'host_player');
  const friend = await seedUser(server.db, 'friend_player');
  if (befriended) {
    await server.friendsService.invite(host.id, friend.username);
    await server.friendsService.accept(friend.id, host.id);
  }
  const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
  const hostClient = await server.connectAs(host.id);
  const friendClient = online ? await server.connectAs(friend.id) : null;
  return { host, friend, room, hostClient, friendClient };
}

describe('friend:invite', () => {
  it('shows the invitation to an online friend, who can join with the code', async () => {
    const { host, friend, room, hostClient, friendClient } = await friendsWithRoom();

    hostClient.emit('friend:invite', { userId: friend.id, roomId: room.id });

    const invited = await friendClient!.next<Invited>('friend:invited');
    expect(invited).toEqual({
      fromUserId: host.id,
      fromUsername: 'host_player',
      gameType: 'war',
      inviteCode: room.inviteCode,
    });
    const joined = await server.roomService.joinByCode(friend.id, invited.inviteCode);
    expect(joined.players).toHaveLength(2);
  });

  it('refuses someone who is not a friend', async () => {
    const { friend, room, hostClient, friendClient } = await friendsWithRoom({ befriended: false });
    hostClient.emit('friend:invite', { userId: friend.id, roomId: room.id });
    expect((await hostClient.next<ErrorPayload>('error')).code).toBe('FORBIDDEN');
    await friendClient!.quiet('friend:invited', 250);
  });

  it('refuses a friend who is offline', async () => {
    const { friend, room, hostClient } = await friendsWithRoom({ online: false });
    hostClient.emit('friend:invite', { userId: friend.id, roomId: room.id });
    const error = await hostClient.next<ErrorPayload>('error');
    expect(error).toMatchObject({ code: 'INVALID_ACTION' });
    expect(error.message).toContain('offline');
  });

  it('refuses a room of someone else, a bot room and a full room', async () => {
    const { host, friend, room, hostClient, friendClient } = await friendsWithRoom();

    // the friend's own room is not the host's to share
    friendClient!.emit('friend:invite', { userId: host.id, roomId: room.id });
    expect((await friendClient!.next<ErrorPayload>('error')).code).toBe('ROOM_NOT_FOUND');

    // a full room has nothing to offer
    await server.roomService.joinByCode(friend.id, room.inviteCode!);
    hostClient.emit('friend:invite', { userId: friend.id, roomId: room.id });
    expect((await hostClient.next<ErrorPayload>('error')).code).toBe('ROOM_FULL');
  });

  it('refuses a room that is not a private waiting room', async () => {
    const host = await seedUser(server.db, 'host_player');
    const friend = await seedUser(server.db, 'friend_player');
    await server.friendsService.invite(host.id, friend.username);
    await server.friendsService.accept(friend.id, host.id);
    const room = await server.roomService.createRoom(host.id, { gameType: 'war', mode: 'bot' });
    const hostClient = await server.connectAs(host.id);
    await server.connectAs(friend.id);

    hostClient.emit('friend:invite', { userId: friend.id, roomId: room.id });

    expect((await hostClient.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });

  it('rejects a malformed payload', async () => {
    const { hostClient } = await friendsWithRoom();
    hostClient.emit('friend:invite', { userId: 'nope', roomId: 'nope' });
    expect((await hostClient.next<ErrorPayload>('error')).code).toBe('INVALID_PAYLOAD');
  });
});

describe('presence through sockets', () => {
  it('is online while a socket is open and offline after it closes', async () => {
    const user = await seedUser(server.db, 'someone');
    expect(server.presence.isOnline(user.id)).toBe(false);

    const client = await server.connectAs(user.id);
    expect(server.presence.isOnline(user.id)).toBe(true);

    client.close();
    await waitUntil(() => !server.presence.isOnline(user.id));
  });

  it('stays online when a second connection replaces the first', async () => {
    const user = await seedUser(server.db, 'someone');
    const first = await server.connectAs(user.id);
    await server.connectAs(user.id);
    await waitUntil(() => !first.socket.connected);

    expect(server.presence.isOnline(user.id)).toBe(true);
  });
});
