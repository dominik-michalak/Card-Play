import { BAN_REASON_MAX, USER_ROLES, type UserRole } from '@cardplay/shared';
import { Router } from 'express';
import Joi from 'joi';
import type { Config } from '../../config';
import { authenticate } from '../../middleware/authenticate';
import { currentAccount, requireActiveUser, requireRole } from '../../middleware/require-role';
import type { Db } from '../../db/client';
import { validate } from '../../validate';
import type { Actor, BanInput, ModerationService, Page } from './moderation.service';

const idSchema = Joi.string().uuid().label('id').required();
const pageSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
});
const usersQuerySchema = pageSchema.keys({
  search: Joi.string().trim().min(1).max(64),
  status: Joi.string().valid('banned'),
});
// exactly one of a duration in hours or "permanent"; the limits per role are checked later
const banSchema = Joi.object({
  durationHours: Joi.number().integer().min(1),
  permanent: Joi.boolean().valid(true),
  reason: Joi.string().trim().min(1).max(BAN_REASON_MAX).required(),
}).xor('durationHours', 'permanent');
const roleSchema = Joi.object({
  role: Joi.string()
    .valid(...USER_ROLES)
    .required(),
});

const actor = (res: Parameters<typeof currentAccount>[0]): Actor => {
  const { id, role } = currentAccount(res);
  return { id, role };
};

// moderators and admins: find users, ban and unban
export function createModerationRouter(
  moderation: ModerationService,
  db: Db,
  config: Config,
): Router {
  const router = Router();
  router.use(authenticate(config.jwtSecret), requireActiveUser(db), requireRole('moderator'));

  router.get('/users', async (req, res) => {
    const { search, status, ...page } = validate<Page & { search?: string; status?: 'banned' }>(
      usersQuerySchema,
      req.query,
    );
    res.json(await moderation.listUsers({ search, banned: status === 'banned' }, page));
  });

  router.get('/users/:id', async (req, res) => {
    res.json(await moderation.getUser(validate<string>(idSchema, req.params.id)));
  });

  router.post('/users/:id/ban', async (req, res) => {
    const id = validate<string>(idSchema, req.params.id);
    const input = validate<BanInput>(banSchema, req.body);
    res.status(201).json(await moderation.ban(actor(res), id, input));
  });

  router.delete('/users/:id/ban', async (req, res) => {
    await moderation.unban(actor(res), validate<string>(idSchema, req.params.id));
    res.status(204).end();
  });

  return router;
}

// admins only: roles and the audit log
export function createAdminRouter(moderation: ModerationService, db: Db, config: Config): Router {
  const router = Router();
  router.use(authenticate(config.jwtSecret), requireActiveUser(db), requireRole('admin'));

  router.patch('/users/:id/role', async (req, res) => {
    const id = validate<string>(idSchema, req.params.id);
    const { role } = validate<{ role: UserRole }>(roleSchema, req.body);
    res.json(await moderation.setRole(actor(res), id, role));
  });

  router.get('/audit', async (req, res) => {
    res.json(await moderation.audit(validate<Page>(pageSchema, req.query)));
  });

  return router;
}
