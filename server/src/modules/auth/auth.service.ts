import bcrypt from 'bcryptjs';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { HttpError } from '../../http-error';
import {
  findUserByEmail,
  findUserById,
  insertUser,
  toPublicUser,
  type PublicUser,
  type UserRow,
} from '../users/users.queries';
import type { LoginInput, RegisterInput } from './auth.schemas';
import {
  findRefreshToken,
  insertRefreshToken,
  revokeActiveToken,
  revokeAllForUser,
} from './refresh-tokens';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens';

// a token revoked this recently is most likely a parallel tab, not a stolen token
const REUSE_GRACE_MS = 10_000;

const UNIQUE_VIOLATION = '23505';

export type Session = { user: PublicUser; accessToken: string; refreshToken: string };

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === UNIQUE_VIOLATION;
}

export function createAuthService(db: Db, config: Config) {
  // compared against when the e-mail is unknown, so response time does not reveal accounts
  const dummyHash = bcrypt.hashSync('not-a-real-password', config.bcryptCost);

  async function issueSession(user: UserRow): Promise<Session> {
    const refreshToken = generateRefreshToken();
    await insertRefreshToken(db, {
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken, config.jwtRefreshSecret),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
    });
    const accessToken = signAccessToken(
      { userId: user.id, role: user.role },
      config.jwtSecret,
      config.accessTokenTtlSeconds,
    );
    return { user: toPublicUser(user), accessToken, refreshToken };
  }

  async function register(input: RegisterInput): Promise<Session> {
    const passwordHash = await bcrypt.hash(input.password, config.bcryptCost);
    try {
      const user = await insertUser(db, {
        username: input.username,
        email: input.email,
        passwordHash,
      });
      return await issueSession(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // one message for both fields, so the form cannot be used to probe for e-mails
        throw new HttpError(409, 'ACCOUNT_EXISTS', 'username or email is already taken');
      }
      throw error;
    }
  }

  async function login(input: LoginInput): Promise<Session> {
    const user = await findUserByEmail(db, input.email);
    const passwordOk = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
    if (!user || !passwordOk) {
      throw new HttpError(401, 'UNAUTHORIZED', 'invalid email or password');
    }
    if (user.isBanned) {
      throw new HttpError(403, 'FORBIDDEN', 'account is banned');
    }
    return issueSession(user);
  }

  // rotation: every refresh revokes the presented token and issues a new one
  async function refresh(refreshToken: string): Promise<Session> {
    const tokenHash = hashRefreshToken(refreshToken, config.jwtRefreshSecret);
    const userId = await revokeActiveToken(db, tokenHash);
    if (!userId) {
      await revokeFamilyOnReuse(tokenHash);
      throw new HttpError(401, 'UNAUTHORIZED', 'invalid refresh token');
    }
    const user = await findUserById(db, userId);
    if (!user || user.isBanned) {
      await revokeAllForUser(db, userId);
      throw new HttpError(403, 'FORBIDDEN', 'account is not allowed to sign in');
    }
    return issueSession(user);
  }

  // presenting an already used token means two parties hold it: end every session
  async function revokeFamilyOnReuse(tokenHash: string): Promise<void> {
    const known = await findRefreshToken(db, tokenHash);
    if (known?.revokedAt && Date.now() - known.revokedAt.getTime() > REUSE_GRACE_MS) {
      await revokeAllForUser(db, known.userId);
    }
  }

  async function logout(refreshToken: string): Promise<void> {
    await revokeActiveToken(db, hashRefreshToken(refreshToken, config.jwtRefreshSecret));
  }

  return { register, login, refresh, logout };
}

export type AuthService = ReturnType<typeof createAuthService>;
