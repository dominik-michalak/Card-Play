import type { UserRole } from '@cardplay/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createErrorHandler } from '../../../server/src/middleware/error-handler';
import {
  authenticate,
  currentUser,
  requireRole,
} from '../../../server/src/middleware/authenticate';
import { signAccessToken } from '../../../server/src/modules/auth/tokens';
import { api } from '../../helpers/app';

const secret = 'a'.repeat(64);
const token = (role: UserRole, signingSecret = secret) =>
  signAccessToken({ userId: 'user-1', role }, signingSecret, 60);

let url: string;
let close: () => void;

beforeAll(async () => {
  const app = express();
  app.get('/me', authenticate(secret), (_req, res) => {
    res.json(currentUser(res));
  });
  app.get('/moderation', authenticate(secret), requireRole('moderator'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/admin', authenticate(secret), requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(createErrorHandler());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const get = (path: string, bearer?: string) =>
  api(url, path, { method: 'GET', origin: null, token: bearer });

describe('authenticate', () => {
  it('exposes the token payload to the handler', async () => {
    const res = await get('/me', token('user'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'user-1', role: 'user' });
  });

  it('rejects a missing token', async () => {
    expect((await get('/me')).status).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    expect((await get('/me', token('admin', 'c'.repeat(64)))).status).toBe(401);
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await fetch(`${url}/me`, { headers: { authorization: `Basic ${token('user')}` } });
    expect(res.status).toBe(401);
  });
});

describe('requireRole', () => {
  it('denies a user the moderation area', async () => {
    const res = await get('/moderation', token('user'));
    expect(res.status).toBe(403);
    expect(res.body?.error.code).toBe('FORBIDDEN');
  });

  it('lets a moderator in, but not into the admin area', async () => {
    expect((await get('/moderation', token('moderator'))).status).toBe(200);
    expect((await get('/admin', token('moderator'))).status).toBe(403);
  });

  it('lets an admin into everything below', async () => {
    expect((await get('/admin', token('admin'))).status).toBe(200);
    expect((await get('/moderation', token('admin'))).status).toBe(200);
  });

  it('answers 401 before 403 when there is no token', async () => {
    expect((await get('/admin')).status).toBe(401);
  });
});
