import type { ErrorPayload } from '@cardplay/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));
afterEach(() => server.closeClients());

type Line = { roomId: string; userId: string; username: string; message: string; sentAt: string };

async function lobby() {
  const host = await seedUser(server.db, 'host_player');
  const guest = await seedUser(server.db, 'guest_player');
  const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
  await server.roomService.joinByCode(guest.id, room.inviteCode!);
  const hostClient = await server.connectAs(host.id);
  hostClient.emit('room:join', { roomId: room.id });
  await hostClient.next('room:players');
  return { host, guest, room, hostClient };
}

async function join(client: Awaited<ReturnType<typeof server.connectAs>>, roomId: string) {
  client.emit('room:join', { roomId });
  await client.next('room:players');
}

describe('room chat', () => {
  it('sends a line to everybody in the room, with the name and the time', async () => {
    const { host, guest, room, hostClient } = await lobby();
    const guestClient = await server.connectAs(guest.id);
    await join(guestClient, room.id);

    hostClient.emit('room:chat', { roomId: room.id, message: 'Hello there' });

    for (const client of [hostClient, guestClient]) {
      const line = await client.next<Line>('room:chat');
      expect(line).toMatchObject({
        roomId: room.id,
        userId: host.id,
        username: 'host_player',
        message: 'Hello there',
      });
      expect(new Date(line.sentAt).getTime()).toBeGreaterThan(Date.now() - 5000);
    }
  });

  it('cleans the text before it reaches anyone', async () => {
    const { room, hostClient } = await lobby();
    hostClient.emit('room:chat', { roomId: room.id, message: '  a‮b​c \n d  ' });
    expect((await hostClient.next<Line>('room:chat')).message).toBe('abc d');
  });

  it('refuses a line with nothing visible in it', async () => {
    const { room, hostClient } = await lobby();
    hostClient.emit('room:chat', { roomId: room.id, message: ' ​ ' });
    expect((await hostClient.next<ErrorPayload>('error')).code).toBe('INVALID_PAYLOAD');
    await hostClient.quiet('room:chat', 150);
  });

  it('refuses a line that is far too long before it is even looked at', async () => {
    const { room, hostClient } = await lobby();
    hostClient.emit('room:chat', { roomId: room.id, message: 'x'.repeat(1001) });
    expect((await hostClient.next<ErrorPayload>('error')).code).toBe('INVALID_PAYLOAD');
  });

  it('cuts a long line at 300 characters', async () => {
    const { room, hostClient } = await lobby();
    hostClient.emit('room:chat', { roomId: room.id, message: 'y'.repeat(900) });
    expect((await hostClient.next<Line>('room:chat')).message).toHaveLength(300);
  });

  it('is only for players who joined the room', async () => {
    const { room, hostClient } = await lobby();
    const stranger = await seedUser(server.db, 'stranger');
    const strangerClient = await server.connectAs(stranger.id);

    strangerClient.emit('room:chat', { roomId: room.id, message: 'let me in' });

    expect((await strangerClient.next<ErrorPayload>('error')).code).toBe('ROOM_NOT_FOUND');
    await hostClient.quiet('room:chat', 150);
  });

  it('slows down a player who writes too fast', async () => {
    const { room, hostClient } = await lobby();
    for (let i = 0; i < 7; i++)
      hostClient.emit('room:chat', { roomId: room.id, message: `line ${i}` });

    const limited = await hostClient.next<ErrorPayload>('error', (e) => e.code === 'RATE_LIMITED');
    expect(limited.code).toBe('RATE_LIMITED');
    // the five accepted lines are still being delivered
    await hostClient.next('room:chat', (l: Line) => l.message === 'line 4');
    expect(hostClient.all('room:chat')).toHaveLength(5);
  });

  it('shows the earlier lines to a player who joins later', async () => {
    const { guest, room, hostClient } = await lobby();
    hostClient.emit('room:chat', { roomId: room.id, message: 'first' });
    hostClient.emit('room:chat', { roomId: room.id, message: 'second' });
    await hostClient.next('room:chat', (l: Line) => l.message === 'second');

    const guestClient = await server.connectAs(guest.id);
    await join(guestClient, room.id);

    const lines = [
      await guestClient.next<Line>('room:chat'),
      await guestClient.next<Line>('room:chat'),
    ];
    expect(lines.map((l) => l.message)).toEqual(['first', 'second']);
  });

  it('keeps markup as plain text', async () => {
    const { room, hostClient } = await lobby();
    hostClient.emit('room:chat', { roomId: room.id, message: '<b onclick=alert(1)>hi</b>' });
    expect((await hostClient.next<Line>('room:chat')).message).toBe('<b onclick=alert(1)>hi</b>');
  });
});
