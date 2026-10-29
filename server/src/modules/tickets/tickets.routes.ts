import {
  TICKET_BODY_MAX,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX,
  type TicketStatus,
} from '@cardplay/shared';
import { Router } from 'express';
import Joi from 'joi';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { authenticate, currentUser } from '../../middleware/authenticate';
import { createUserRateLimit } from '../../middleware/rate-limit';
import { requireStaff } from '../../middleware/require-staff';
import { validate } from '../../validate';
import type { Page, TicketsService } from './tickets.service';

const HOUR_MS = 60 * 60 * 1000;

// Postgres text cannot hold a null character, which would otherwise come back as a server error
const text = (label: string, max: number) =>
  Joi.string()
    .trim()
    .min(1)
    .max(max)
    .custom((value: string, helpers) =>
      value.includes('\u0000') ? helpers.error('any.invalid') : value,
    )
    .messages({ 'any.invalid': '{{#label}} must not contain null characters' })
    .label(label)
    .required();

const createSchema = Joi.object({
  subject: text('subject', TICKET_SUBJECT_MAX),
  body: text('body', TICKET_BODY_MAX),
});
const replySchema = Joi.object({ body: text('body', TICKET_BODY_MAX) });
const statusSchema = Joi.object({
  status: Joi.string()
    .valid(...TICKET_STATUSES)
    .required(),
});
const idSchema = Joi.string().uuid().label('id').required();
const pageSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
});
const staffPageSchema = pageSchema.keys({
  status: Joi.string().valid(...TICKET_STATUSES),
});

// a user's own tickets
export function createTicketsRouter(tickets: TicketsService, config: Config): Router {
  const router = Router();
  router.use(authenticate(config.jwtSecret));
  const createLimit = createUserRateLimit(config.ticketCreateLimitPerHour, HOUR_MS);
  const replyLimit = createUserRateLimit(config.ticketReplyLimitPerHour, HOUR_MS);

  router.post('/', createLimit, async (req, res) => {
    const input = validate<{ subject: string; body: string }>(createSchema, req.body);
    res.status(201).json(await tickets.create(currentUser(res).userId, input));
  });

  router.get('/', async (req, res) => {
    res.json(await tickets.listOwn(currentUser(res).userId, validate<Page>(pageSchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    res.json(
      await tickets.getOwn(currentUser(res).userId, validate<string>(idSchema, req.params.id)),
    );
  });

  router.post('/:id/replies', replyLimit, async (req, res) => {
    const id = validate<string>(idSchema, req.params.id);
    const { body } = validate<{ body: string }>(replySchema, req.body);
    await tickets.reply(currentUser(res).userId, id, body);
    res.status(201).json(await tickets.getOwn(currentUser(res).userId, id));
  });

  return router;
}

// every ticket, for moderators and admins; the role is checked in the database
export function createStaffTicketsRouter(tickets: TicketsService, db: Db, config: Config): Router {
  const router = Router();
  router.use(authenticate(config.jwtSecret), requireStaff(db));

  router.get('/', async (req, res) => {
    const { status, ...paging } = validate<Page & { status?: TicketStatus }>(
      staffPageSchema,
      req.query,
    );
    res.json(await tickets.listAll(status, paging));
  });

  router.get('/:id', async (req, res) => {
    res.json(await tickets.getAny(validate<string>(idSchema, req.params.id)));
  });

  router.post('/:id/replies', async (req, res) => {
    const id = validate<string>(idSchema, req.params.id);
    const { body } = validate<{ body: string }>(replySchema, req.body);
    await tickets.staffReply(currentUser(res).userId, id, body);
    res.status(201).json(await tickets.getAny(id));
  });

  router.patch('/:id/status', async (req, res) => {
    const id = validate<string>(idSchema, req.params.id);
    const { status } = validate<{ status: TicketStatus }>(statusSchema, req.body);
    await tickets.setStatus(currentUser(res).userId, id, status);
    res.json(await tickets.getAny(id));
  });

  return router;
}
