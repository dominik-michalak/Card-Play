import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { refreshTokens, users } from '../../../server/src/db/schema';
import { verifyAccessToken } from '../../../server/src/modules/auth/tokens';
import { api, cookieValue, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

const alice = { username: 'alice', email: 'alice@example.com', password: 'correct horse' };

async function register(body: Record<string, unknown> = alice) {
  return api(app.url, '/api/v1/auth/register', { body });
}

function refreshCookie(setCookie: string[]): string {
  return `refresh_token=${cookieValue(setCookie, 'refresh_token')}`;
}

describe('POST /auth/register', () => {
  it('creates the account and signs the user in', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body?.user).toMatchObject({ username: 'alice', email: alice.email, role: 'user' });
    expect(verifyAccessToken(res.body?.accessToken, app.config.jwtSecret)).toMatchObject({
      userId: res.body?.user.id,
      role: 'user',
    });
  });

  it('never returns the password or its hash', async () => {
    const res = await register();
    expect(JSON.stringify(res.body)).not.toContain(alice.password);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('hash');
  });

  it('stores a bcrypt hash, not the password', async () => {
    await register();
    const [row] = await app.db.select().from(users);
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(row?.passwordHash).not.toContain(alice.password);
  });

  it('sets a hardened refresh cookie and stores only its hash', async () => {
    const res = await register();
    const cookie = res.setCookie.find((c) => c.startsWith('refresh_token='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('Max-Age=604800');
    const raw = cookieValue(res.setCookie, 'refresh_token')!;
    const rows = await app.db.select().from(refreshTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(raw);
  });

  it('marks the cookie Secure in production', async () => {
    const prod = await startTestApp({ isProduction: true });
    const res = await api(prod.url, '/api/v1/auth/register', { body: alice });
    expect(res.setCookie.find((c) => c.startsWith('refresh_token='))).toContain('Secure');
    await prod.close();
  });

  it('rejects a duplicate username or email with one generic message', async () => {
    await register();
    const sameName = await register({ ...alice, username: 'ALICE', email: 'other@example.com' });
    const sameEmail = await register({ ...alice, username: 'bob', email: 'ALICE@example.com' });
    expect(sameName.status).toBe(409);
    expect(sameEmail.status).toBe(409);
    expect(sameName.body).toEqual(sameEmail.body);
    expect(sameName.body?.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('does not let the client choose a role', async () => {
    const res = await register({ ...alice, role: 'admin' });
    expect(res.status).toBe(400);
    expect(await app.db.select().from(users)).toHaveLength(0);
  });

  it.each([
    ['short username', { username: 'ab' }],
    ['long username', { username: 'a'.repeat(21) }],
    ['username with symbols', { username: "al'ice" }],
    ['bad email', { email: 'not-an-email' }],
    ['short password', { password: 'short' }],
    ['password over 72 bytes', { password: 'ä'.repeat(37) }],
    ['missing field', { password: undefined }],
    ['unknown field', { admin: true }],
  ])('rejects %s', async (_name, change) => {
    const res = await register({ ...alice, ...change });
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
  });

  it('accepts a password of exactly 72 bytes', async () => {
    expect((await register({ ...alice, password: 'p'.repeat(72) })).status).toBe(201);
  });

  it('does not echo the submitted password in validation errors', async () => {
    const res = await register({ ...alice, password: 'short' });
    expect(JSON.stringify(res.body)).not.toContain('short"');
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const malformed = await api(app.url, '/api/v1/auth/register', { rawBody: '{nope' });
    expect(malformed.status).toBe(400);
    const huge = await api(app.url, '/api/v1/auth/register', {
      body: { ...alice, bio: 'x'.repeat(60_000) },
    });
    expect(huge.status).toBe(413);
  });

  it('treats SQL metacharacters in the email as plain data', async () => {
    const res = await register({ ...alice, email: "o'brien+x@example.com" });
    expect([201, 400]).toContain(res.status);
    expect((await app.db.select().from(users)).length).toBe(res.status === 201 ? 1 : 0);
  });
});

describe('CSRF origin check', () => {
  it.each([
    ['a foreign origin', 'http://evil.example'],
    ['a missing origin', null],
    ['a look-alike origin', 'http://localhost:5173.evil.example'],
  ])('rejects state-changing requests with %s', async (_name, origin) => {
    const res = await api(app.url, '/api/v1/auth/register', { body: alice, origin });
    expect(res.status).toBe(403);
    expect(await app.db.select().from(users)).toHaveLength(0);
  });

  it('blocks a forged refresh even when the browser attaches the cookie', async () => {
    const { setCookie } = await register();
    const res = await api(app.url, '/api/v1/auth/refresh', {
      cookie: refreshCookie(setCookie),
      origin: 'http://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('blocks a forged logout and keeps the session', async () => {
    const { setCookie } = await register();
    const res = await api(app.url, '/api/v1/auth/logout', {
      cookie: refreshCookie(setCookie),
      origin: 'http://evil.example',
    });
    expect(res.status).toBe(403);
    const rows = await app.db.select().from(refreshTokens);
    expect(rows[0]?.revokedAt).toBeNull();
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await register();
  });

  it('signs in with e-mail and password, ignoring e-mail case', async () => {
    const res = await api(app.url, '/api/v1/auth/login', {
      body: { email: 'ALICE@example.com', password: alice.password },
    });
    expect(res.status).toBe(200);
    expect(res.body?.user.username).toBe('alice');
    expect(cookieValue(res.setCookie, 'refresh_token')).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown e-mail', async () => {
    const wrongPassword = await api(app.url, '/api/v1/auth/login', {
      body: { email: alice.email, password: 'wrong password' },
    });
    const unknownEmail = await api(app.url, '/api/v1/auth/login', {
      body: { email: 'nobody@example.com', password: 'wrong password' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.setCookie).toHaveLength(0);
  });

  it('refuses a banned user with the right password', async () => {
    await app.db.update(users).set({ isBanned: true });
    const res = await api(app.url, '/api/v1/auth/login', {
      body: { email: alice.email, password: alice.password },
    });
    expect(res.status).toBe(403);
    expect(res.setCookie).toHaveLength(0);
  });

  it('does not tell a banned user from a wrong password without the password', async () => {
    await app.db.update(users).set({ isBanned: true });
    const res = await api(app.url, '/api/v1/auth/login', {
      body: { email: alice.email, password: 'wrong password' },
    });
    expect(res.status).toBe(401);
  });

  it.each([{}, { email: alice.email }, { password: 'x' }, { email: 5, password: 'x' }])(
    'rejects invalid body %j',
    async (body) => {
      expect((await api(app.url, '/api/v1/auth/login', { body })).status).toBe(400);
    },
  );
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and returns a new access token', async () => {
    const first = await register();
    const old = refreshCookie(first.setCookie);
    const res = await api(app.url, '/api/v1/auth/refresh', { cookie: old });
    expect(res.status).toBe(200);
    expect(verifyAccessToken(res.body?.accessToken, app.config.jwtSecret)).not.toBeNull();
    expect(refreshCookie(res.setCookie)).not.toBe(old);
  });

  it('rejects the old token after rotation', async () => {
    const first = await register();
    const old = refreshCookie(first.setCookie);
    await api(app.url, '/api/v1/auth/refresh', { cookie: old });
    const again = await api(app.url, '/api/v1/auth/refresh', { cookie: old });
    expect(again.status).toBe(401);
  });

  it('lets only one of two concurrent refreshes win', async () => {
    const cookie = refreshCookie((await register()).setCookie);
    const results = await Promise.all([
      api(app.url, '/api/v1/auth/refresh', { cookie }),
      api(app.url, '/api/v1/auth/refresh', { cookie }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it.each([
    ['no cookie', undefined],
    ['an unknown token', 'refresh_token=not-a-real-token'],
    ['an empty token', 'refresh_token='],
    ['an oversized token', `refresh_token=${'x'.repeat(500)}`],
  ])('rejects %s', async (_name, cookie) => {
    const res = await api(app.url, '/api/v1/auth/refresh', { cookie });
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const cookie = refreshCookie((await register()).setCookie);
    await app.db.update(refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await api(app.url, '/api/v1/auth/refresh', { cookie })).status).toBe(401);
  });

  it('ends every session when an old token is replayed after the grace period', async () => {
    const first = await register();
    const stolen = refreshCookie(first.setCookie);
    const rotated = await api(app.url, '/api/v1/auth/refresh', { cookie: stolen });
    const current = refreshCookie(rotated.setCookie);
    await app.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(
        eq(refreshTokens.tokenHash, (await app.db.select().from(refreshTokens))[0]!.tokenHash),
      );

    const replay = await api(app.url, '/api/v1/auth/refresh', { cookie: stolen });
    expect(replay.status).toBe(401);
    const legit = await api(app.url, '/api/v1/auth/refresh', { cookie: current });
    expect(legit.status).toBe(401);
  });

  it('keeps the new session when the old token is replayed right away', async () => {
    const first = await register();
    const old = refreshCookie(first.setCookie);
    const rotated = await api(app.url, '/api/v1/auth/refresh', { cookie: old });
    await api(app.url, '/api/v1/auth/refresh', { cookie: old });
    const legit = await api(app.url, '/api/v1/auth/refresh', {
      cookie: refreshCookie(rotated.setCookie),
    });
    expect(legit.status).toBe(200);
  });

  it('refuses a banned user and revokes their sessions', async () => {
    const cookie = refreshCookie((await register()).setCookie);
    await app.db.update(users).set({ isBanned: true });
    const res = await api(app.url, '/api/v1/auth/refresh', { cookie });
    expect(res.status).toBe(403);
    const rows = await app.db.select().from(refreshTokens);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the token and clears the cookie', async () => {
    const cookie = refreshCookie((await register()).setCookie);
    const res = await api(app.url, '/api/v1/auth/logout', { cookie });
    expect(res.status).toBe(204);
    expect(res.setCookie.find((c) => c.startsWith('refresh_token='))).toContain('Expires=');
    expect((await api(app.url, '/api/v1/auth/refresh', { cookie })).status).toBe(401);
  });

  it('is harmless without a session', async () => {
    expect((await api(app.url, '/api/v1/auth/logout')).status).toBe(204);
    expect(
      (await api(app.url, '/api/v1/auth/logout', { cookie: 'refresh_token=unknown' })).status,
    ).toBe(204);
  });
});

describe('rate limiting', () => {
  it('blocks repeated failed logins from one address', async () => {
    const limited = await startTestApp({ authRateLimitMax: 3 });
    const login = () =>
      api(limited.url, '/api/v1/auth/login', {
        body: { email: 'nobody@example.com', password: 'wrong password' },
      });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await login()).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    await limited.close();
  });

  it('does not count successful logins', async () => {
    const limited = await startTestApp({ authRateLimitMax: 2 });
    await api(limited.url, '/api/v1/auth/register', { body: alice });
    for (let i = 0; i < 4; i++) {
      const res = await api(limited.url, '/api/v1/auth/login', {
        body: { email: alice.email, password: alice.password },
      });
      expect(res.status).toBe(200);
    }
    await limited.close();
  });

  it('limits registrations', async () => {
    const limited = await startTestApp({ authRateLimitMax: 2 });
    const statuses = [];
    for (const name of ['aaa', 'bbb', 'ccc']) {
      const res = await api(limited.url, '/api/v1/auth/register', {
        body: { username: name, email: `${name}@example.com`, password: alice.password },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 429]);
    await limited.close();
  });
});
