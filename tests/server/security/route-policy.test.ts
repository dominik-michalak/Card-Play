import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UserRole } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../../../server/src/db/schema';
import { api, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser, tokenFor } from '../../helpers/users';

// The access policy of every HTTP route, written down in one place. A route that is added to
// the code without a line here fails the first test, so nobody can ship an unguarded route by
// forgetting it.
type Access = 'public' | 'user' | 'moderator' | 'admin';

const POLICY: Record<string, Access> = {
  'GET /health': 'public',

  'POST /api/v1/auth/register': 'public',
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/refresh': 'public',
  'POST /api/v1/auth/logout': 'public',

  'POST /api/v1/lobbies': 'user',
  'POST /api/v1/lobbies/join': 'user',
  'GET /api/v1/lobbies/current': 'user',
  'GET /api/v1/lobbies/:id': 'user',
  'POST /api/v1/lobbies/:id/leave': 'user',

  'GET /api/v1/users/me/friends': 'user',
  'POST /api/v1/users/me/friends': 'user',
  'POST /api/v1/users/me/friends/:userId/accept': 'user',
  'POST /api/v1/users/me/friends/:userId/decline': 'user',
  'DELETE /api/v1/users/me/friends/:userId': 'user',

  'GET /api/v1/users/:ref/profile': 'user',
  'GET /api/v1/users/:ref/games': 'user',
  'GET /api/v1/leaderboard/:gameType': 'user',

  'POST /api/v1/tickets': 'user',
  'GET /api/v1/tickets': 'user',
  'GET /api/v1/tickets/:id': 'user',
  'POST /api/v1/tickets/:id/replies': 'user',

  'GET /api/v1/staff/tickets': 'moderator',
  'GET /api/v1/staff/tickets/:id': 'moderator',
  'POST /api/v1/staff/tickets/:id/replies': 'moderator',
  'PATCH /api/v1/staff/tickets/:id/status': 'moderator',

  'GET /api/v1/moderation/users': 'moderator',
  'GET /api/v1/moderation/users/:id': 'moderator',
  'POST /api/v1/moderation/users/:id/ban': 'moderator',
  'DELETE /api/v1/moderation/users/:id/ban': 'moderator',

  'PATCH /api/v1/admin/users/:id/role': 'admin',
  'GET /api/v1/admin/audit': 'admin',
};

// where each router is mounted in app.ts
const MOUNTS: Record<string, string> = {
  createAuthRouter: '/api/v1/auth',
  createRoomsRouter: '/api/v1/lobbies',
  createFriendsRouter: '/api/v1/users/me/friends',
  createProfileRouter: '/api/v1',
  createTicketsRouter: '/api/v1/tickets',
  createStaffTicketsRouter: '/api/v1/staff/tickets',
  createModerationRouter: '/api/v1/moderation',
  createAdminRouter: '/api/v1/admin',
};

const ROUTE_FILES = [
  'modules/auth/auth.routes.ts',
  'modules/rooms/rooms.routes.ts',
  'modules/friends/friends.routes.ts',
  'modules/profile/profile.routes.ts',
  'modules/tickets/tickets.routes.ts',
  'modules/moderation/moderation.routes.ts',
];

// every route declared in the source: "METHOD /full/path"
function declaredRoutes(): string[] {
  const routes = ['GET /health'];
  for (const file of ROUTE_FILES) {
    const source = readFileSync(resolve(__dirname, '../../../server/src', file), 'utf8');
    for (const part of source.split(/^export function /m).slice(1)) {
      const mount = MOUNTS[part.slice(0, part.indexOf('('))];
      if (mount === undefined) throw new Error(`no mount known for ${part.slice(0, 40)}`);
      for (const match of part.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
        const path = match[2] === '/' ? '' : match[2];
        routes.push(`${match[1]!.toUpperCase()} ${mount}${path}`);
      }
    }
  }
  return routes;
}

const UUID = '00000000-0000-4000-8000-000000000000';
const concrete = (path: string): string =>
  path
    .replace(':id', UUID)
    .replace(':userId', UUID)
    .replace(':gameType', 'war')
    .replace(':ref', 'me');

let app: Awaited<ReturnType<typeof startTestApp>>;
const tokens = {} as Record<'user' | 'moderator' | 'admin' | 'banned', string>;

beforeAll(async () => {
  app = await startTestApp();
  await resetDb(app.db);
  for (const role of ['user', 'moderator', 'admin'] as UserRole[]) {
    const account = await seedUser(app.db, `policy_${role}`);
    await app.db.update(users).set({ role }).where(eq(users.id, account.id));
    // every token claims only "user": the database decides
    tokens[role] = tokenFor(app.config, account.id);
  }
  const banned = await seedUser(app.db, 'policy_banned');
  await app.db.update(users).set({ isBanned: true }).where(eq(users.id, banned.id));
  tokens.banned = tokenFor(app.config, banned.id);
});
afterAll(() => app.close());

const entries = Object.entries(POLICY).map(([key, access]) => {
  const [method, path] = key.split(' ') as [string, string];
  return { key, method, path, access };
});
const guarded = entries.filter((e) => e.access !== 'public');
const unsafe = entries.filter((e) => e.method !== 'GET');

const call = (method: string, path: string, token?: string, origin?: string | null) =>
  api(app.url, concrete(path), {
    method,
    token,
    body: method === 'GET' ? undefined : {},
    origin: method === 'GET' ? null : origin,
  });

describe('route policy', () => {
  it('covers every route in the code, and nothing else', () => {
    expect(declaredRoutes().sort()).toEqual(Object.keys(POLICY).sort());
  });

  it.each(guarded.map((e) => [e.key, e] as const))(
    '%s refuses a caller without a token',
    async (_k, e) => {
      expect((await call(e.method, e.path)).status).toBe(401);
    },
  );

  it.each(guarded.map((e) => [e.key, e] as const))('%s refuses a banned account', async (_k, e) => {
    const res = await call(e.method, e.path, tokens.banned);
    expect(res.status).toBe(403);
    expect(res.body?.error.message).toContain('banned');
  });

  it.each(
    entries
      .filter((e) => e.access === 'moderator' || e.access === 'admin')
      .map((e) => [e.key, e] as const),
  )('%s refuses an ordinary user', async (_k, e) => {
    expect((await call(e.method, e.path, tokens.user)).status).toBe(403);
  });

  it.each(entries.filter((e) => e.access === 'admin').map((e) => [e.key, e] as const))(
    '%s refuses a moderator',
    async (_k, e) => {
      expect((await call(e.method, e.path, tokens.moderator)).status).toBe(403);
    },
  );

  it.each(guarded.map((e) => [e.key, e] as const))(
    '%s lets in the roles it is meant for',
    async (_k, e) => {
      const allowed: Record<Access, ('user' | 'moderator' | 'admin')[]> = {
        public: [],
        user: ['user', 'moderator', 'admin'],
        moderator: ['moderator', 'admin'],
        admin: ['admin'],
      };
      for (const role of allowed[e.access]) {
        const res = await call(e.method, e.path, tokens[role]);
        // the request may still fail on its content, but not on who sent it
        expect([401, 403]).not.toContain(res.status);
      }
    },
  );

  it.each(
    entries
      // refresh needs the cookie, not a bearer token
      .filter((e) => e.access === 'public' && e.path !== '/health' && !e.path.endsWith('/refresh'))
      .map((e) => [e.key, e] as const),
  )('%s needs no token', async (_k, e) => {
    expect((await call(e.method, e.path)).status).not.toBe(401);
  });

  it.each(unsafe.map((e) => [e.key, e] as const))(
    '%s refuses a request from another origin, whoever sends it',
    async (_k, e) => {
      const res = await call(e.method, e.path, tokens.admin, 'https://evil.example');
      expect(res.status).toBe(403);
      expect(res.body?.error.message).toBe('origin not allowed');
    },
  );

  it('answers an unknown API path with 401 to a stranger and 404 to a member', async () => {
    expect((await call('GET', '/api/v1/nothing-here')).status).toBe(401);
    expect((await call('GET', '/api/v1/nothing-here', tokens.user)).status).toBe(404);
  });
});
