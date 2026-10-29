import { GAME_KEYS, type GameKey } from '@cardplay/shared';
import { Router } from 'express';
import Joi from 'joi';
import type { Config } from '../../config';
import { authenticate, currentUser } from '../../middleware/authenticate';
import { validate } from '../../validate';
import type { Page, ProfileService } from './profile.service';

const refSchema = Joi.string().trim().min(1).max(64).label('user').required();
const gameSchema = Joi.string()
  .valid(...GAME_KEYS)
  .label('game')
  .required();
// at most 100 rows a page, 20 unless asked otherwise
const pageSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
});

export function createProfileRouter(profiles: ProfileService, config: Config): Router {
  const router = Router();
  const auth = authenticate(config.jwtSecret);

  // `me` stands for the caller
  const resolve = (ref: string, caller: string) =>
    profiles.findUser(ref.toLowerCase() === 'me' ? caller : ref);

  router.get('/users/:ref/profile', auth, async (req, res) => {
    const ref = validate<string>(refSchema, req.params.ref);
    res.json(await profiles.getProfile(await resolve(ref, currentUser(res).userId)));
  });

  router.get('/users/:ref/games', auth, async (req, res) => {
    const ref = validate<string>(refSchema, req.params.ref);
    const page = validate<Page>(pageSchema, req.query);
    const user = await resolve(ref, currentUser(res).userId);
    res.json(await profiles.getHistory(user.id, page));
  });

  router.get('/leaderboard/:gameType', auth, async (req, res) => {
    const gameType = validate<GameKey>(gameSchema, req.params.gameType);
    res.json(await profiles.getLeaderboard(gameType, validate<Page>(pageSchema, req.query)));
  });

  return router;
}
