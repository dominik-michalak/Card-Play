import type { GameEvent, GameKey, GameState, ServerGameModule } from '@cardplay/shared';
import { eliminatePlayer, macaoModule, type MacaoState } from '../games/macao/macao';
import { forfeitWar, resolveFlipTimeout, warModule, type WarState } from '../games/war/war';

export type GameStep = { newState: GameState; events: GameEvent[] };
export type ForfeitReason = 'timeout_forfeit' | 'disconnect_forfeit';

// what the runner needs from a game beyond the shared module contract
export type RunnerGame = {
  module: ServerGameModule;
  // players still in the game (not eliminated)
  activePlayerIds(state: GameState): string[];
  // the decision window ran out (not a player action)
  resolveTimeout(state: GameState): GameStep;
  // the player left for good: a two-player game ends, a bigger one goes on without them
  forfeit(state: GameState, playerId: string, reason: ForfeitReason): GameStep;
  // whether these events start a fresh decision window
  startsNewWindow(events: GameEvent[]): boolean;
};

// modules are typed with their own state; the registry erases that, because the runner only
// ever hands a module the state it created
const war: RunnerGame = {
  module: warModule as unknown as ServerGameModule,
  activePlayerIds: (state) => state.players.map((p) => p.id),
  resolveTimeout: (state) => ({ newState: resolveFlipTimeout(state as WarState), events: [] }),
  forfeit: (state, playerId, reason) => ({
    newState: forfeitWar(state as WarState, playerId, reason),
    events: [],
  }),
  startsNewWindow: (events) => events.some((event) => event.type === 'round_resolved'),
};

const macao: RunnerGame = {
  module: macaoModule as unknown as ServerGameModule,
  activePlayerIds: (state) =>
    state.players.filter((_, seat) => !(state as MacaoState).eliminated[seat]).map((p) => p.id),
  // only the player whose turn it is has a window to miss
  resolveTimeout: (state) =>
    eliminatePlayer(state as MacaoState, state.currentPlayerId!, 'timeout_forfeit'),
  forfeit: (state, playerId, reason) => eliminatePlayer(state as MacaoState, playerId, reason),
  startsNewWindow: (events) => events.some((event) => event.type === 'turn_started'),
};

export const GAME_REGISTRY: Partial<Record<GameKey, RunnerGame>> = { war, macao };
