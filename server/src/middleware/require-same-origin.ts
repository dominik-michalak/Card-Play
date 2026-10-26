import type { RequestHandler } from 'express';
import { HttpError } from '../http-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence for the refresh cookie: browsers always send Origin on cross-site
// state-changing requests, and a forged request cannot set it to our origin.
// SameSite=Strict on the cookie is the second layer.
export function requireSameOrigin(allowedOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || req.get('origin') === allowedOrigin) {
      next();
      return;
    }
    next(new HttpError(403, 'FORBIDDEN', 'origin not allowed'));
  };
}
