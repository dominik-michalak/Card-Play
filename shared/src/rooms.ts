import type { GameKey } from './game';

export const USER_ROLES = ['user', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const GAME_MODES = ['competitive', 'unrated', 'private', 'bot'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const ROOM_STATUSES = ['waiting', 'in_progress', 'finished'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

// persisted membership; `ready` is live lobby state added by the socket layer
export type RoomMember = {
  userId: string;
  username: string;
  seatIndex: number | null;
};

export type RoomPlayer = RoomMember & { ready: boolean };

export type Room = {
  id: string;
  gameType: GameKey;
  mode: GameMode;
  status: RoomStatus;
  targetPlayers: number;
  createdBy: string;
  // shown to members only; null for rooms without an invite
  inviteCode: string | null;
  players: RoomMember[];
};
