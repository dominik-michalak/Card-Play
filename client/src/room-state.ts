import type {
  ClientGameState,
  GameResult,
  RatingChange,
  Room,
  RoomPlayer,
  ServerToClientEvents,
} from '@cardplay/shared';

export type ChatLine = Parameters<ServerToClientEvents['room:chat']>[0];
const CHAT_LINES_KEPT = 100;

export type RoomViewState = {
  roomId: string;
  players: RoomPlayer[];
  // ISO time the start countdown ends
  startsAt: string | null;
  game: ClientGameState | null;
  finished: { result: GameResult; ratings: RatingChange[] } | null;
  chat: ChatLine[];
  error: string | null;
};

export type RoomAction =
  | { type: 'players'; roomId: string; players: RoomPlayer[] }
  | { type: 'countdown'; roomId: string; startsAt: string | null }
  | { type: 'state'; roomId: string; state: ClientGameState }
  | { type: 'finished'; roomId: string; result: GameResult; ratings: RatingChange[] }
  | { type: 'chat'; line: ChatLine }
  | { type: 'error'; message: string }
  | { type: 'dismiss_error' };

export function initialRoomState(room: Room): RoomViewState {
  return {
    roomId: room.id,
    players: room.players.map((p) => ({ ...p, ready: false })),
    startsAt: null,
    game: null,
    finished: null,
    chat: [],
    error: null,
  };
}

// events of other rooms (e.g. a late one from a previous game) are ignored
export function roomReducer(state: RoomViewState, action: RoomAction): RoomViewState {
  if (action.type === 'error') return { ...state, error: action.message };
  if (action.type === 'dismiss_error') return { ...state, error: null };
  if (action.type === 'chat') {
    if (action.line.roomId !== state.roomId) return state;
    return { ...state, chat: [...state.chat, action.line].slice(-CHAT_LINES_KEPT) };
  }
  if (action.roomId !== state.roomId) return state;

  switch (action.type) {
    case 'players':
      return { ...state, players: action.players };
    case 'countdown':
      return { ...state, startsAt: action.startsAt };
    case 'state':
      // the countdown is over once the game runs
      return { ...state, game: action.state, startsAt: null };
    case 'finished':
      return { ...state, finished: { result: action.result, ratings: action.ratings } };
  }
}
