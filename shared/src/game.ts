export const GAME_KEYS = ['war', 'macao', 'texas_clinch', 'poker'] as const;
export type GameKey = (typeof GAME_KEYS)[number];

// min/max players per game, from the project plan
export const GAME_PLAYER_LIMITS: Record<GameKey, { min: number; max: number }> = {
  war: { min: 2, max: 2 },
  macao: { min: 2, max: 4 },
  texas_clinch: { min: 2, max: 4 },
  poker: { min: 2, max: 6 },
};

export type GamePlayer = {
  id: string;
  username: string;
  isBot: boolean;
};

// action type and payload are game specific; applyAction validates them
export type GameAction = { type: string; payload?: unknown };

// narrated fact for clients, e.g. "round won"
export type GameEvent = { type: string; data?: unknown };

// full server-side state, never sent to clients as is
export type GameState = {
  gameKey: GameKey;
  players: GamePlayer[];
  currentPlayerId: string | null;
};

// per-recipient view produced by sanitize
export type ClientGameState = {
  gameKey: GameKey;
  players: GamePlayer[];
  currentPlayerId: string | null;
  // ISO time the current decision window ends, null while paused; filled by the room runner
  turnDeadlineAt: string | null;
};

export const TERMINATION_REASONS = [
  'all_cards',
  'round_limit',
  'turn_limit',
  'timeout_forfeit',
  'disconnect_forfeit',
  'double_timeout',
  'draw',
  'cancelled',
  'completed',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

// rank 1 = best; equal ranks mean a tie, all rank 1 means a draw
export type Placement = { playerId: string; rank: number };

export type GameResult = { placements: Placement[]; terminationReason: TerminationReason };

// returns floats in [0, 1), injected so shuffling stays testable
export type RandomSource = () => number;

export type ServerGameModule<
  S extends GameState = GameState,
  C extends ClientGameState = ClientGameState,
> = {
  key: GameKey;
  createInitialState(players: GamePlayer[], random: RandomSource): S;
  applyAction(state: S, action: GameAction, playerId: string): { newState: S; events: GameEvent[] };
  isTerminal(state: S): boolean;
  getResult(state: S): GameResult;
  sanitize(state: S, recipientId: string): C;
};

// Elo movement of one player after a rated game
export type RatingChange = { userId: string; eloBefore: number; eloChange: number };
