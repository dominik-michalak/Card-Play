import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../http-error';

const WINDOW_MS = 15 * 60 * 1000;

// per signed-in user, not per address: one person behind a shared proxy is not the whole proxy
export function createUserRateLimit(max: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (_req, res) =>
      (res.locals.user as { userId?: string } | undefined)?.userId ?? 'anonymous',
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'too many requests')),
  });
}

export function createAuthRateLimit(max: number, skipSuccessfulRequests: boolean) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'too many requests')),
  });
}
