import { Router } from 'express';
import type { Config } from '../../config';
import { authenticate, currentUser } from '../../middleware/authenticate';
import { createAuthRateLimit } from '../../middleware/rate-limit';
import { validate } from '../../validate';
import {
  createRoomSchema,
  joinRoomSchema,
  roomIdSchema,
  type CreateRoomInput,
  type JoinRoomInput,
} from './rooms.schemas';
import type { RoomsService } from './rooms.service';

export function createRoomsRouter(rooms: RoomsService, config: Config): Router {
  const router = Router();
  router.use(authenticate(config.jwtSecret));

  router.post('/', async (req, res) => {
    const input = validate<CreateRoomInput>(createRoomSchema, req.body);
    res.status(201).json(await rooms.createRoom(currentUser(res).userId, input));
  });

  // only failed attempts count, so guessing codes is slowed down but normal use is not
  router.post('/join', createAuthRateLimit(config.authRateLimitMax, true), async (req, res) => {
    const { code } = validate<JoinRoomInput>(joinRoomSchema, req.body);
    res.json(await rooms.joinByCode(currentUser(res).userId, code));
  });

  // declared before '/:id', which would otherwise take "current" for a room id
  router.get('/current', async (_req, res) => {
    res.json(await rooms.getCurrentRoom(currentUser(res).userId));
  });

  router.get('/:id', async (req, res) => {
    const roomId = validate<string>(roomIdSchema, req.params.id);
    res.json(await rooms.getRoom(roomId, currentUser(res).userId));
  });

  router.post('/:id/leave', async (req, res) => {
    const roomId = validate<string>(roomIdSchema, req.params.id);
    res.json(await rooms.leaveRoom(roomId, currentUser(res).userId));
  });

  return router;
}
