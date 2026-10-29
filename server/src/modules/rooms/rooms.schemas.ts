import { GAME_KEYS, GAME_PLAYER_LIMITS, type GameKey } from '@cardplay/shared';
import Joi from 'joi';
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from './invite-code';

export const roomIdSchema = Joi.string().uuid().label('id').required();

export const createRoomSchema = Joi.object({
  gameType: Joi.string()
    .valid(...GAME_KEYS)
    .required(),
  targetPlayers: Joi.number().integer(),
})
  .custom((value: CreateRoomInput, helpers) => {
    const limits = GAME_PLAYER_LIMITS[value.gameType];
    const count = value.targetPlayers;
    if (limits && count !== undefined && (count < limits.min || count > limits.max)) {
      return helpers.error('any.invalid');
    }
    return value;
  })
  .messages({ 'any.invalid': '"targetPlayers" is outside the limits of this game' });

export const joinRoomSchema = Joi.object({
  code: Joi.string()
    .trim()
    .uppercase()
    .pattern(new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`))
    .required()
    .messages({ 'string.pattern.base': '"code" is not a valid invite code' }),
});

export type CreateRoomInput = { gameType: GameKey; targetPlayers?: number };
export type JoinRoomInput = { code: string };
