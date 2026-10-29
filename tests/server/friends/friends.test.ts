import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser, tokenFor } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

async function newUser(name: string) {
  const user = await seedUser(app.db, name);
  return { ...user, token: tokenFor(app.config, user.id) };
}

const BASE = '/api/v1/users/me/friends';
const list = (token?: string) => api(app.url, BASE, { method: 'GET', token, origin: null });
const invite = (token: string | undefined, username: unknown) =>
  api(app.url, BASE, { token, body: { username } });
const act = (token: string, userId: string, action: 'accept' | 'decline') =>
  api(app.url, `${BASE}/${userId}/${action}`, { token });
const remove = (token: string, userId: string) =>
  api(app.url, `${BASE}/${userId}`, { method: 'DELETE', token });

async function befriend(
  a: Awaited<ReturnType<typeof newUser>>,
  b: Awaited<ReturnType<typeof newUser>>,
) {
  await invite(a.token, b.username);
  await act(b.token, a.id, 'accept');
}

describe('friend invitations', () => {
  it('requires authentication', async () => {
    expect((await list()).status).toBe(401);
    expect((await invite(undefined, 'bob')).status).toBe(401);
  });

  it('invites by user name in any letter case and shows the invitation to both sides', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];

    const res = await invite(alice.token, 'BOB');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', user: { id: bob.id, username: 'bob' } });
    const mine = (await list(alice.token)).body;
    expect(mine?.outgoing).toMatchObject([{ userId: bob.id, username: 'bob' }]);
    expect(mine?.friends).toEqual([]);
    const theirs = (await list(bob.token)).body;
    expect(theirs?.incoming).toMatchObject([{ userId: alice.id, username: 'alice' }]);
  });

  it('makes both players friends once the invitation is accepted', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await invite(alice.token, 'bob');

    const accepted = await act(bob.token, alice.id, 'accept');

    expect(accepted.status).toBe(200);
    for (const [me, other] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const body = (await list(me.token)).body;
      expect(body?.friends).toMatchObject([{ userId: other.id, username: other.username }]);
      expect(body?.incoming).toEqual([]);
      expect(body?.outgoing).toEqual([]);
    }
  });

  it('lets the invited player decline and the inviter withdraw', async () => {
    const [alice, bob, carol] = [
      await newUser('alice'),
      await newUser('bob'),
      await newUser('carol'),
    ];
    await invite(alice.token, 'bob');
    await act(bob.token, alice.id, 'decline');
    expect((await list(alice.token)).body?.outgoing).toEqual([]);

    await invite(alice.token, 'carol');
    await act(alice.token, carol.id, 'decline');
    expect((await list(carol.token)).body?.incoming).toEqual([]);
    // after a decline the invitation can be sent again
    expect((await invite(alice.token, 'carol')).status).toBe(201);
  });

  it('accepts an invitation by itself when both players invited each other', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await invite(alice.token, 'bob');

    const res = await invite(bob.token, 'alice');

    expect(res.body?.status).toBe('accepted');
    expect((await list(alice.token)).body?.friends).toHaveLength(1);
  });

  it('refuses unknown names, yourself, duplicates and existing friends', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];

    const unknown = await invite(alice.token, 'nobody_here');
    expect(unknown.status).toBe(404);
    expect(unknown.body?.error.code).toBe('NOT_FOUND');
    expect((await invite(alice.token, 'alice')).status).toBe(400);
    expect((await invite(alice.token, 42)).status).toBe(400);

    await invite(alice.token, 'bob');
    expect((await invite(alice.token, 'bob')).status).toBe(409);
    await act(bob.token, alice.id, 'accept');
    const again = await invite(alice.token, 'bob');
    expect(again.status).toBe(409);
    expect(again.body?.error.code).toBe('INVALID_ACTION');
  });

  it('lets only the invited player accept', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await invite(alice.token, 'bob');

    expect((await act(alice.token, bob.id, 'accept')).status).toBe(404);
    expect((await act(bob.token, bob.id, 'accept')).status).toBe(404);
    expect((await list(bob.token)).body?.friends).toEqual([]);
  });

  it('answers 404 to an accept without an invitation, and to a malformed id', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    expect((await act(alice.token, bob.id, 'accept')).status).toBe(404);
    expect((await act(alice.token, 'not-a-uuid', 'accept')).status).toBe(400);
  });
});

describe('removing a friend', () => {
  it('ends the friendship for both players', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await befriend(alice, bob);

    expect((await remove(bob.token, alice.id)).status).toBe(204);

    expect((await list(alice.token)).body?.friends).toEqual([]);
    expect((await list(bob.token)).body?.friends).toEqual([]);
    // they can become friends again
    expect((await invite(alice.token, 'bob')).status).toBe(201);
  });

  it('answers 404 for someone who is not a friend, and does not delete a pending invitation', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await invite(alice.token, 'bob');

    expect((await remove(alice.token, bob.id)).status).toBe(404);
    expect((await list(bob.token)).body?.incoming).toHaveLength(1);
  });
});

describe('online status', () => {
  it('shows a friend as online while they hold a connection', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await befriend(alice, bob);
    expect((await list(alice.token)).body?.friends[0].online).toBe(false);

    app.presence.markOnline(bob.id);
    expect((await list(alice.token)).body?.friends[0].online).toBe(true);

    app.presence.markOffline(bob.id);
    expect((await list(alice.token)).body?.friends[0].online).toBe(false);
  });
});
