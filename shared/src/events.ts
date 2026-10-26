import type { ErrorPayload } from './errors';
import type { ClientGameState, GameAction, GameEvent, GameResult } from './game';
import type { RoomPlayer } from './rooms';

export type ChatMessage = { userId: string; username: string; message: string; sentAt: string };

// socket.io event maps, usable as generics on both server and client
export type ClientToServerEvents = {
  'room:join': (payload: { roomId: string }) => void;
  'room:leave': (payload: { roomId: string }) => void;
  'room:seat': (payload: { roomId: string; seatIndex: number }) => void;
  'room:ready': (payload: { roomId: string; ready: boolean }) => void;
  'room:chat': (payload: { roomId: string; message: string }) => void;
  'game:action': (payload: { roomId: string; action: GameAction }) => void;
};

export type ServerToClientEvents = {
  'room:players': (payload: { roomId: string; players: RoomPlayer[] }) => void;
  'room:chat': (payload: { roomId: string } & ChatMessage) => void;
  'game:state_update': (payload: { roomId: string; state: ClientGameState }) => void;
  'game:event': (payload: { roomId: string; event: GameEvent }) => void;
  'game:finished': (payload: { roomId: string; result: GameResult }) => void;
  'matchmaking:found': (payload: { roomId: string }) => void;
  error: (payload: ErrorPayload) => void;
};
