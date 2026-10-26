import { USER_ROLES, type UserRole } from '@cardplay/shared';
import { createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const ISSUER = 'cardplay';

export type AccessTokenPayload = { userId: string; role: UserRole };

export function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  ttlSeconds: number,
): string {
  return jwt.sign({ role: payload.role }, secret, {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: payload.userId,
    expiresIn: ttlSeconds,
  });
}

// returns null for any invalid, expired or malformed token
export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  try {
    // algorithms are pinned so a token cannot pick "none" or a different scheme
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER });
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      return null;
    }
    const role = decoded.role as UserRole;
    return USER_ROLES.includes(role) ? { userId: decoded.sub, role } : null;
  } catch {
    return null;
  }
}

// refresh tokens are opaque random strings, not JWTs: they are only ever looked up
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

// keyed hash: a leaked refresh_tokens table is useless without the server secret
export function hashRefreshToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
