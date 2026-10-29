import type { GameEvent, GameKey, GameState, ServerGameModule } from '@cardplay/shared';
import { resolveFlipTimeout, warModule, type WarState } from '../games/war/war';

// what the runner needs from a game beyond the shared module contract
export type RunnerGame = {
  module: ServerGameModule;
  // state after the decision window ran out (not a player action)
  resolveTimeout(state: GameState): GameState;
  // whether these events start a fresh decision window
  startsNewWindow(events: GameEvent[]): boolean;
};

// modules are typed with their own state; the registry erases that, because the runner only
// ever hands a module the state it created
const war: RunnerGame = {
  module: warModule as unknown as ServerGameModule,
  resolveTimeout: (state) => resolveFlipTimeout(state as WarState),
  startsNewWindow: (events) => events.some((event) => event.type === 'round_resolved'),
};

export const GAME_REGISTRY: Partial<Record<GameKey, RunnerGame>> = { war };
