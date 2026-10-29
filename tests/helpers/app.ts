import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/src/app';
import type { Config } from '../../server/src/config';
import { createFriendsService } from '../../server/src/modules/friends/friends.service';
import { createRoomsService } from '../../server/src/modules/rooms/rooms.service';
import { createPresence } from '../../server/src/realtime/presence';
import { openTestDb } from './db';

export const ORIGIN = 'http://localhost:5173';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    clientOrigin: ORIGIN,
    isProduction: false,
    databaseUrl: process.env.TEST_DATABASE_URL ?? '',
    jwtSecret: 'a'.repeat(64),
    jwtRefreshSecret: 'b'.repeat(64),
    bcryptCost: 4, // minimum, keeps the suite fast
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
    authRateLimitMax: 1000,
    ticketCreateLimitPerHour: 1000,
    ticketReplyLimitPerHour: 1000,
    ...overrides,
  };
}

export async function startTestApp(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const { db, pool } = openTestDb();
  const presence = createPresence();
  const server = createApp(config, db, {
    roomService: createRoomsService(db),
    friendsService: createFriendsService(db, presence),
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    db,
    config,
    presence,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  token?: string;
  origin?: string | null;
};

// tests read arbitrary response fields, so the parsed body is deliberately loosely typed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

export async function api(baseUrl: string, path: string, options: RequestOptions = {}) {
  const { method = 'POST', body, rawBody, cookie, token, origin = ORIGIN } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    setCookie: res.headers.getSetCookie(),
    body: text ? (JSON.parse(text) as Body) : undefined,
  };
}

// value of a cookie from a Set-Cookie header list, or undefined
export function cookieValue(setCookie: string[], name: string): string | undefined {
  const line = setCookie.find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0]?.slice(name.length + 1);
}
