import type { ErrorPayload } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../../server/src/db/schema';
import { api } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer, waitUntil } from '../../helpers/realtime';
import { seedUser, tokenFor } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));
afterEach(() => server.closeClients());

async function moderator() {
  const user = await seedUser(server.db, 'moderator_one');
  await server.db.update(users).set({ role: 'moderator' }).where(eq(users.id, user.id));
  return tokenFor(server.config, user.id);
}

describe('bans and sockets', () => {
  it('refuses a banned user at the handshake, even with a valid token', async () => {
    const user = await seedUser(server.db, 'banned_one');
    await server.db.update(users).set({ isBanned: true }).where(eq(users.id, user.id));
    await expect(server.connectAs(user.id)).rejects.toThrow('FORBIDDEN');
  });

  it('refuses a token of an account that no longer exists', async () => {
    const user = await seedUser(server.db, 'gone_soon');
    const token = tokenFor(server.config, user.id);
    await server.db.delete(users).where(eq(users.id, user.id));
    await expect(server.connectWithToken(token)).rejects.toThrow('UNAUTHORIZED');
  });

  it('lets a temporary ban that has run out connect again', async () => {
    const user = await seedUser(server.db, 'back_again');
    await server.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, user.id));
    expect((await server.connectAs(user.id)).socket.connected).toBe(true);
  });

  it('cuts the live connection of a user who is banned', async () => {
    const target = await seedUser(server.db, 'target_one');
    const client = await server.connectAs(target.id);
    const token = await moderator();

    const res = await api(server.url, `/api/v1/moderation/users/${target.id}/ban`, {
      token,
      body: { durationHours: 1, reason: 'spam' },
    });

    expect(res.status).toBe(201);
    const error = await client.next<ErrorPayload>('error');
    expect(error).toEqual({ code: 'FORBIDDEN', message: 'account is banned' });
    await waitUntil(() => !client.socket.connected);
    await expect(server.connectAs(target.id)).rejects.toThrow('FORBIDDEN');
  });

  it('refuses every event of a socket whose owner was banned behind its back', async () => {
    // the ban reaches the database without the live notice (for example from another process)
    const target = await seedUser(server.db, 'target_two');
    const client = await server.connectAs(target.id);
    await server.db.update(users).set({ isBanned: true }).where(eq(users.id, target.id));

    client.emit('room:join', { roomId: '00000000-0000-4000-8000-000000000000' });

    const error = await client.next<ErrorPayload>('error');
    expect(error).toEqual({ code: 'FORBIDDEN', message: 'account is banned' });
  });

  it('takes a banned player out of the matchmaking queue', async () => {
    const target = await seedUser(server.db, 'queued_one');
    const client = await server.connectAs(target.id);
    client.emit('matchmaking:join', { gameType: 'war', mode: 'unrated' });
    await client.next('matchmaking:status');

    await api(server.url, `/api/v1/moderation/users/${target.id}/ban`, {
      token: await moderator(),
      body: { durationHours: 1, reason: 'spam' },
    });

    await waitUntil(() => !client.socket.connected);
    const other = await seedUser(server.db, 'queued_two');
    const otherClient = await server.connectAs(other.id);
    otherClient.emit('matchmaking:join', { gameType: 'war', mode: 'unrated' });
    await otherClient.quiet('matchmaking:found', 300);
  });
});
