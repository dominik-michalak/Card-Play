import { Router, type CookieOptions, type Response } from 'express';
import type { Schema } from 'joi';
import type { Config } from '../../config';
import { HttpError } from '../../http-error';
import { createAuthRateLimit } from '../../middleware/rate-limit';
import { loginSchema, registerSchema } from './auth.schemas';
import type { AuthService, Session } from './auth.service';

const REFRESH_COOKIE = 'refresh_token';
const AUTH_PATH = '/api/v1/auth';

function validate<T>(schema: Schema, body: unknown): T {
  // a missing body (wrong content type) is validated as {} and fails on required fields
  const { error, value } = schema.validate(body ?? {}, { abortEarly: false });
  if (error) {
    throw error;
  }
  return value as T;
}

export function createAuthRouter(auth: AuthService, config: Config): Router {
  const router = Router();

  const cookieOptions: CookieOptions = {
    httpOnly: true, // not readable by scripts, so XSS cannot steal it
    secure: config.isProduction,
    sameSite: 'strict',
    path: AUTH_PATH, // sent only to the auth endpoints
  };

  function sendSession(res: Response, status: number, session: Session): void {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...cookieOptions,
      maxAge: config.refreshTokenTtlSeconds * 1000,
    });
    res.status(status).json({ accessToken: session.accessToken, user: session.user });
  }

  function readRefreshCookie(cookies: Record<string, unknown> | undefined): string {
    const token = cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) {
      throw new HttpError(401, 'UNAUTHORIZED', 'missing refresh token');
    }
    return token;
  }

  router.post(
    '/register',
    createAuthRateLimit(config.authRateLimitMax, false),
    async (req, res) => {
      sendSession(res, 201, await auth.register(validate(registerSchema, req.body)));
    },
  );

  // only failed logins count towards the limit, so normal use is never blocked
  router.post('/login', createAuthRateLimit(config.authRateLimitMax, true), async (req, res) => {
    sendSession(res, 200, await auth.login(validate(loginSchema, req.body)));
  });

  router.post('/refresh', async (req, res) => {
    sendSession(res, 200, await auth.refresh(readRefreshCookie(req.cookies)));
  });

  router.post('/logout', async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token.length > 0 && token.length <= 200) {
      await auth.logout(token);
    }
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  return router;
}
