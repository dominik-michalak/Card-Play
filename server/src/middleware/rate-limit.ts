import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../http-error';

const WINDOW_MS = 15 * 60 * 1000;

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
