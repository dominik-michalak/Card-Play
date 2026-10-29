import {
  GameRuleError,
  RANKS,
  WAR_FACE_DOWN_CARDS,
  WAR_MAX_ROUNDS,
  type Card,
  type ClientWarState,
  type Deck,
  type GameAction,
  type GameEvent,
  type GamePlayer,
  type GameResult,
  type GameState,
  type RandomSource,
  type ServerGameModule,
  type TerminationReason,
  type WarRoundSummary,
} from '@cardplay/shared';
import { createDeck, shuffle } from '../deck';

// Seat index = position in `players`. Stack index 0 is the top, the end is the bottom.
export type WarState = GameState & {
  gameKey: 'war';
  stacks: [Deck, Deck];
  // who confirmed the current round; reset after the round is resolved
  flipped: [boolean, boolean];
  // completed rounds (a war belongs to the round that started it)
  round: number;
  lastRound: WarRoundSummary | null;
  result: GameResult | null;
};

type Seat = 0 | 1;

const rankValue = (card: Card): number => RANKS.indexOf(card.rank);

function take(stack: Deck): Card {
  const card = stack.shift();
  if (!card) throw new Error('war invariant broken: took a card from an empty stack');
  return card;
}

function makeResult(
  players: GamePlayer[],
  winnerSeat: Seat | null,
  terminationReason: TerminationReason,
): GameResult {
  return {
    terminationReason,
    placements: players.map((player, seat) => ({
      playerId: player.id,
      rank: winnerSeat === null || winnerSeat === seat ? 1 : 2,
    })),
  };
}

// the player with more cards wins; equal sizes are a draw
function resultBySize(
  players: GamePlayer[],
  sizes: [number, number],
  reason: TerminationReason,
): GameResult {
  if (sizes[0] === sizes[1]) return makeResult(players, null, reason);
  return makeResult(players, sizes[0] > sizes[1] ? 0 : 1, reason);
}

// Builds a state from ready stacks. Tests use it to set up exact scenarios.
export function createWarStateFromStacks(players: GamePlayer[], stacks: [Deck, Deck]): WarState {
  if (players.length !== 2 || players[0]!.id === players[1]!.id) {
    throw new Error('war needs exactly two different players');
  }
  return {
    gameKey: 'war',
    players,
    currentPlayerId: null,
    stacks: [[...stacks[0]], [...stacks[1]]],
    flipped: [false, false],
    round: 0,
    lastRound: null,
    result: null,
  };
}

// Deals an already ordered deck, one card at a time, seat 0 first.
export function createWarState(players: GamePlayer[], deck: Deck): WarState {
  if (deck.length !== 52) throw new Error('war needs a deck of 52 cards');
  const stacks: [Deck, Deck] = [[], []];
  deck.forEach((card, index) => stacks[index % 2]!.push(card));
  return createWarStateFromStacks(players, stacks);
}

function createInitialState(players: GamePlayer[], random: RandomSource): WarState {
  return createWarState(players, shuffle(createDeck(), random));
}

function resolveRound(state: WarState): { newState: WarState; summary: WarRoundSummary } {
  const stacks: [Deck, Deck] = [[...state.stacks[0]], [...state.stacks[1]]];
  const pool: Card[] = [];
  const comparisons: [Card, Card][] = [];
  const round = state.round + 1;

  // every card goes to the table in the same order the rules use for the winning pool:
  // the lower seat first, then the other one
  const dealToTable = (): [Card, Card] => {
    const pair: [Card, Card] = [take(stacks[0]), take(stacks[1])];
    pool.push(pair[0], pair[1]);
    return pair;
  };
  const revealPair = (): number => {
    const pair = dealToTable();
    comparisons.push(pair);
    return rankValue(pair[0]) - rankValue(pair[1]);
  };

  let difference = revealPair();
  while (difference === 0) {
    if (stacks[0].length < WAR_FACE_DOWN_CARDS + 1 || stacks[1].length < WAR_FACE_DOWN_CARDS + 1) {
      // no rescue by the last card: the player who cannot fight a war loses
      const short = stacks.map((stack) => stack.length < WAR_FACE_DOWN_CARDS + 1);
      const sizes: [number, number] = [stacks[0].length, stacks[1].length];
      const result =
        short[0] && short[1]
          ? resultBySize(state.players, sizes, sizes[0] === sizes[1] ? 'draw' : 'all_cards')
          : makeResult(state.players, short[0] ? 1 : 0, 'all_cards');
      const summary: WarRoundSummary = {
        round,
        comparisons,
        winnerId: null,
        poolSize: pool.length,
      };
      return {
        newState: { ...state, stacks, round, lastRound: summary, result },
        summary,
      };
    }
    for (let i = 0; i < WAR_FACE_DOWN_CARDS; i++) dealToTable();
    difference = revealPair();
  }

  const winnerSeat: Seat = difference > 0 ? 0 : 1;
  stacks[winnerSeat].push(...pool);

  const summary: WarRoundSummary = {
    round,
    comparisons,
    winnerId: state.players[winnerSeat]!.id,
    poolSize: pool.length,
  };

  let result: GameResult | null = null;
  if (stacks[0].length === 0 || stacks[1].length === 0) {
    result = makeResult(state.players, stacks[0].length === 0 ? 1 : 0, 'all_cards');
  } else if (round >= WAR_MAX_ROUNDS) {
    result = resultBySize(state.players, [stacks[0].length, stacks[1].length], 'round_limit');
  }

  return { newState: { ...state, stacks, round, lastRound: summary, result }, summary };
}

function applyAction(
  state: WarState,
  action: GameAction,
  playerId: string,
): { newState: WarState; events: GameEvent[] } {
  if (state.result) throw new GameRuleError('GAME_OVER', 'the game is already finished');

  const seat = state.players.findIndex((player) => player.id === playerId);
  if (seat === -1) throw new GameRuleError('INVALID_ACTION', 'you are not a player in this game');
  if (action.type !== 'flip') {
    throw new GameRuleError('INVALID_ACTION', `unknown action "${action.type}"`);
  }
  if (state.flipped[seat]) {
    throw new GameRuleError('INVALID_ACTION', 'you already flipped in this round');
  }

  const flipped: [boolean, boolean] = [...state.flipped];
  flipped[seat] = true;
  const events: GameEvent[] = [{ type: 'flip_accepted', data: { playerId } }];

  if (!flipped[0] || !flipped[1]) return { newState: { ...state, flipped }, events };

  const { newState, summary } = resolveRound({ ...state, flipped: [false, false] });
  events.push({ type: 'round_resolved', data: summary });
  return { newState, events };
}

// The 30 s flip timer lives outside the engine. When it runs out, the room calls this:
// one missing flip is a forfeit, no flips at all is a double timeout.
// It is not a player action, so clients cannot trigger it.
export function resolveFlipTimeout(state: WarState): WarState {
  if (state.result) throw new GameRuleError('GAME_OVER', 'the game is already finished');
  const [first, second] = state.flipped;
  const result =
    first === second
      ? makeResult(state.players, null, 'double_timeout')
      : makeResult(state.players, first ? 0 : 1, 'timeout_forfeit');
  return { ...state, result };
}

function isTerminal(state: WarState): boolean {
  return state.result !== null;
}

function getResult(state: WarState): GameResult {
  if (!state.result) throw new Error('the game is not finished yet');
  return state.result;
}

function sanitize(state: WarState, _recipientId: string): ClientWarState {
  return {
    gameKey: 'war',
    players: state.players,
    currentPlayerId: null,
    turnDeadlineAt: null,
    stackSizes: Object.fromEntries(
      state.players.map((player, seat) => [player.id, state.stacks[seat]!.length]),
    ),
    round: state.round,
    flippedPlayerIds: state.players.filter((_, seat) => state.flipped[seat]).map((p) => p.id),
    lastRound: state.lastRound,
    result: state.result,
  };
}

export const warModule: ServerGameModule<WarState, ClientWarState> = {
  key: 'war',
  createInitialState,
  applyAction,
  isTerminal,
  getResult,
  sanitize,
};
