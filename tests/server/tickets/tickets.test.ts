import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tickets, users } from '../../../server/src/db/schema';
import { signAccessToken } from '../../../server/src/modules/auth/tokens';
import { api, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser, tokenFor } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp({ ticketCreateLimitPerHour: 3, ticketReplyLimitPerHour: 4 });
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

async function newUser(name: string, role: 'user' | 'moderator' | 'admin' = 'user') {
  const user = await seedUser(app.db, name);
  if (role !== 'user') await app.db.update(users).set({ role }).where(eq(users.id, user.id));
  return { ...user, token: signAccessToken({ userId: user.id, role }, app.config.jwtSecret, 600) };
}

const send = (path: string, token: string | undefined, method: string, body?: unknown) =>
  api(app.url, `/api/v1${path}`, {
    method,
    token,
    body,
    origin: method === 'GET' ? null : undefined,
  });
const create = (token: string | undefined, body: unknown = { subject: 'Help', body: 'It broke' }) =>
  send('/tickets', token, 'POST', body);
const own = (token: string | undefined, query = '') => send(`/tickets${query}`, token, 'GET');
const reply = (token: string | undefined, id: string, body: unknown = { body: 'More info' }) =>
  send(`/tickets/${id}/replies`, token, 'POST', body);

describe('creating and reading own tickets', () => {
  it('requires authentication everywhere', async () => {
    expect((await create(undefined)).status).toBe(401);
    expect((await own(undefined)).status).toBe(401);
    expect(
      (await send('/tickets/00000000-0000-4000-8000-000000000000', undefined, 'GET')).status,
    ).toBe(401);
    expect((await reply(undefined, '00000000-0000-4000-8000-000000000000')).status).toBe(401);
  });

  it('creates an open ticket and shows it to its author', async () => {
    const alice = await newUser('alice');

    const res = await create(alice.token, { subject: ' Cannot play ', body: 'The table freezes' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      subject: 'Cannot play',
      body: 'The table freezes',
      status: 'open',
      replies: [],
    });
    const list = (await own(alice.token)).body;
    expect(list?.total).toBe(1);
    expect(list?.items[0]).toMatchObject({
      id: res.body?.id,
      subject: 'Cannot play',
      status: 'open',
    });
    expect(list?.items[0]).not.toHaveProperty('body');
  });

  it('keeps tickets private: another user sees neither the list entry nor the ticket', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    const { id } = (await create(alice.token)).body!;

    expect((await own(bob.token)).body?.total).toBe(0);
    const stolen = await send(`/tickets/${id}`, bob.token, 'GET');
    expect(stolen.status).toBe(404);
    expect(stolen.body?.error.code).toBe('NOT_FOUND');
    expect((await reply(bob.token, id)).status).toBe(404);
  });

  it('answers 404 for an unknown or malformed ticket id', async () => {
    const alice = await newUser('alice');
    expect(
      (await send('/tickets/00000000-0000-4000-8000-000000000000', alice.token, 'GET')).status,
    ).toBe(404);
    expect((await send('/tickets/not-a-uuid', alice.token, 'GET')).status).toBe(400);
  });

  it.each([
    ['no subject', { body: 'text' }],
    ['an empty subject', { subject: '   ', body: 'text' }],
    ['a subject over 120 characters', { subject: 'x'.repeat(121), body: 'text' }],
    ['an empty body', { subject: 'Hi', body: '' }],
    ['a body over 4000 characters', { subject: 'Hi', body: 'x'.repeat(4001) }],
    ['a field nobody asked for', { subject: 'Hi', body: 'text', status: 'closed' }],
    ['someone else as author', { subject: 'Hi', body: 'text', authorId: 'x' }],
    ['a number as subject', { subject: 42, body: 'text' }],
    ['a null character', { subject: 'Hi', body: 'te\u0000xt' }],
  ])('rejects %s', async (_name, body) => {
    const alice = await newUser('alice');
    const res = await create(alice.token, body);
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
  });

  it('accepts the longest allowed texts and stores markup as plain text', async () => {
    const alice = await newUser('alice');
    const text = '<script>alert(1)</script> & "quotes"';
    const res = await create(alice.token, {
      subject: 'x'.repeat(120),
      body: text + 'y'.repeat(4000 - text.length),
    });
    expect(res.status).toBe(201);
    expect(res.body?.body.startsWith(text)).toBe(true);
  });

  it('lists the most recently active tickets first, in pages of 20 up to 100', async () => {
    const bob = await newUser('bob');
    const first = (await create(bob.token, { subject: 'first', body: 'x' })).body!;
    await create(bob.token, { subject: 'second', body: 'x' });
    await reply(bob.token, first.id, { body: 'bump' });

    const list = (await own(bob.token)).body;
    expect(list?.items.map((t: { subject: string }) => t.subject)).toEqual(['first', 'second']);
    expect((await own(bob.token, '?limit=101')).status).toBe(400);
    expect((await own(bob.token, '?offset=-1')).status).toBe(400);
    expect((await own(bob.token, '?limit=1&offset=1')).body?.items).toHaveLength(1);
  });
});

describe('replying to a ticket', () => {
  it('adds the reply to the ticket in order', async () => {
    const alice = await newUser('alice');
    const { id } = (await create(alice.token)).body!;

    await reply(alice.token, id, { body: 'first' });
    await reply(alice.token, id, { body: 'second' });

    const detail = (await send(`/tickets/${id}`, alice.token, 'GET')).body;
    expect(detail?.replies.map((r: { body: string }) => r.body)).toEqual(['first', 'second']);
    expect(detail?.replies[0]).toMatchObject({ isStaff: false, authorName: 'alice' });
  });

  it('refuses a reply to a closed ticket', async () => {
    const alice = await newUser('alice');
    const { id } = (await create(alice.token)).body!;
    await app.db.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, id));

    const res = await reply(alice.token, id);
    expect(res.status).toBe(409);
    expect(res.body?.error.code).toBe('INVALID_ACTION');
  });

  it('reopens a resolved ticket when the author answers', async () => {
    const alice = await newUser('alice');
    const { id } = (await create(alice.token)).body!;
    await app.db.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, id));

    await reply(alice.token, id);

    expect((await send(`/tickets/${id}`, alice.token, 'GET')).body?.status).toBe('open');
  });

  it.each([
    ['an empty reply', { body: '' }],
    ['a reply over 4000 characters', { body: 'x'.repeat(4001) }],
    ['a field nobody asked for', { body: 'hi', isStaff: true }],
    ['a null character', { body: 'a\u0000b' }],
  ])('rejects %s', async (_name, body) => {
    const alice = await newUser('alice');
    const { id } = (await create(alice.token)).body!;
    expect((await reply(alice.token, id, body)).status).toBe(400);
  });
});

describe('rate limits', () => {
  it('limits ticket creation per user, not for everyone together', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    for (let i = 0; i < 3; i++) expect((await create(alice.token)).status).toBe(201);

    const blocked = await create(alice.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body?.error.code).toBe('RATE_LIMITED');
    expect((await create(bob.token)).status).toBe(201);
  });

  it('limits replies per user', async () => {
    const [carol, dave] = [await newUser('carol'), await newUser('dave')];
    const { id } = (await create(carol.token)).body!;
    const mine = (await create(dave.token)).body!;
    for (let i = 0; i < 4; i++) expect((await reply(carol.token, id)).status).toBe(201);
    expect((await reply(carol.token, id)).status).toBe(429);
    expect((await reply(dave.token, mine.id)).status).toBe(201);
  });
});

describe('the staff API', () => {
  const staffList = (token: string | undefined, query = '') =>
    send(`/staff/tickets${query}`, token, 'GET');

  it('is closed to anonymous callers and to ordinary users', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    const { id } = (await create(alice.token)).body!;

    expect((await staffList(undefined)).status).toBe(401);
    for (const res of [
      await staffList(bob.token),
      await send(`/staff/tickets/${id}`, bob.token, 'GET'),
      await send(`/staff/tickets/${id}/replies`, bob.token, 'POST', { body: 'hi' }),
      await send(`/staff/tickets/${id}/status`, bob.token, 'PATCH', { status: 'closed' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body?.error.code).toBe('FORBIDDEN');
    }
  });

  it.each(['moderator', 'admin'] as const)('lets a %s list and read every ticket', async (role) => {
    const [alice, bob, staff] = [
      await newUser('alice'),
      await newUser('bob'),
      await newUser('staffer', role),
    ];
    const a = (await create(alice.token, { subject: 'from alice', body: 'x' })).body!;
    await create(bob.token, { subject: 'from bob', body: 'y' });

    const list = (await staffList(staff.token)).body;
    expect(list?.total).toBe(2);
    expect(
      list?.items.map((t: { author: { username: string } }) => t.author.username).sort(),
    ).toEqual(['alice', 'bob']);
    const detail = (await send(`/staff/tickets/${a.id}`, staff.token, 'GET')).body;
    expect(detail).toMatchObject({
      subject: 'from alice',
      body: 'x',
      author: { username: 'alice' },
    });
  });

  it('never shows e-mail addresses', async () => {
    const [alice, staff] = [await newUser('alice'), await newUser('staffer', 'moderator')];
    const { id } = (await create(alice.token)).body!;
    const text =
      JSON.stringify((await staffList(staff.token)).body) +
      JSON.stringify((await send(`/staff/tickets/${id}`, staff.token, 'GET')).body);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('email');
  });

  it('filters by status and pages', async () => {
    const [alice, staff] = [await newUser('alice'), await newUser('staffer', 'moderator')];
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create(alice.token)).body!.id as string);
    await app.db.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ids[0]!));

    expect((await staffList(staff.token, '?status=resolved')).body?.total).toBe(1);
    expect((await staffList(staff.token, '?status=open')).body?.total).toBe(2);
    expect((await staffList(staff.token, '?status=nonsense')).status).toBe(400);
    expect((await staffList(staff.token, '?limit=2')).body?.items).toHaveLength(2);
    expect((await staffList(staff.token, '?limit=101')).status).toBe(400);
  });

  it('answers as "Obsługa" to the author, moves an open ticket to in progress', async () => {
    const [alice, staff] = [await newUser('alice'), await newUser('real_staff', 'moderator')];
    const { id } = (await create(alice.token)).body!;

    const res = await send(`/staff/tickets/${id}/replies`, staff.token, 'POST', {
      body: 'We are on it',
    });

    expect(res.status).toBe(201);
    const seenByAuthor = (await send(`/tickets/${id}`, alice.token, 'GET')).body;
    expect(seenByAuthor?.status).toBe('in_progress');
    expect(seenByAuthor?.replies).toMatchObject([
      { body: 'We are on it', isStaff: true, authorName: 'Obsługa' },
    ]);
    expect(JSON.stringify(seenByAuthor)).not.toContain('real_staff');
    // the staff sees who answered
    const seenByStaff = (await send(`/staff/tickets/${id}`, staff.token, 'GET')).body;
    expect(seenByStaff?.replies[0]).toMatchObject({ authorName: 'real_staff', isStaff: true });
  });

  it('changes the status, and refuses unknown statuses and tickets', async () => {
    const [alice, staff] = [await newUser('alice'), await newUser('staffer', 'admin')];
    const { id } = (await create(alice.token)).body!;

    const res = await send(`/staff/tickets/${id}/status`, staff.token, 'PATCH', {
      status: 'resolved',
    });
    expect(res.status).toBe(200);
    expect((await send(`/tickets/${id}`, alice.token, 'GET')).body?.status).toBe('resolved');

    expect(
      (await send(`/staff/tickets/${id}/status`, staff.token, 'PATCH', { status: 'deleted' }))
        .status,
    ).toBe(400);
    expect(
      (await send(`/staff/tickets/${id}/status`, staff.token, 'PATCH', { status: 'closed', x: 1 }))
        .status,
    ).toBe(400);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (await send(`/staff/tickets/${missing}/status`, staff.token, 'PATCH', { status: 'closed' }))
        .status,
    ).toBe(404);
    expect((await send(`/staff/tickets/${missing}`, staff.token, 'GET')).status).toBe(404);
  });

  it('refuses a staff reply to a closed ticket until it is reopened', async () => {
    const [alice, staff] = [await newUser('alice'), await newUser('staffer', 'moderator')];
    const { id } = (await create(alice.token)).body!;
    await send(`/staff/tickets/${id}/status`, staff.token, 'PATCH', { status: 'closed' });

    expect(
      (await send(`/staff/tickets/${id}/replies`, staff.token, 'POST', { body: 'hi' })).status,
    ).toBe(409);
    await send(`/staff/tickets/${id}/status`, staff.token, 'PATCH', { status: 'open' });
    expect(
      (await send(`/staff/tickets/${id}/replies`, staff.token, 'POST', { body: 'hi' })).status,
    ).toBe(201);
  });
});

describe('the role is read from the database, not from the token', () => {
  const staffList = (token: string) => send('/staff/tickets', token, 'GET');

  it('refuses a token that claims a role the user does not have', async () => {
    const mallory = await seedUser(app.db, 'mallory');
    const forged = signAccessToken(
      { userId: mallory.id, role: 'admin' },
      app.config.jwtSecret,
      600,
    );
    expect((await staffList(forged)).status).toBe(403);
  });

  it('honours a promotion at once and a demotion at once', async () => {
    const user = await seedUser(app.db, 'rising');
    const token = tokenFor(app.config, user.id); // the token says "user"
    expect((await staffList(token)).status).toBe(403);

    await app.db.update(users).set({ role: 'moderator' }).where(eq(users.id, user.id));
    expect((await staffList(token)).status).toBe(200);

    const adminToken = signAccessToken(
      { userId: user.id, role: 'admin' },
      app.config.jwtSecret,
      600,
    );
    await app.db.update(users).set({ role: 'user' }).where(eq(users.id, user.id));
    expect((await staffList(adminToken)).status).toBe(403);
  });

  it('refuses a banned moderator', async () => {
    const staff = await newUser('banned_staff', 'moderator');
    await app.db.update(users).set({ isBanned: true }).where(eq(users.id, staff.id));
    expect((await staffList(staff.token)).status).toBe(403);
  });

  it('refuses a token of a user that no longer exists', async () => {
    const staff = await newUser('ghost', 'moderator');
    await app.db.delete(users).where(eq(users.id, staff.id));
    expect((await staffList(staff.token)).status).toBe(401);
  });
});
