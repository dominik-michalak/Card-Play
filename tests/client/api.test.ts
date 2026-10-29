import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../server/src/db/schema';
import { ApiError, createApi } from '../../client/src/api';
import { resetDb } from '../helpers/db';
import { cookieFetch } from '../helpers/cookie-fetch';
import { startRealtimeServer } from '../helpers/realtime';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));

const newApi = () => createApi({ baseUrl: server.url, fetchFn: cookieFetch() });
const alice = { username: 'alice', email: 'alice@example.com', password: 'correct horse' };

describe('session', () => {
  it('keeps the access token in memory after login and registration', async () => {
    const api = newApi();
    expect(api.getAccessToken()).toBeNull();

    const user = await api.register(alice);

    expect(user).toMatchObject({ username: 'alice', role: 'user' });
    expect(api.getAccessToken()).toEqual(expect.any(String));
  });

  it('reports the server error code of a failed login', async () => {
    const api = newApi();
    await expect(api.login({ email: alice.email, password: 'wrong' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(api.getAccessToken()).toBeNull();
  });

  it('restores the session from the refresh cookie, as after a page reload', async () => {
    const fetchFn = cookieFetch();
    await createApi({ baseUrl: server.url, fetchFn }).register(alice);

    const reloaded = createApi({ baseUrl: server.url, fetchFn });
    const user = await reloaded.restoreSession();

    expect(user?.username).toBe('alice');
    expect(reloaded.getAccessToken()).toEqual(expect.any(String));
  });

  it('has no session without a cookie', async () => {
    expect(await newApi().restoreSession()).toBeNull();
  });

  it('forgets the session on logout', async () => {
    const fetchFn = cookieFetch();
    const api = createApi({ baseUrl: server.url, fetchFn });
    await api.register(alice);

    await api.logout();

    expect(api.getAccessToken()).toBeNull();
    expect(await createApi({ baseUrl: server.url, fetchFn }).restoreSession()).toBeNull();
  });
});

describe('requests with an expired access token', () => {
  it('refreshes once and repeats the request', async () => {
    const api = newApi();
    await api.register(alice);
    api.setAccessToken('expired.or.forged');

    expect(await api.currentRoom()).toBeNull();
    expect(api.getAccessToken()).not.toBe('expired.or.forged');
  });

  it('shares one refresh between parallel requests', async () => {
    const api = newApi();
    await api.register(alice);
    api.setAccessToken('expired.or.forged');

    const results = await Promise.all([api.currentRoom(), api.currentRoom(), api.currentRoom()]);

    expect(results).toEqual([null, null, null]);
  });

  it('tells the app when the session cannot be saved', async () => {
    const api = newApi();
    api.setAccessToken('expired.or.forged');
    let lost = 0;
    api.onSessionLost(() => lost++);

    await expect(api.currentRoom()).rejects.toBeInstanceOf(ApiError);

    expect(lost).toBe(1);
  });
});

describe('profile, ranking and friends', () => {
  const bob = { username: 'bob', email: 'bob@example.com', password: 'correct horse' };

  it('reads a profile and the history of games, by name and as "me"', async () => {
    const api = newApi();
    await api.register(alice);

    expect(await api.profile('me')).toMatchObject({ username: 'alice', totals: { played: 0 } });
    expect((await api.profile('ALICE')).username).toBe('alice');
    expect(await api.history('me', { limit: 5, offset: 0 })).toEqual({ total: 0, items: [] });
    await expect(api.profile('nobody_here')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads a leaderboard page', async () => {
    const api = newApi();
    await api.register(alice);
    expect(await api.leaderboard('war', { limit: 10 })).toEqual({ total: 0, items: [] });
  });

  it('walks through inviting, accepting, listing and removing a friend', async () => {
    const [first, second] = [newApi(), newApi()];
    const firstUser = await first.register(alice);
    const secondUser = await second.register(bob);

    expect(await first.inviteFriend('BOB')).toMatchObject({ status: 'pending' });
    expect((await second.friends()).incoming).toMatchObject([{ userId: firstUser.id }]);

    await second.acceptFriend(firstUser.id);
    expect((await first.friends()).friends).toMatchObject([
      { userId: secondUser.id, online: false },
    ]);

    await first.removeFriend(secondUser.id);
    expect((await first.friends()).friends).toEqual([]);
  });

  it('withdraws an invitation', async () => {
    const [first, second] = [newApi(), newApi()];
    await first.register(alice);
    const secondUser = await second.register(bob);
    await first.inviteFriend('bob');

    await first.declineFriend(secondUser.id);

    expect((await first.friends()).outgoing).toEqual([]);
  });
});

describe('moderation through the client', () => {
  const staffUser = async (role: 'moderator' | 'admin') => {
    const api = newApi();
    const user = await api.register({
      username: `staff_${role}`,
      email: `${role}@example.com`,
      password: 'correct horse',
    });
    await server.db.update(users).set({ role }).where(eq(users.id, user.id));
    return { api, user };
  };

  it('lets a moderator find, ban and unban a user, and handle a ticket', async () => {
    const [{ api: mod }, target] = [await staffUser('moderator'), newApi()];
    const targetUser = await target.register(alice);
    const ticket = await target.createTicket({ subject: 'Help', body: 'please' });

    expect((await mod.manageUsers({ search: 'ALI' })).items).toMatchObject([{ username: 'alice' }]);
    expect(await mod.banUser(targetUser.id, { durationHours: 2, reason: 'spam' })).toMatchObject({
      ban: { active: true },
    });
    expect((await mod.manageUsers({ banned: true })).total).toBe(1);
    expect((await mod.managedUser(targetUser.id)).bans).toHaveLength(1);
    await mod.unbanUser(targetUser.id);
    expect((await mod.manageUsers({ banned: true })).total).toBe(0);

    expect((await mod.staffTickets({ status: 'open' })).total).toBe(1);
    expect((await mod.staffReply(ticket.id, 'looking')).status).toBe('in_progress');
    expect((await mod.staffSetStatus(ticket.id, 'resolved')).status).toBe('resolved');
    expect((await mod.staffTicket(ticket.id)).replies).toHaveLength(1);
  });

  it('lets an admin change a role and read the audit log, and shuts the door on a moderator', async () => {
    const [{ api: admin }, { api: mod }, target] = [
      await staffUser('admin'),
      await staffUser('moderator'),
      newApi(),
    ];
    const targetUser = await target.register(alice);

    expect((await admin.setUserRole(targetUser.id, 'moderator')).role).toBe('moderator');
    expect((await admin.auditLog()).items[0]).toMatchObject({ action: 'role_change' });
    await expect(mod.auditLog()).rejects.toMatchObject({ status: 403 });
    await expect(mod.setUserRole(targetUser.id, 'user')).rejects.toMatchObject({ status: 403 });
  });
});

describe('a banned account', () => {
  it('is told so, and the app is told to sign out', async () => {
    const api = newApi();
    const user = await api.register(alice);
    let signedOut = 0;
    api.onSessionLost(() => signedOut++);

    await server.db.update(users).set({ isBanned: true }).where(eq(users.id, user.id));

    await expect(api.tickets()).rejects.toMatchObject({
      status: 403,
      message: 'account is banned',
    });
    expect(signedOut).toBe(1);
  });
});

describe('tickets', () => {
  it('creates a ticket, reads it back, replies and lists it', async () => {
    const api = newApi();
    await api.register(alice);

    const created = await api.createTicket({ subject: 'Help', body: 'Something broke' });
    expect(created).toMatchObject({ subject: 'Help', status: 'open', replies: [] });

    const updated = await api.replyToTicket(created.id, 'More detail');
    expect(updated.replies).toMatchObject([{ body: 'More detail', isStaff: false }]);
    expect((await api.ticket(created.id)).replies).toHaveLength(1);
    expect(await api.tickets({ limit: 5 })).toMatchObject({ total: 1 });
  });

  it('exposes the server error for a ticket that is not yours', async () => {
    const [first, second] = [newApi(), newApi()];
    await first.register(alice);
    await second.register({ username: 'bob', email: 'bob@example.com', password: 'correct horse' });
    const created = await first.createTicket({ subject: 'Mine', body: 'private' });

    await expect(second.ticket(created.id)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('rooms', () => {
  it('creates, finds, joins and leaves a room', async () => {
    const host = newApi();
    const guest = newApi();
    await host.register(alice);
    await guest.register({ ...alice, username: 'bob', email: 'bob@example.com' });

    const room = await host.createRoom({ gameType: 'war' });
    expect((await host.currentRoom())?.id).toBe(room.id);
    const joined = await guest.joinRoom(room.inviteCode!);
    expect(joined.players).toHaveLength(2);

    await guest.leaveRoom(room.id);
    expect(await guest.currentRoom()).toBeNull();
    expect((await host.currentRoom())?.players).toHaveLength(1);
  });

  it('creates a bot room that needs no invite code', async () => {
    const api = newApi();
    await api.register(alice);

    const room = await api.createRoom({ gameType: 'macao', mode: 'bot' });

    expect(room).toMatchObject({ mode: 'bot', inviteCode: null, targetPlayers: 2 });
    expect((await api.currentRoom())?.id).toBe(room.id);
  });

  it('exposes the server error of a full room', async () => {
    const [a, b, c] = [newApi(), newApi(), newApi()];
    await a.register(alice);
    await b.register({ ...alice, username: 'bob', email: 'bob@example.com' });
    await c.register({ ...alice, username: 'carol', email: 'carol@example.com' });
    const room = await a.createRoom({ gameType: 'war' });
    await b.joinRoom(room.inviteCode!);

    await expect(c.joinRoom(room.inviteCode!)).rejects.toMatchObject({ code: 'ROOM_FULL' });
  });
});
