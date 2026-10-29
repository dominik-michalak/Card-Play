import type { RequestHandler } from 'express';
import type { Db } from '../db/client';
import { HttpError } from '../http-error';
import { findUserById } from '../modules/users/users.queries';
import { currentUser } from './authenticate';

// The token only says who the caller is. Whether they may handle other people's tickets is
// read from the database on every request, so a demotion or a ban takes effect at once and a
// forged or stale role claim opens nothing.
export function requireStaff(db: Db): RequestHandler {
  return async (_req, res, next) => {
    try {
      const user = await findUserById(db, currentUser(res).userId);
      const staff = user && !user.isBanned && (user.role === 'moderator' || user.role === 'admin');
      if (!staff) {
        next(new HttpError(403, 'FORBIDDEN', 'staff only'));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
