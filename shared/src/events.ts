import type { ErrorPayload } from './errors';
import type { ClientGameState, GameAction, GameEvent, GameResult, RatingChange } from './game';
import type { GameKey } from './game';
import type { MatchmakingMode, RoomPlayer } from './rooms';

export type ChatMessage = { userId: string; username: string; message: string; sentAt: string };

// socket.io event maps, usable as generics on both server and client
export type ClientToServerEvents = {
  'room:join': (payload: { roomId: string }) => void;
  'room:leave': (payload: { roomId: string }) => void;
  'room:seat': (payload: { roomId: string; seatIndex: number }) => void;
  'room:ready': (payload: { roomId: string; ready: boolean }) => void;
  'room:chat': (payload: { roomId: string; message: string }) => void;
  'game:action': (payload: { roomId: string; action: GameAction }) => void;
  'matchmaking:join': (payload: { gameType: GameKey; mode: MatchmakingMode }) => void;
  'matchmaking:leave': () => void;
  // invites an online friend to the caller's private room, which must have a free seat
  'friend:invite': (payload: { userId: string; roomId: string }) => void;
};

export type ServerToClientEvents = {
  'room:players': (payload: { roomId: string; players: RoomPlayer[] }) => void;
  // ISO time the game starts, null when the countdown was cancelled
  'room:countdown': (payload: { roomId: string; startsAt: string | null }) => void;
  'room:chat': (payload: { roomId: string } & ChatMessage) => void;
  'game:state_update': (payload: { roomId: string; state: ClientGameState }) => void;
  'game:event': (payload: { roomId: string; event: GameEvent }) => void;
  'game:finished': (payload: {
    roomId: string;
    result: GameResult;
    ratings: RatingChange[];
  }) => void;
  'matchmaking:found': (payload: { roomId: string }) => void;
  // a friend asks to join their private room; `inviteCode` is what POST /lobbies/join needs
  'friend:invited': (payload: {
    fromUserId: string;
    fromUsername: string;
    gameType: GameKey;
    inviteCode: string;
  }) => void;
  // `reason` explains why the player is no longer queued when they did not ask for it
  'matchmaking:status': (payload: {
    queued: boolean;
    gameType?: GameKey;
    mode?: MatchmakingMode;
    reason?: 'left' | 'match_failed' | 'opponent_missing';
  }) => void;
  error: (payload: ErrorPayload) => void;
};
