import type { GameAction, GameEvent, GameKey, GameState, ServerGameModule } from '@cardplay/shared';
import { HttpError } from '../http-error';
import { chooseMacaoAction, chooseWarAction } from '../bots/bots';
import { eliminatePlayer, macaoModule, type MacaoState } from '../games/macao/macao';
import {
  eliminatePlayer as eliminatePokerPlayer,
  pokerModule,
  type PokerState,
} from '../games/poker/poker';
import { texasClinchModule } from '../games/texas-clinch/texas-clinch';
import { forfeitWar, resolveFlipTimeout, warModule, type WarState } from '../games/war/war';

export type GameStep = { newState: GameState; events: GameEvent[] };
export type ForfeitReason = 'timeout_forfeit' | 'disconnect_forfeit';

// what the runner needs from a game beyond the shared module contract
export type RunnerGame = {
  module: ServerGameModule;
  // false for a game that is listed but cannot be played yet
  rulesDefined: boolean;
  // players still in the game (not eliminated)
  activePlayerIds(state: GameState): string[];
  // the decision window ran out (not a player action)
  resolveTimeout(state: GameState): GameStep;
  // the player left for good: a two-player game ends, a bigger one goes on without them
  forfeit(state: GameState, playerId: string, reason: ForfeitReason): GameStep;
  // whether these events start a fresh decision window
  startsNewWindow(events: GameEvent[]): boolean;
  // what the bot does now, or null when it has nothing to do
  botAction(state: GameState, botId: string): GameAction | null;
};

// modules are typed with their own state; the registry erases that, because the runner only
// ever hands a module the state it created
const war: RunnerGame = {
  module: warModule as unknown as ServerGameModule,
  rulesDefined: true,
  activePlayerIds: (state) => state.players.map((p) => p.id),
  resolveTimeout: (state) => ({ newState: resolveFlipTimeout(state as WarState), events: [] }),
  forfeit: (state, playerId, reason) => ({
    newState: forfeitWar(state as WarState, playerId, reason),
    events: [],
  }),
  startsNewWindow: (events) => events.some((event) => event.type === 'round_resolved'),
  botAction: (state, botId) => chooseWarAction(state as WarState, botId),
};

const macao: RunnerGame = {
  module: macaoModule as unknown as ServerGameModule,
  rulesDefined: true,
  activePlayerIds: (state) =>
    state.players.filter((_, seat) => !(state as MacaoState).eliminated[seat]).map((p) => p.id),
  // only the player whose turn it is has a window to miss
  resolveTimeout: (state) =>
    eliminatePlayer(state as MacaoState, state.currentPlayerId!, 'timeout_forfeit'),
  forfeit: (state, playerId, reason) => eliminatePlayer(state as MacaoState, playerId, reason),
  startsNewWindow: (events) => events.some((event) => event.type === 'turn_started'),
  botAction: (state, botId) => chooseMacaoAction(state as MacaoState, botId),
};

const poker: RunnerGame = {
  module: pokerModule as unknown as ServerGameModule,
  rulesDefined: true,
  // a player who forfeited is folded already and must not hold the table
  activePlayerIds: (state) => {
    const { out, leaving } = state as PokerState;
    return state.players.filter((_, seat) => !out[seat] && !leaving[seat]).map((p) => p.id);
  },
  resolveTimeout: (state) =>
    eliminatePokerPlayer(state as PokerState, state.currentPlayerId!, 'timeout_forfeit'),
  forfeit: (state, playerId, reason) => eliminatePokerPlayer(state as PokerState, playerId, reason),
  startsNewWindow: (events) => events.some((event) => event.type === 'turn_started'),
  botAction: () => null,
};

// visible in the lobby, but starting it is refused until the rules are approved
const texasClinch: RunnerGame = {
  module: texasClinchModule,
  rulesDefined: false,
  activePlayerIds: () => [],
  resolveTimeout: () => notDefined(),
  forfeit: () => notDefined(),
  startsNewWindow: () => false,
  botAction: () => null,
};

function notDefined(): never {
  throw new HttpError(409, 'GAME_RULES_NOT_DEFINED', 'the rules of this game are not defined');
}

export const GAME_REGISTRY: Partial<Record<GameKey, RunnerGame>> = {
  war,
  macao,
  poker,
  texas_clinch: texasClinch,
};
