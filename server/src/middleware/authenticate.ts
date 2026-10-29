import type { RequestHandler, Response } from 'express';
import { HttpError } from '../http-error';
import { verifyAccessToken, type AccessTokenPayload } from '../modules/auth/tokens';

export function authenticate(jwtSecret: string): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    const payload = scheme === 'Bearer' && token ? verifyAccessToken(token, jwtSecret) : null;
    if (!payload) {
      next(new HttpError(401, 'UNAUTHORIZED', 'missing or invalid access token'));
      return;
    }
    res.locals.user = payload;
    next();
  };
}

// the user set by `authenticate`; throws if the route forgot to use it
export function currentUser(res: Response): AccessTokenPayload {
  const user = res.locals.user as AccessTokenPayload | undefined;
  if (!user) {
    throw new Error('currentUser called on a route without authenticate');
  }
  return user;
}
