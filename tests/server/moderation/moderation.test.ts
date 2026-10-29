import type { UserRole } from '@cardplay/shared';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bans, moderationActions, refreshTokens, users } from '../../../server/src/db/schema';
import { signAccessToken } from '../../../server/src/modules/auth/tokens';
import { api, cookieValue, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

async function newUser(name: string, role: UserRole = 'user') {
  const user = await seedUser(app.db, name);
  if (role !== 'user') await app.db.update(users).set({ role }).where(eq(users.id, user.id));
  return { ...user, token: signAccessToken({ userId: user.id, role }, app.config.jwtSecret, 600) };
}

type Actor = Awaited<ReturnType<typeof newUser>>;
const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
  api(app.url, `/api/v1${path}`, {
    method,
    token,
    body,
    origin: method === 'GET' ? null : undefined,
  });
const ban = (actor: Actor, target: { id: string }, body: unknown) =>
  call(actor.token, 'POST', `/moderation/users/${target.id}/ban`, body);
const unban = (actor: Actor, target: { id: string }) =>
  call(actor.token, 'DELETE', `/moderation/users/${target.id}/ban`);
const hours = (n: number) => ({ durationHours: n, reason: 'spam' });

describe('who may use the moderation API', () => {
  it('needs a signed-in staff member', async () => {
    const [user, mod, admin, target] = [
      await newUser('plain'),
      await newUser('mod', 'moderator'),
      await newUser('boss', 'admin'),
      await newUser('target'),
    ];
    const moderationRoutes: [string, string, unknown?][] = [
      ['GET', '/moderation/users'],
      ['GET', `/moderation/users/${target.id}`],
      ['POST', `/moderation/users/${target.id}/ban`, hours(1)],
      ['DELETE', `/moderation/users/${target.id}/ban`],
    ];
    const adminRoutes: [string, string, unknown?][] = [
      ['PATCH', `/admin/users/${target.id}/role`, { role: 'moderator' }],
      ['GET', '/admin/audit'],
    ];

    for (const [method, path, body] of [...moderationRoutes, ...adminRoutes]) {
      expect((await call(undefined, method, path, body)).status).toBe(401);
      expect((await call(user.token, method, path, body)).status).toBe(403);
    }
    for (const [method, path, body] of adminRoutes) {
      expect((await call(mod.token, method, path, body)).status).toBe(403);
    }
    expect((await call(mod.token, 'GET', '/moderation/users')).status).toBe(200);
    expect((await call(admin.token, 'GET', '/admin/audit')).status).toBe(200);
  });

  it('reads the role from the database, not from the token', async () => {
    const mallory = await seedUser(app.db, 'mallory');
    const forged = signAccessToken(
      { userId: mallory.id, role: 'admin' },
      app.config.jwtSecret,
      600,
    );
    expect((await call(forged, 'GET', '/moderation/users')).status).toBe(403);
    expect((await call(forged, 'GET', '/admin/audit')).status).toBe(403);
  });
});

describe('finding users', () => {
  it('searches by user name, in any case, and shows no e-mail addresses', async () => {
    const mod = await newUser('mod', 'moderator');
    await newUser('Alice_One');
    await newUser('alice_two');
    await newUser('bobby');

    const res = await call(mod.token, 'GET', '/moderation/users?search=ALICE');

    expect(res.body?.total).toBe(2);
    expect(res.body?.items.map((u: { username: string }) => u.username).sort()).toEqual([
      'Alice_One',
      'alice_two',
    ]);
    expect(res.body?.items[0]).toMatchObject({ role: 'user', ban: { active: false } });
    expect(JSON.stringify(res.body)).not.toMatch(/email|example\.com/);
  });

  it('treats % and _ as ordinary characters', async () => {
    const mod = await newUser('mod', 'moderator');
    await newUser('a_c');
    await newUser('abc');
    expect((await call(mod.token, 'GET', '/moderation/users?search=a_c')).body?.total).toBe(1);
    expect((await call(mod.token, 'GET', '/moderation/users?search=%25')).body?.total).toBe(0);
  });

  it('lists only banned users on request and pages with at most 100 rows', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    await newUser('innocent');
    await ban(mod, target, hours(5));

    const banned = await call(mod.token, 'GET', '/moderation/users?status=banned');
    expect(banned.body?.items.map((u: { username: string }) => u.username)).toEqual(['target']);
    expect((await call(mod.token, 'GET', '/moderation/users?limit=101')).status).toBe(400);
    expect((await call(mod.token, 'GET', '/moderation/users?status=odd')).status).toBe(400);
    expect((await call(mod.token, 'GET', '/moderation/users?limit=1')).body?.items).toHaveLength(1);
  });

  it('shows the ban history of a user', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    await ban(mod, target, { durationHours: 2, reason: 'rude in chat' });
    await unban(mod, target);

    const { body } = await call(mod.token, 'GET', `/moderation/users/${target.id}`);

    expect(body).toMatchObject({ username: 'target', ban: { active: false } });
    expect(body?.bans).toMatchObject([
      { reason: 'rude in chat', permanent: false, imposedBy: 'mod', revokedBy: 'mod' },
    ]);
    expect(
      (
        await call(
          mod.token,
          'GET',
          `/moderation/users/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
        )
      ).status,
    ).toBe(404);
    expect((await call(mod.token, 'GET', '/moderation/users/nope')).status).toBe(400);
  });
});

describe('banning', () => {
  it('gives a temporary ban at once: the API refuses the user from the next request', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    expect((await call(target.token, 'GET', '/tickets')).status).toBe(200);

    const res = await ban(mod, target, hours(24));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'target', ban: { active: true, permanent: false } });
    const until = new Date(res.body?.ban.until).getTime();
    expect(until).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(until).toBeLessThan(Date.now() + 25 * 3600_000);

    const refused = await call(target.token, 'GET', '/tickets');
    expect(refused.status).toBe(403);
    expect(refused.body?.error.message).toContain('banned');
    expect((await call(target.token, 'GET', '/leaderboard/war')).status).toBe(403);
  });

  it('ends the sessions of the banned user and refuses their login', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    const login = await api(app.url, '/api/v1/auth/register', {
      body: { username: 'victim', email: 'victim@example.com', password: 'correct horse' },
    });
    const victimId = login.body!.user.id as string;
    const cookie = `refresh_token=${cookieValue(login.setCookie, 'refresh_token')}`;

    await ban(mod, { id: victimId }, hours(1));

    const refresh = await api(app.url, '/api/v1/auth/refresh', { cookie });
    // the refresh tokens were revoked with the ban
    expect(refresh.status).toBe(401);
    expect(
      (await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, victimId))).every(
        (t) => t.revokedAt,
      ),
    ).toBe(true);
    const again = await api(app.url, '/api/v1/auth/login', {
      body: { email: 'victim@example.com', password: 'correct horse' },
    });
    expect(again.status).toBe(403);
    void target;
  });

  it('tells the live sockets about the ban', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    const heard: string[] = [];
    app.banEvents.onBanned((userId) => heard.push(userId));
    await ban(mod, target, hours(1));
    expect(heard).toEqual([target.id]);
  });

  it('lets a ban expire by itself', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    await ban(mod, target, hours(1));
    await app.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, target.id));

    expect((await call(target.token, 'GET', '/tickets')).status).toBe(200);
    const detail = (await call(mod.token, 'GET', `/moderation/users/${target.id}`)).body;
    expect(detail?.ban.active).toBe(false);
  });

  it('gives permanent bans to admins only', async () => {
    const [mod, admin, target] = [
      await newUser('mod', 'moderator'),
      await newUser('boss', 'admin'),
      await newUser('target'),
    ];
    const body = { permanent: true, reason: 'cheating' };

    expect((await ban(mod, target, body)).status).toBe(403);
    const res = await ban(admin, target, body);
    expect(res.status).toBe(201);
    expect(res.body?.ban).toMatchObject({ active: true, permanent: true, until: null });
    expect((await call(target.token, 'GET', '/tickets')).status).toBe(403);
  });

  it.each([
    ['no duration and not permanent', { reason: 'x' }],
    ['a zero duration', { durationHours: 0, reason: 'x' }],
    ['a fractional duration', { durationHours: 1.5, reason: 'x' }],
    ['a duration and permanent together', { durationHours: 5, permanent: true, reason: 'x' }],
    ['a moderator limit of 30 days exceeded', { durationHours: 721, reason: 'x' }],
    ['no reason', { durationHours: 5 }],
    ['an empty reason', { durationHours: 5, reason: '  ' }],
    ['a reason over 500 characters', { durationHours: 5, reason: 'x'.repeat(501) }],
    ['a field nobody asked for', { durationHours: 5, reason: 'x', role: 'admin' }],
  ])('rejects %s', async (_name, body) => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    const res = await ban(mod, target, body);
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
  });

  it('lets an admin ban for up to a year but not longer', async () => {
    const [admin, target] = [await newUser('boss', 'admin'), await newUser('target')];
    expect((await ban(admin, target, hours(8761))).status).toBe(400);
    expect((await ban(admin, target, hours(8760))).status).toBe(201);
  });

  it('only lets a higher role ban a lower one, and never oneself', async () => {
    const [mod, otherMod, admin, otherAdmin] = [
      await newUser('mod', 'moderator'),
      await newUser('mod2', 'moderator'),
      await newUser('boss', 'admin'),
      await newUser('boss2', 'admin'),
    ];

    for (const [actor, target] of [
      [mod, otherMod],
      [mod, admin],
      [admin, otherAdmin],
      [mod, mod],
      [admin, admin],
    ] as const) {
      const res = await ban(actor, target, hours(1));
      expect(res.status).toBe(403);
      expect(res.body?.error.code).toBe('FORBIDDEN');
    }
    expect((await ban(admin, otherMod, hours(1))).status).toBe(201);
  });

  it('answers 404 for an unknown user, 409 for one who is already banned', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    expect((await ban(mod, { id: '00000000-0000-4000-8000-000000000000' }, hours(1))).status).toBe(
      404,
    );
    expect((await ban(mod, { id: 'nope' }, hours(1))).status).toBe(400);

    await ban(mod, target, hours(1));
    const again = await ban(mod, target, hours(2));
    expect(again.status).toBe(409);
    expect(again.body?.error.code).toBe('INVALID_ACTION');
  });

  it('records the ban and the action in the audit log', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    await ban(mod, target, { durationHours: 3, reason: 'spam' });

    const [record] = await app.db.select().from(bans).where(eq(bans.userId, target.id));
    expect(record).toMatchObject({
      reason: 'spam',
      permanent: false,
      imposedBy: mod.id,
      revokedAt: null,
    });
    const [entry] = await app.db
      .select()
      .from(moderationActions)
      .orderBy(desc(moderationActions.createdAt));
    expect(entry).toMatchObject({ action: 'ban', actorId: mod.id, targetUserId: target.id });
    expect(entry?.details).toMatchObject({ reason: 'spam', durationHours: 3 });
  });
});

describe('lifting a ban', () => {
  it('lets a moderator lift a temporary ban, and the user is back at once', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    await ban(mod, target, hours(48));

    expect((await unban(mod, target)).status).toBe(204);

    expect((await call(target.token, 'GET', '/tickets')).status).toBe(200);
    const [record] = await app.db.select().from(bans).where(eq(bans.userId, target.id));
    expect(record).toMatchObject({ revokedBy: mod.id });
    expect(record?.revokedAt).toBeInstanceOf(Date);
  });

  it('keeps permanent bans for admins to lift', async () => {
    const [mod, admin, target] = [
      await newUser('mod', 'moderator'),
      await newUser('boss', 'admin'),
      await newUser('target'),
    ];
    await ban(admin, target, { permanent: true, reason: 'cheating' });

    expect((await unban(mod, target)).status).toBe(403);
    expect((await call(target.token, 'GET', '/tickets')).status).toBe(403);
    expect((await unban(admin, target)).status).toBe(204);
    expect((await call(target.token, 'GET', '/tickets')).status).toBe(200);
  });

  it('answers 404 for someone who is not banned', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    expect((await unban(mod, target)).status).toBe(404);
  });

  it('can be followed by a new ban', async () => {
    const [mod, target] = [await newUser('mod', 'moderator'), await newUser('target')];
    await ban(mod, target, hours(1));
    await unban(mod, target);
    expect((await ban(mod, target, hours(2))).status).toBe(201);
  });
});

describe('roles', () => {
  const setRole = (actor: Actor, target: { id: string }, role: unknown) =>
    call(actor.token, 'PATCH', `/admin/users/${target.id}/role`, { role });

  it('lets an admin promote and demote, which counts at once with the old token', async () => {
    const [admin, target] = [await newUser('boss', 'admin'), await newUser('target')];
    expect((await call(target.token, 'GET', '/moderation/users')).status).toBe(403);

    const res = await setRole(admin, target, 'moderator');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'target', role: 'moderator' });
    expect((await call(target.token, 'GET', '/moderation/users')).status).toBe(200);

    await setRole(admin, target, 'user');
    expect((await call(target.token, 'GET', '/moderation/users')).status).toBe(403);
  });

  it('refuses a change of one’s own role, a bad role and an unknown user', async () => {
    const admin = await newUser('boss', 'admin');
    expect((await setRole(admin, admin, 'user')).status).toBe(403);
    expect(
      (await setRole(admin, { id: '00000000-0000-4000-8000-000000000000' }, 'user')).status,
    ).toBe(404);
    const target = await newUser('target');
    expect((await setRole(admin, target, 'superuser')).status).toBe(400);
    expect(
      (await call(admin.token, 'PATCH', `/admin/users/${target.id}/role`, { role: 'user', x: 1 }))
        .status,
    ).toBe(400);
  });

  it('records the change in the audit log', async () => {
    const [admin, target] = [await newUser('boss', 'admin'), await newUser('target')];
    await setRole(admin, target, 'moderator');
    const [entry] = await app.db
      .select()
      .from(moderationActions)
      .orderBy(desc(moderationActions.createdAt));
    expect(entry).toMatchObject({
      action: 'role_change',
      actorId: admin.id,
      targetUserId: target.id,
    });
    expect(entry?.details).toEqual({ from: 'user', to: 'moderator' });
  });
});

describe('the audit log', () => {
  it('lists what staff did, the newest first, with names', async () => {
    const [mod, admin, target] = [
      await newUser('mod', 'moderator'),
      await newUser('boss', 'admin'),
      await newUser('target'),
    ];
    await ban(mod, target, hours(1));
    await unban(mod, target);
    await call(admin.token, 'PATCH', `/admin/users/${target.id}/role`, { role: 'moderator' });

    const { body } = await call(admin.token, 'GET', '/admin/audit');

    expect(body?.total).toBe(3);
    expect(body?.items.map((e: { action: string }) => e.action)).toEqual([
      'role_change',
      'unban',
      'ban',
    ]);
    expect(body?.items[0]).toMatchObject({
      actor: { username: 'boss' },
      target: { username: 'target' },
      details: { from: 'user', to: 'moderator' },
    });
    expect((await call(admin.token, 'GET', '/admin/audit?limit=2')).body?.items).toHaveLength(2);
    expect((await call(admin.token, 'GET', '/admin/audit?limit=101')).status).toBe(400);
  });

  it('records ticket answers and status changes of the staff', async () => {
    const [mod, author] = [await newUser('mod', 'moderator'), await newUser('author')];
    const ticket = (await call(author.token, 'POST', '/tickets', { subject: 'Help', body: 'x' }))
      .body!;

    await call(mod.token, 'POST', `/staff/tickets/${ticket.id}/replies`, { body: 'on it' });
    await call(mod.token, 'PATCH', `/staff/tickets/${ticket.id}/status`, { status: 'resolved' });

    const actions = await app.db.select().from(moderationActions);
    expect(actions.map((a) => a.action).sort()).toEqual(['ticket_reply', 'ticket_status']);
    expect(actions.every((a) => a.actorId === mod.id && a.targetUserId === author.id)).toBe(true);
  });
});
