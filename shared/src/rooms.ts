import type { GameKey } from './game';

export const USER_ROLES = ['user', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const GAME_MODES = ['competitive', 'unrated', 'private', 'bot'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const ROOM_STATUSES = ['waiting', 'in_progress', 'finished'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export type RoomPlayer = {
  userId: string;
  username: string;
  seatIndex: number | null;
  ready: boolean;
};

export type Room = {
  id: string;
  gameType: GameKey;
  mode: GameMode;
  status: RoomStatus;
  targetPlayers: number;
  createdBy: string;
  players: RoomPlayer[];
};
