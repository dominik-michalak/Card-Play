import {
  GameRuleError,
  type ClientGameState,
  type GameAction,
  type GameEvent,
  type GameKey,
  type GamePlayer,
  type GameResult,
  type GameState,
  type RandomSource,
  type RatingChange,
} from '@cardplay/shared';
import { HttpError } from '../http-error';
import { secureRandom } from '../games/random';
import type { ResultsService } from '../modules/results/results.service';
import { GAME_REGISTRY, type RunnerGame } from './game-registry';
import type { Timings } from './timings';

// where the runner sends what players must see; the socket layer implements it
export type GameSink = {
  state(roomId: string, userId: string, state: ClientGameState): void;
  event(roomId: string, event: GameEvent): void;
  finished(roomId: string, result: GameResult, ratings: RatingChange[]): void;
};

export type GameRunnerOptions = {
  results: ResultsService;
  sink: GameSink;
  timings: Timings;
  random?: RandomSource;
};

type ActiveGame = {
  roomId: string;
  recordId: string;
  definition: RunnerGame;
  state: GameState;
  playerIds: string[];
  // players whose socket is attached to the room right now
  connected: Set<string>;
  // end of the decision window, null while the game is paused
  deadlineAt: number | null;
  deadlineTimer: NodeJS.Timeout | null;
  forfeitTimers: Map<string, NodeJS.Timeout>;
  botTimers: Map<string, NodeJS.Timeout>;
  // actions and timers of one game run one after another
  queue: Promise<unknown>;
  finished: boolean;
};

// runs the live games: applies actions, keeps the decision window, pauses on disconnects
export function createGameRunner(options: GameRunnerOptions) {
  const { results, sink, timings } = options;
  const random = options.random ?? secureRandom;
  const games = new Map<string, ActiveGame>();

  function exclusive<T>(game: ActiveGame, task: () => Promise<T>): Promise<T> {
    const run = game.queue.then(task);
    game.queue = run.catch(() => undefined);
    return run;
  }

  function background(game: ActiveGame, task: () => Promise<void>): void {
    exclusive(game, task).catch((error: unknown) => console.error(error));
  }

  const activeIds = (game: ActiveGame): string[] => game.definition.activePlayerIds(game.state);
  const everyoneActiveIsBack = (game: ActiveGame): boolean =>
    activeIds(game).every((id) => game.connected.has(id));
  const botIds = (game: ActiveGame): string[] =>
    game.state.players.filter((p) => p.isBot).map((p) => p.id);

  // a bot answers a moment after the table changes, and only when it has something to do
  function scheduleBots(game: ActiveGame): void {
    for (const botId of botIds(game)) {
      if (game.finished || game.botTimers.has(botId)) continue;
      if (!game.definition.botAction(game.state, botId)) continue;
      const timer = setTimeout(() => {
        game.botTimers.delete(botId);
        background(game, () => runBot(game, botId));
      }, timings.botDelayMs);
      timer.unref();
      game.botTimers.set(botId, timer);
    }
  }

  // decides on the state as it is now; a paused game resumes through broadcastState
  async function runBot(game: ActiveGame, botId: string): Promise<void> {
    if (game.finished || !everyoneActiveIsBack(game)) return;
    const action = game.definition.botAction(game.state, botId);
    if (!action) return;
    const { newState, events } = game.definition.module.applyAction(game.state, action, botId);
    await settle(game, newState, events);
  }

  function broadcastState(game: ActiveGame): void {
    const turnDeadlineAt =
      game.deadlineAt === null ? null : new Date(game.deadlineAt).toISOString();
    const bots = botIds(game);
    for (const userId of game.playerIds) {
      if (bots.includes(userId)) continue; // bots have no socket
      const view = game.definition.module.sanitize(game.state, userId);
      sink.state(game.roomId, userId, { ...view, turnDeadlineAt });
    }
    scheduleBots(game);
  }

  function clearDeadline(game: ActiveGame): void {
    if (game.deadlineTimer) {
      clearTimeout(game.deadlineTimer);
    }
    game.deadlineTimer = null;
    game.deadlineAt = null;
  }

  // a full window starts; while someone is away the game stays paused instead
  function restartDeadline(game: ActiveGame): void {
    clearDeadline(game);
    if (!everyoneActiveIsBack(game)) {
      return;
    }
    game.deadlineAt = Date.now() + timings.turnMs;
    game.deadlineTimer = setTimeout(() => background(game, () => onDeadline(game)), timings.turnMs);
    game.deadlineTimer.unref();
  }

  async function onDeadline(game: ActiveGame): Promise<void> {
    if (game.finished) {
      return;
    }
    const step = game.definition.resolveTimeout(game.state);
    await settle(game, step.newState, step.events);
  }

  async function finish(
    game: ActiveGame,
    result: GameResult,
    finalState: GameState,
  ): Promise<void> {
    game.finished = true;
    clearDeadline(game);
    for (const timer of game.forfeitTimers.values()) {
      clearTimeout(timer);
    }
    game.forfeitTimers.clear();
    game.botTimers.forEach((timer) => clearTimeout(timer));
    game.botTimers.clear();
    games.delete(game.roomId);
    const outcome = await results.finishGame(game.recordId, result, finalState);
    sink.finished(game.roomId, result, outcome.ratings);
  }

  // applies a module step; a terminal state ends the game
  async function settle(game: ActiveGame, newState: GameState, events: GameEvent[]): Promise<void> {
    for (const event of events) {
      sink.event(game.roomId, event);
    }
    game.state = newState;
    if (game.definition.module.isTerminal(newState)) {
      broadcastState(game);
      await finish(game, game.definition.module.getResult(newState), newState);
      return;
    }
    if (game.definition.startsNewWindow(events) || game.deadlineAt === null) {
      restartDeadline(game);
    }
    broadcastState(game);
  }

  async function onForfeitTimer(game: ActiveGame, userId: string): Promise<void> {
    game.forfeitTimers.delete(userId);
    const active = activeIds(game);
    if (game.finished || game.connected.has(userId) || !active.includes(userId)) {
      return;
    }
    if (active.every((id) => !game.connected.has(id))) {
      await finish(game, { terminationReason: 'cancelled', placements: [] }, game.state);
      return;
    }
    const step = game.definition.forfeit(game.state, userId, 'disconnect_forfeit');
    await settle(game, step.newState, step.events);
  }

  function markAway(game: ActiveGame, userId: string): void {
    game.connected.delete(userId);
    clearDeadline(game);
    if (!game.forfeitTimers.has(userId)) {
      const timer = setTimeout(
        () => background(game, () => onForfeitTimer(game, userId)),
        timings.disconnectMs,
      );
      timer.unref();
      game.forfeitTimers.set(userId, timer);
    }
  }

  async function start(
    roomId: string,
    gameKey: GameKey,
    players: GamePlayer[],
    attachedIds: string[],
  ): Promise<void> {
    const definition = GAME_REGISTRY[gameKey];
    if (!definition) {
      throw new HttpError(409, 'GAME_RULES_NOT_DEFINED', 'the rules of this game are not defined');
    }
    const state = definition.module.createInitialState(players, random);
    const recordId = await results.startGame(roomId, state);
    const game: ActiveGame = {
      roomId,
      recordId,
      definition,
      state,
      playerIds: players.map((p) => p.id),
      // bots are always present
      connected: new Set([...attachedIds, ...players.filter((p) => p.isBot).map((p) => p.id)]),
      deadlineAt: null,
      deadlineTimer: null,
      forfeitTimers: new Map(),
      botTimers: new Map(),
      queue: Promise.resolve(),
      finished: false,
    };
    games.set(roomId, game);
    for (const userId of game.playerIds.filter((id) => !game.connected.has(id))) {
      markAway(game, userId);
    }
    restartDeadline(game);
    broadcastState(game);
  }

  function applyAction(roomId: string, userId: string, action: GameAction): Promise<void> {
    const game = games.get(roomId);
    if (!game?.playerIds.includes(userId)) {
      throw new HttpError(404, 'ROOM_NOT_FOUND', 'room not found');
    }
    return exclusive(game, async () => {
      if (game.finished) {
        throw new GameRuleError('GAME_OVER', 'the game is already finished');
      }
      if (!everyoneActiveIsBack(game)) {
        throw new GameRuleError('INVALID_ACTION', 'the game is paused until everyone is back');
      }
      const { newState, events } = game.definition.module.applyAction(game.state, action, userId);
      await settle(game, newState, events);
    });
  }

  function playerDisconnected(roomId: string, userId: string): Promise<void> {
    const game = games.get(roomId);
    if (!game?.playerIds.includes(userId)) {
      return Promise.resolve();
    }
    return exclusive(game, async () => {
      if (game.finished || !game.connected.has(userId)) {
        return;
      }
      game.connected.delete(userId);
      // an eliminated player is not missed
      if (activeIds(game).includes(userId)) markAway(game, userId);
      broadcastState(game);
    });
  }

  // the game resumes with a full window once everybody is back
  function playerReconnected(roomId: string, userId: string): Promise<void> {
    const game = games.get(roomId);
    if (!game?.playerIds.includes(userId)) {
      return Promise.resolve();
    }
    return exclusive(game, async () => {
      if (game.finished) {
        return;
      }
      const timer = game.forfeitTimers.get(userId);
      if (timer) {
        clearTimeout(timer);
        game.forfeitTimers.delete(userId);
      }
      game.connected.add(userId);
      if (game.deadlineAt === null) {
        restartDeadline(game);
      }
      broadcastState(game);
    });
  }

  function dispose(): void {
    for (const game of games.values()) {
      clearDeadline(game);
      game.forfeitTimers.forEach((timer) => clearTimeout(timer));
      game.forfeitTimers.clear();
      game.botTimers.forEach((timer) => clearTimeout(timer));
      game.botTimers.clear();
    }
    games.clear();
  }

  return {
    start,
    applyAction,
    playerDisconnected,
    playerReconnected,
    has: (roomId: string): boolean => games.has(roomId),
    dispose,
  };
}

export type GameRunner = ReturnType<typeof createGameRunner>;
