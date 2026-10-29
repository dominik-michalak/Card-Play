import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyAccessTokenWithExpiry,
} from '../../../server/src/modules/auth/tokens';

const secret = 'a'.repeat(64);
const payload = { userId: '11111111-1111-4111-8111-111111111111', role: 'moderator' } as const;

describe('access tokens', () => {
  it('round-trips the payload', () => {
    expect(verifyAccessToken(signAccessToken(payload, secret, 60), secret)).toEqual(payload);
  });

  it('reports when the token expires, in milliseconds', () => {
    const before = Date.now();
    const verified = verifyAccessTokenWithExpiry(signAccessToken(payload, secret, 60), secret);

    expect(verified).toMatchObject(payload);
    // jwt stores whole seconds, so the expiry may be up to a second earlier than ttl
    expect(verified!.expiresAt).toBeGreaterThan(before + 58_000);
    expect(verified!.expiresAt).toBeLessThanOrEqual(before + 60_000);
  });

  it('rejects a token signed with another secret', () => {
    expect(verifyAccessToken(signAccessToken(payload, 'b'.repeat(64), 60), secret)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ role: 'user' }, secret, {
      algorithm: 'HS256',
      issuer: 'cardplay',
      subject: payload.userId,
      expiresIn: -10,
    });
    expect(verifyAccessToken(expired, secret)).toBeNull();
  });

  it('rejects an unsigned (alg none) token', () => {
    const unsigned = jwt.sign({ role: 'admin', sub: payload.userId, iss: 'cardplay' }, '', {
      algorithm: 'none',
    });
    expect(verifyAccessToken(unsigned, secret)).toBeNull();
  });

  it('rejects another HMAC algorithm', () => {
    const hs512 = jwt.sign({ role: 'user' }, secret, {
      algorithm: 'HS512',
      issuer: 'cardplay',
      subject: payload.userId,
    });
    expect(verifyAccessToken(hs512, secret)).toBeNull();
  });

  it('rejects a wrong issuer, an unknown role and garbage', () => {
    const wrongIssuer = jwt.sign({ role: 'user' }, secret, { issuer: 'other', subject: 'x' });
    const wrongRole = jwt.sign({ role: 'root' }, secret, { issuer: 'cardplay', subject: 'x' });
    expect(verifyAccessToken(wrongIssuer, secret)).toBeNull();
    expect(verifyAccessToken(wrongRole, secret)).toBeNull();
    expect(verifyAccessToken('not.a.token', secret)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('generates unique, url-safe tokens', () => {
    const a = generateRefreshToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateRefreshToken()).not.toBe(a);
  });

  it('hashes deterministically and depends on the secret', () => {
    expect(hashRefreshToken('t', secret)).toBe(hashRefreshToken('t', secret));
    expect(hashRefreshToken('t', secret)).not.toBe(hashRefreshToken('t', 'b'.repeat(64)));
    expect(hashRefreshToken('t', secret)).not.toContain('t'.repeat(10));
  });
});
