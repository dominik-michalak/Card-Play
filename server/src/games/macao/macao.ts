import {
  GameRuleError,
  MACAO_HAND_SIZE,
  MACAO_MAX_TURNS,
  MACAO_REPORT_PENALTY,
  MACAO_REQUESTABLE_RANKS,
  RANKS,
  SUITS,
  type Card,
  type ClientMacaoState,
  type Deck,
  type GameAction,
  type GameEvent,
  type GamePlayer,
  type GameResult,
  type GameState,
  type MacaoPenalty,
  type MacaoPlayPayload,
  type MacaoRequest,
  type RandomSource,
  type ServerGameModule,
  type TerminationReason,
} from '@cardplay/shared';
import { createDeck, shuffle } from '../deck';
import { shuffleWithState } from '../rng';

// The state is private to the server. Seat = index in `players`; discard[last] is the top card,
// drawPile[0] the top of the draw pile.
export type MacaoState = GameState & {
  gameKey: 'macao';
  hands: Deck[];
  drawPile: Deck;
  discard: Deck;
  // seat that moves next
  current: number;
  // applies to `current`
  penalty: MacaoPenalty | null;
  // turns each seat still has to lose
  skips: number[];
  // binds the first player who really gets to move
  request: MacaoRequest | null;
  // card the current player just drew and may still play
  drawn: Card | null;
  eliminated: boolean[];
  // seat that reached one card without declaring, until the next accepted move
  reportable: number | null;
  turn: number;
  // generator state for reshuffling; never sent to clients
  rngState: number;
  result: GameResult | null;
};

const FUNCTION_RANKS = new Set(['2', '3', '4', 'J', 'A']);

const sameCard = (a: Card, b: Card): boolean => a.rank === b.rank && a.suit === b.suit;
const invalid = (message: string) => new GameRuleError('INVALID_ACTION', message);

function copyState(state: MacaoState): MacaoState {
  return {
    ...state,
    hands: state.hands.map((hand) => [...hand]),
    drawPile: [...state.drawPile],
    discard: [...state.discard],
    skips: [...state.skips],
    eliminated: [...state.eliminated],
    penalty: state.penalty && { ...state.penalty },
  };
}

function topCard(state: MacaoState): Card {
  return state.discard[state.discard.length - 1]!;
}

// suit or rank of the top card, or the active request instead of it
function matchesTable(state: MacaoState, card: Card): boolean {
  if (state.request) {
    return 'rank' in state.request
      ? card.rank === state.request.rank
      : card.suit === state.request.suit;
  }
  const top = topCard(state);
  return card.suit === top.suit || card.rank === top.rank;
}

// an active penalty can only be answered with its own cards; a drawn card is the only one playable
function isPlayable(state: MacaoState, card: Card): boolean {
  if (state.penalty?.kind === 'draw') return card.rank === '2' || card.rank === '3';
  if (state.penalty?.kind === 'skip') return card.rank === '4';
  if (state.drawn) return sameCard(card, state.drawn) && matchesTable(state, card);
  return matchesTable(state, card);
}

function nextSeat(state: MacaoState, from: number): number {
  const count = state.players.length;
  for (let step = 1; step <= count; step++) {
    const seat = (from + step) % count;
    if (!state.eliminated[seat]) return seat;
  }
  return from;
}

function makeResult(
  state: MacaoState,
  winnerSeat: number | null,
  terminationReason: TerminationReason,
): GameResult {
  return {
    terminationReason,
    placements: state.players.map((player, seat) => ({
      playerId: player.id,
      rank: winnerSeat === null || winnerSeat === seat ? 1 : 2,
    })),
  };
}

function finishByTurnLimit(state: MacaoState): void {
  const active = state.players.map((_, seat) => seat).filter((seat) => !state.eliminated[seat]);
  const fewest = Math.min(...active.map((seat) => state.hands[seat]!.length));
  const leaders = active.filter((seat) => state.hands[seat]!.length === fewest);
  state.result = makeResult(state, leaders.length === 1 ? leaders[0]! : null, 'turn_limit');
}

// keeps the top card, shuffles the rest of the discard pile into a new draw pile
function reshuffle(state: MacaoState, events: GameEvent[]): void {
  if (state.discard.length <= 1) return;
  const top = state.discard.pop()!;
  const shuffled = shuffleWithState(state.discard, state.rngState);
  state.drawPile = shuffled.deck;
  state.rngState = shuffled.state;
  state.discard = [top];
  events.push({ type: 'deck_reshuffled' });
}

// draws as many cards as exist, possibly none
function drawCards(state: MacaoState, seat: number, count: number, events: GameEvent[]): number {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) reshuffle(state, events);
    const card = state.drawPile.shift();
    if (!card) break;
    state.hands[seat]!.push(card);
    drawn++;
  }
  if (drawn > 0) {
    events.push({ type: 'cards_drawn', data: { playerId: state.players[seat]!.id, count: drawn } });
  }
  return drawn;
}

// every turn counts: played, skipped, automatic; the limit ends the game
function endTurn(state: MacaoState): void {
  state.turn++;
  if (state.turn >= MACAO_MAX_TURNS) {
    finishByTurnLimit(state);
    return;
  }
  state.current = nextSeat(state, state.current);
}

function takeDrawPenalty(state: MacaoState, seat: number, events: GameEvent[]): void {
  const penalty = state.penalty!;
  drawCards(state, seat, penalty.amount, events);
  events.push({
    type: 'penalty_taken',
    data: { playerId: state.players[seat]!.id, kind: 'draw', amount: penalty.amount },
  });
  state.penalty = null;
  state.request = null;
}

// the player loses this turn and `amount - 1` more
function takeSkipPenalty(state: MacaoState, seat: number, events: GameEvent[]): void {
  const penalty = state.penalty!;
  state.skips[seat]! += penalty.amount - 1;
  events.push({
    type: 'penalty_taken',
    data: { playerId: state.players[seat]!.id, kind: 'skip', amount: penalty.amount },
  });
  state.penalty = null;
  state.request = null;
}

function playCard(
  state: MacaoState,
  seat: number,
  card: Card,
  request: MacaoRequest | undefined,
  declaredMacao: boolean,
  events: GameEvent[],
): void {
  const hand = state.hands[seat]!;
  hand.splice(
    hand.findIndex((c) => sameCard(c, card)),
    1,
  );
  state.discard.push(card);
  state.drawn = null;
  events.push({
    type: 'card_played',
    data: { playerId: state.players[seat]!.id, card, request: request ?? null },
  });

  // the last card wins on the spot; its effect is not carried out
  if (hand.length === 0) {
    state.penalty = null;
    state.request = null;
    state.result = makeResult(state, seat, 'completed');
    return;
  }

  const drawStack = state.penalty?.kind === 'draw' ? state.penalty.amount : 0;
  const skipStack = state.penalty?.kind === 'skip' ? state.penalty.amount : 0;
  state.penalty = null;
  state.request = null;
  if (card.rank === '2') state.penalty = { kind: 'draw', amount: drawStack + 2 };
  if (card.rank === '3') state.penalty = { kind: 'draw', amount: drawStack + 3 };
  if (card.rank === '4') state.penalty = { kind: 'skip', amount: skipStack + 1 };
  if (card.rank === 'J' || card.rank === 'A') state.request = request ?? null;

  if (hand.length === 1 && !declaredMacao) state.reportable = seat;
  endTurn(state);
}

// Moves play on until a player has a real choice: lost turns, penalties without a defence and
// moves with no legal card are carried out by the server.
function advance(state: MacaoState, events: GameEvent[], announce: boolean): void {
  const turnAtStart = state.turn;
  while (!state.result) {
    const seat = state.current;
    const hand = state.hands[seat]!;

    if (state.skips[seat]! > 0) {
      state.skips[seat]!--;
      events.push({ type: 'turn_skipped', data: { playerId: state.players[seat]!.id } });
      endTurn(state);
      continue;
    }
    if (state.penalty?.kind === 'draw') {
      if (hand.some((c) => c.rank === '2' || c.rank === '3')) break;
      takeDrawPenalty(state, seat, events);
      endTurn(state);
      continue;
    }
    if (state.penalty?.kind === 'skip') {
      if (hand.some((c) => c.rank === '4')) break;
      takeSkipPenalty(state, seat, events);
      endTurn(state);
      continue;
    }
    if (state.drawn || hand.some((c) => matchesTable(state, c))) break;

    // no legal card: draw one and play it if it fits
    if (drawCards(state, seat, 1, events) === 0) {
      state.request = null;
      endTurn(state);
      continue;
    }
    const drawn = hand[hand.length - 1]!;
    if (!matchesTable(state, drawn)) {
      state.request = null;
      endTurn(state);
    } else if (drawn.rank === 'J' || drawn.rank === 'A') {
      state.drawn = drawn; // needs a request, so the player has to choose
      break;
    } else {
      playCard(state, seat, drawn, undefined, true, events);
    }
  }
  if (!state.result && (announce || state.turn !== turnAtStart)) {
    events.push({ type: 'turn_started', data: { playerId: state.players[state.current]!.id } });
  }
}

function finalize(state: MacaoState): MacaoState {
  return { ...state, currentPlayerId: state.result ? null : state.players[state.current]!.id };
}

function parsePlay(payload: unknown): MacaoPlayPayload {
  const value = (payload ?? {}) as Record<string, unknown>;
  const card = value.card as Record<string, unknown> | undefined;
  const validCard =
    card && SUITS.some((suit) => suit === card.suit) && RANKS.some((rank) => rank === card.rank);
  if (!validCard) throw invalid('play needs a card');
  if (value.declaredMacao !== undefined && typeof value.declaredMacao !== 'boolean') {
    throw invalid('declaredMacao must be true or false');
  }
  return {
    card: { suit: card.suit, rank: card.rank } as Card,
    request: value.request as MacaoRequest | undefined,
    declaredMacao: value.declaredMacao as boolean | undefined,
  };
}

// a Jack asks for a rank from 5 to 10, an Ace for a suit; other cards ask for nothing
function checkRequest(card: Card, request: MacaoRequest | undefined): MacaoRequest | undefined {
  if (card.rank === 'J') {
    const rank = request && 'rank' in request ? request.rank : undefined;
    if (!MACAO_REQUESTABLE_RANKS.some((allowed) => allowed === rank)) {
      throw invalid('a Jack must request a rank from 5 to 10');
    }
    return { rank: rank! };
  }
  if (card.rank === 'A') {
    const suit = request && 'suit' in request ? request.suit : undefined;
    if (!SUITS.some((allowed) => allowed === suit)) throw invalid('an Ace must request a suit');
    return { suit: suit! };
  }
  if (request !== undefined) throw invalid('only a Jack or an Ace can make a request');
  return undefined;
}

function createMacaoState(
  players: GamePlayer[],
  parts: Pick<MacaoState, 'hands' | 'drawPile' | 'discard' | 'rngState'>,
): MacaoState {
  return finalize({
    gameKey: 'macao',
    players,
    currentPlayerId: null,
    ...parts,
    current: 0,
    penalty: null,
    skips: players.map(() => 0),
    request: null,
    drawn: null,
    eliminated: players.map(() => false),
    reportable: null,
    turn: 0,
    result: null,
  });
}

// exact state for tests (no dealing and no automatic moves)
export function createMacaoStateFrom(
  players: GamePlayer[],
  parts: Pick<MacaoState, 'hands' | 'drawPile' | 'discard'> &
    Partial<Omit<MacaoState, 'gameKey' | 'players' | 'currentPlayerId'>>,
): MacaoState {
  const base = createMacaoState(players, { rngState: 1, ...parts });
  const { hands, drawPile, discard, ...overrides } = parts;
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return finalize({ ...base, hands, drawPile, discard, ...defined });
}

function createInitialState(players: GamePlayer[], random: RandomSource): MacaoState {
  if (players.length < 2 || players.length > 4) {
    throw new Error('Macao needs 2 to 4 players');
  }
  const deck = shuffle(createDeck(), random);
  const hands: Deck[] = players.map(() => []);
  for (let round = 0; round < MACAO_HAND_SIZE; round++) {
    for (const hand of hands) hand.push(deck.shift()!);
  }
  // the first discard is an ordinary card; function cards drawn on the way go back and the
  // pile is shuffled again
  const setAside: Deck = [];
  let first: Card | undefined;
  while (!first) {
    const card = deck.shift()!;
    if (FUNCTION_RANKS.has(card.rank)) setAside.push(card);
    else first = card;
  }
  const state = createMacaoState(players, {
    hands,
    drawPile: shuffle([...deck, ...setAside], random),
    discard: [first],
    rngState: Math.floor(random() * 2 ** 32) >>> 0,
  });
  // the first player may have nothing to play; nobody is listening for events yet
  advance(state, [], false);
  return finalize(state);
}

function applyAction(
  state: MacaoState,
  action: GameAction,
  playerId: string,
): { newState: MacaoState; events: GameEvent[] } {
  if (state.result) throw new GameRuleError('GAME_OVER', 'the game is already finished');
  const seat = state.players.findIndex((p) => p.id === playerId);
  if (seat < 0 || state.eliminated[seat]) throw invalid('you are not playing in this game');

  const draft = copyState(state);
  const events: GameEvent[] = [];

  if (action.type === 'report_macao') {
    const reported = draft.reportable;
    if (reported === null || reported === seat) throw invalid('there is nobody to report');
    draft.reportable = null;
    drawCards(draft, reported, MACAO_REPORT_PENALTY, events);
    events.push({
      type: 'macao_reported',
      data: { reportedId: draft.players[reported]!.id, reporterId: playerId },
    });
    return { newState: finalize(draft), events };
  }
  if (action.type !== 'play' && action.type !== 'draw' && action.type !== 'pass') {
    throw invalid(`unknown action: ${action.type}`);
  }
  if (seat !== draft.current) throw new GameRuleError('NOT_YOUR_TURN', 'it is not your turn');

  draft.reportable = null; // any accepted move closes the reporting window

  const turnAtStart = draft.turn;
  if (action.type === 'play') {
    const { card, request, declaredMacao } = parsePlay(action.payload);
    if (!draft.hands[seat]!.some((c) => sameCard(c, card)))
      throw invalid('you do not hold that card');
    if (!isPlayable(draft, card)) throw invalid('that card cannot be played now');
    playCard(draft, seat, card, checkRequest(card, request), declaredMacao === true, events);
  } else if (action.type === 'draw') {
    if (draft.penalty?.kind === 'draw') {
      takeDrawPenalty(draft, seat, events);
      endTurn(draft);
    } else if (draft.penalty || draft.drawn) {
      throw invalid('you cannot draw now');
    } else if (drawCards(draft, seat, 1, events) === 0) {
      draft.request = null;
      endTurn(draft);
    } else if (matchesTable(draft, draft.hands[seat]!.at(-1)!)) {
      draft.drawn = draft.hands[seat]!.at(-1)!; // the player may play it or pass
    } else {
      draft.request = null;
      endTurn(draft);
    }
  } else if (draft.penalty?.kind === 'skip') {
    takeSkipPenalty(draft, seat, events);
    endTurn(draft);
  } else if (draft.drawn) {
    draft.drawn = null;
    draft.request = null;
    endTurn(draft);
  } else {
    throw invalid('you cannot pass now');
  }

  // a move that ended the turn hands the table to the next player
  advance(draft, events, draft.turn !== turnAtStart);
  return { newState: finalize(draft), events };
}

// the player drops out of the game (timeout or disconnect); the last player standing wins
export function eliminatePlayer(
  state: MacaoState,
  playerId: string,
  reason: 'timeout_forfeit' | 'disconnect_forfeit',
): { newState: MacaoState; events: GameEvent[] } {
  const seat = state.players.findIndex((p) => p.id === playerId);
  if (state.result || seat < 0 || state.eliminated[seat]) return { newState: state, events: [] };

  const draft = copyState(state);
  const events: GameEvent[] = [{ type: 'player_eliminated', data: { playerId, reason } }];
  // the hand goes under the draw pile in its current order; the discard pile stays as it is
  draft.drawPile.push(...draft.hands[seat]!);
  draft.hands[seat] = [];
  draft.eliminated[seat] = true;
  draft.skips[seat] = 0;
  if (draft.reportable === seat) draft.reportable = null;

  const remaining = draft.players.map((_, s) => s).filter((s) => !draft.eliminated[s]);
  if (remaining.length === 1) {
    draft.result = makeResult(draft, remaining[0]!, reason);
    return { newState: finalize(draft), events };
  }
  if (draft.current === seat) {
    draft.penalty = null;
    draft.request = null;
    draft.drawn = null;
    draft.current = nextSeat(draft, seat);
    advance(draft, events, true);
  }
  return { newState: finalize(draft), events };
}

function isTerminal(state: MacaoState): boolean {
  return state.result !== null;
}

function getResult(state: MacaoState): GameResult {
  if (!state.result) throw new Error('the game is not finished yet');
  return state.result;
}

function sanitize(state: MacaoState, recipientId: string): ClientMacaoState {
  const seat = state.players.findIndex((p) => p.id === recipientId);
  const myTurn = seat >= 0 && seat === state.current && !state.result;
  const hand = seat >= 0 ? state.hands[seat]! : [];
  return {
    gameKey: 'macao',
    players: state.players,
    currentPlayerId: state.result ? null : state.players[state.current]!.id,
    turnDeadlineAt: null,
    hand,
    handSizes: Object.fromEntries(state.players.map((p, s) => [p.id, state.hands[s]!.length])),
    topCard: topCard(state),
    discardCount: state.discard.length,
    drawPileCount: state.drawPile.length,
    penalty: state.penalty,
    request: state.request,
    playable: myTurn ? hand.filter((card) => isPlayable(state, card)) : [],
    canDraw: myTurn && state.penalty?.kind !== 'skip' && state.drawn === null,
    canPass: myTurn && (state.penalty?.kind === 'skip' || state.drawn !== null),
    drawnCard: myTurn ? state.drawn : null,
    reportablePlayerId: state.reportable === null ? null : state.players[state.reportable]!.id,
    eliminatedIds: state.players.filter((_, s) => state.eliminated[s]).map((p) => p.id),
    turn: state.turn,
    result: state.result,
  };
}

export const macaoModule: ServerGameModule<MacaoState, ClientMacaoState> = {
  key: 'macao',
  createInitialState,
  applyAction,
  isTerminal,
  getResult,
  sanitize,
};
