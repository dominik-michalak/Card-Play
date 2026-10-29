import { ROLE_RANK, type UserRole } from '@cardplay/shared';
import type { RequestHandler, Response } from 'express';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { HttpError } from '../http-error';
import { isBanned } from '../modules/moderation/bans';
import { findUserById } from '../modules/users/users.queries';
import { currentUser } from './authenticate';

type Account = typeof users.$inferSelect;

// the account as the database has it now; set by `requireActiveUser`
export function currentAccount(res: Response): Account {
  const account = res.locals.account as Account | undefined;
  if (!account) throw new Error('currentAccount called on a route without requireActiveUser');
  return account;
}

// Runs after `authenticate`. The token only says who the caller is; whether the account still
// exists and is not banned is read from the database on every request, so a ban works at once.
export function requireActiveUser(db: Db): RequestHandler {
  return async (_req, res, next) => {
    try {
      const account = await findUserById(db, currentUser(res).userId);
      if (!account) {
        next(new HttpError(401, 'UNAUTHORIZED', 'account no longer exists'));
        return;
      }
      if (isBanned(account)) {
        next(new HttpError(403, 'FORBIDDEN', 'account is banned'));
        return;
      }
      res.locals.account = account;
      next();
    } catch (error) {
      next(error);
    }
  };
}

// The role is read from the account loaded above, never from the token's claim.
export function requireRole(minimum: UserRole): RequestHandler {
  return (_req, res, next) => {
    try {
      if (ROLE_RANK[currentAccount(res).role] >= ROLE_RANK[minimum]) {
        next();
        return;
      }
      next(new HttpError(403, 'FORBIDDEN', 'insufficient role'));
    } catch (error) {
      next(error);
    }
  };
}
