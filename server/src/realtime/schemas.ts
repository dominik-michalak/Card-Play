import { MATCHMAKING_GAMES, type GameKey, type MatchmakingMode } from '@cardplay/shared';
import Joi from 'joi';
import { roomIdSchema } from '../modules/rooms/rooms.schemas';

const roomId = roomIdSchema.label('roomId');

export const roomRefSchema = Joi.object({ roomId });

export const seatSchema = Joi.object({
  roomId,
  seatIndex: Joi.number().integer().min(0).max(5).strict().required(),
});

export const readySchema = Joi.object({ roomId, ready: Joi.boolean().strict().required() });

export const actionSchema = Joi.object({
  roomId,
  action: Joi.object({
    type: Joi.string().max(32).required(),
    payload: Joi.any(),
  }).required(),
});

export const matchmakingJoinSchema = Joi.object({
  gameType: Joi.string()
    .valid(...MATCHMAKING_GAMES)
    .required(),
  mode: Joi.string().valid('competitive', 'unrated').required(),
});

export type MatchmakingJoinPayload = { gameType: GameKey; mode: MatchmakingMode };
export type RoomRef = { roomId: string };
export type SeatPayload = { roomId: string; seatIndex: number };
export type ReadyPayload = { roomId: string; ready: boolean };
export type ActionPayload = { roomId: string; action: { type: string; payload?: unknown } };
