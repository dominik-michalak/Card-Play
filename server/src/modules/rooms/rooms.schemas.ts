import { BOT_GAMES, GAME_KEYS, GAME_PLAYER_LIMITS, type GameKey } from '@cardplay/shared';
import Joi from 'joi';
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from './invite-code';

export const roomIdSchema = Joi.string().uuid().label('id').required();

export const createRoomSchema = Joi.object({
  gameType: Joi.string()
    .valid(...GAME_KEYS)
    .required(),
  targetPlayers: Joi.number().integer(),
  // matchmaking rooms (competitive, unrated) are never created by a client
  mode: Joi.string().valid('private', 'bot'),
})
  .custom((value: CreateRoomInput, helpers) => {
    if (value.mode === 'bot') {
      // the bot is the only opponent, in games that have one
      if (!BOT_GAMES.includes(value.gameType) || (value.targetPlayers ?? 2) !== 2) {
        return helpers.error('any.invalid');
      }
      return value;
    }
    const limits = GAME_PLAYER_LIMITS[value.gameType];
    const count = value.targetPlayers;
    if (limits && count !== undefined && (count < limits.min || count > limits.max)) {
      return helpers.error('any.invalid');
    }
    return value;
  })
  .messages({ 'any.invalid': 'this game or player count is not available for that mode' });

export const joinRoomSchema = Joi.object({
  code: Joi.string()
    .trim()
    .uppercase()
    .pattern(new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`))
    .required()
    .messages({ 'string.pattern.base': '"code" is not a valid invite code' }),
});

export type CreateRoomInput = {
  gameType: GameKey;
  targetPlayers?: number;
  mode?: 'private' | 'bot';
};
export type JoinRoomInput = { code: string };
