import { Router } from 'express';
import Joi from 'joi';
import type { Config } from '../../config';
import { authenticate, currentUser } from '../../middleware/authenticate';
import { validate } from '../../validate';
import type { FriendsService } from './friends.service';

const inviteSchema = Joi.object({
  username: Joi.string().trim().min(1).max(64).required(),
});
const userIdSchema = Joi.string().uuid().label('id').required();

export function createFriendsRouter(friends: FriendsService, config: Config): Router {
  const router = Router();
  router.use(authenticate(config.jwtSecret));

  router.get('/', async (_req, res) => {
    res.json(await friends.list(currentUser(res).userId));
  });

  router.post('/', async (req, res) => {
    const { username } = validate<{ username: string }>(inviteSchema, req.body);
    res.status(201).json(await friends.invite(currentUser(res).userId, username));
  });

  router.post('/:userId/accept', async (req, res) => {
    await friends.accept(
      currentUser(res).userId,
      validate<string>(userIdSchema, req.params.userId),
    );
    res.json({ status: 'accepted' });
  });

  router.post('/:userId/decline', async (req, res) => {
    await friends.decline(
      currentUser(res).userId,
      validate<string>(userIdSchema, req.params.userId),
    );
    res.status(204).end();
  });

  router.delete('/:userId', async (req, res) => {
    await friends.remove(
      currentUser(res).userId,
      validate<string>(userIdSchema, req.params.userId),
    );
    res.status(204).end();
  });

  return router;
}
