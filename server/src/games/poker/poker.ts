import {
  GameRuleError,
  POKER_BASE_SMALL_BLIND,
  POKER_HANDS_PER_LEVEL,
  POKER_START_STACK,
  type ClientPokerState,
  type Deck,
  type GameAction,
  type GameEvent,
  type GameFacts,
  type GamePlayer,
  type GameResult,
  type GameState,
  type PokerHandSummary,
  type PokerLegal,
  type PokerPot,
  type PokerStreet,
  type RandomSource,
  type ServerGameModule,
  type TerminationReason,
} from '@cardplay/shared';
import { createDeck } from '../deck';
import { shuffleWithState } from '../rng';
import { handName, handWinners } from './hand-eval';

type ForfeitReason = 'timeout_forfeit' | 'disconnect_forfeit';

// Server state of a No-Limit Texas Hold'em match. Seat = index in `players`.
export type PokerState = GameState & {
  gameKey: 'poker';
  stacks: number[];
  // left the table (busted, or forfeited and the hand is over)
  out: boolean[];
  // forfeited during a hand: folded already, leaves when the hand ends
  leaving: boolean[];
  forfeited: boolean[];
  forfeitReason: (ForfeitReason | null)[];
  button: number;
  handNumber: number;
  handStartStacks: number[];
  deck: Deck;
  holes: Deck[];
  board: Deck;
  street: PokerStreet;
  inHand: boolean[];
  allIn: boolean[];
  // chips put in during this hand (for the pots) and during this betting round
  contributed: number[];
  bets: number[];
  currentBet: number;
  // size of the last full raise: the minimum raise
  lastRaise: number;
  mustAct: boolean[];
  canRaise: boolean[];
  // seat on turn, -1 when nobody is
  actor: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  // went all-in during the current hand, and collected a pot after doing so (any hand)
  wentAllIn: boolean[];
  allInWins: boolean[];
  // players that left the table, in groups per hand, with their stack at the start of that hand
  departures: { seat: number; stack: number }[][];
  lastHand: {
    handNumber: number;
    board: Deck;
    reveals: { seat: number; cards: Deck; name: string }[];
    payouts: { seat: number; amount: number }[];
  } | null;
  rngState: number;
  result: GameResult | null;
};

const invalid = (message: string) => new GameRuleError('INVALID_ACTION', message);

const blindsFor = (handNumber: number) => {
  const small = POKER_BASE_SMALL_BLIND * 2 ** Math.floor((handNumber - 1) / POKER_HANDS_PER_LEVEL);
  return { small, big: small * 2 };
};

function copyState(state: PokerState): PokerState {
  return {
    ...state,
    stacks: [...state.stacks],
    out: [...state.out],
    leaving: [...state.leaving],
    forfeited: [...state.forfeited],
    forfeitReason: [...state.forfeitReason],
    handStartStacks: [...state.handStartStacks],
    deck: [...state.deck],
    holes: state.holes.map((hole) => [...hole]),
    board: [...state.board],
    inHand: [...state.inHand],
    allIn: [...state.allIn],
    contributed: [...state.contributed],
    bets: [...state.bets],
    mustAct: [...state.mustAct],
    canRaise: [...state.canRaise],
    wentAllIn: [...state.wentAllIn],
    allInWins: [...state.allInWins],
    departures: state.departures.map((group) => group.map((d) => ({ ...d }))),
  };
}

const seatsWhere = (state: PokerState, test: (seat: number) => boolean): number[] =>
  state.players.map((_, seat) => seat).filter(test);

// the next seat after `from` (clockwise) that passes the test, or -1
function nextSeat(state: PokerState, from: number, test: (seat: number) => boolean): number {
  const count = state.players.length;
  for (let step = 1; step <= count; step++) {
    const seat = (from + step) % count;
    if (test(seat)) return seat;
  }
  return -1;
}

const atTable = (state: PokerState) => (seat: number) => !state.out[seat] && !state.leaving[seat];
const playersInHand = (state: PokerState): number[] => seatsWhere(state, (s) => state.inHand[s]!);

// chips of a seat that can still be put in
function pay(state: PokerState, seat: number, amount: number): void {
  const chips = Math.min(amount, state.stacks[seat]!);
  state.stacks[seat]! -= chips;
  state.bets[seat]! += chips;
  state.contributed[seat]! += chips;
  if (state.stacks[seat] === 0) {
    state.allIn[seat] = true;
    state.wentAllIn[seat] = true;
  }
}

// ---- pots ---------------------------------------------------------------------------------

// Layers by contribution: a pot for every level where a player went all-in. Chips of folded
// players stay in, but only players still in the hand can win. A layer that nobody can win
// (all its chips are from folded players) joins the pot below it.
function buildPots(
  state: PokerState,
  onlyAllInLevels = false,
): { amount: number; eligible: number[] }[] {
  const top = Math.max(0, ...state.contributed);
  // for the table view a side pot exists only where somebody is all-in
  const source = onlyAllInLevels
    ? [...state.contributed.filter((c, s) => c > 0 && state.allIn[s]!), top]
    : state.contributed.filter((c) => c > 0);
  const levels = [...new Set(source.filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: { amount: number; eligible: number[] }[] = [];
  let previous = 0;
  for (const level of levels) {
    let amount = 0;
    for (const contribution of state.contributed) {
      amount += Math.max(0, Math.min(contribution, level) - previous);
    }
    // in the table view the top pot is open to everybody still in, even before bets are matched
    const open = onlyAllInLevels && level === top;
    const eligible = seatsWhere(
      state,
      (s) => state.inHand[s]! && (open || state.contributed[s]! >= level),
    );
    if (eligible.length === 0 && pots.length > 0) pots[pots.length - 1]!.amount += amount;
    else pots.push({ amount, eligible });
    previous = level;
  }
  return pots;
}

// ---- hand lifecycle -----------------------------------------------------------------------

function startHand(state: PokerState, events: GameEvent[]): void {
  const previousLevel = Math.floor((state.handNumber - 1) / POKER_HANDS_PER_LEVEL);
  state.handNumber++;
  const { small, big } = blindsFor(state.handNumber);
  if (
    state.handNumber > 1 &&
    Math.floor((state.handNumber - 1) / POKER_HANDS_PER_LEVEL) > previousLevel
  ) {
    events.push({ type: 'blinds_raised', data: { smallBlind: small, bigBlind: big } });
  }

  const seated = atTable(state);
  state.button =
    state.handNumber === 1 && seated(state.button)
      ? state.button
      : nextSeat(state, state.button, seated);
  state.handStartStacks = [...state.stacks];

  const shuffled = shuffleWithState(createDeck(), state.rngState);
  state.deck = shuffled.deck;
  state.rngState = shuffled.state;
  state.holes = state.players.map(() => []);
  state.board = [];
  state.street = 'preflop';
  state.inHand = state.players.map((_, s) => seated(s));
  state.allIn = state.players.map(() => false);
  state.wentAllIn = state.players.map(() => false);
  state.contributed = state.players.map(() => 0);
  state.bets = state.players.map(() => 0);

  // two cards each, one at a time, starting left of the button
  const dealOrder: number[] = [];
  for (let step = 1; step <= state.players.length; step++) {
    const seat = (state.button + step) % state.players.length;
    if (state.inHand[seat]) dealOrder.push(seat);
  }
  for (let round = 0; round < 2; round++) {
    for (const seat of dealOrder) state.holes[seat]!.push(state.deck.shift()!);
  }

  const headsUp = dealOrder.length === 2;
  state.smallBlindSeat = headsUp
    ? state.button
    : nextSeat(state, state.button, (s) => state.inHand[s]!);
  state.bigBlindSeat = nextSeat(state, state.smallBlindSeat, (s) => state.inHand[s]!);
  pay(state, state.smallBlindSeat, small);
  pay(state, state.bigBlindSeat, big);
  state.currentBet = big;
  state.lastRaise = big;
  state.mustAct = state.players.map((_, s) => state.inHand[s]! && !state.allIn[s]!);
  state.canRaise = state.players.map(() => true);
  // blinds that put everybody but one player all-in leave nothing to decide
  const free = seatsWhere(state, (s) => state.inHand[s]! && !state.allIn[s]!);
  if (free.length < 2 && free.every((s) => state.bets[s]! >= state.currentBet)) {
    state.mustAct = state.players.map(() => false);
  }

  events.push({
    type: 'hand_started',
    data: {
      handNumber: state.handNumber,
      buttonId: state.players[state.button]!.id,
      smallBlindId: state.players[state.smallBlindSeat]!.id,
      bigBlindId: state.players[state.bigBlindSeat]!.id,
      smallBlind: small,
      bigBlind: big,
    },
  });
  // heads-up the button (small blind) acts first before the flop
  state.actor = headsUp ? state.smallBlindSeat : state.bigBlindSeat;
  moveOn(state, events, headsUp);
}

// Finds who acts next, deals the next street, or ends the hand.
function moveOn(state: PokerState, events: GameEvent[], includeCurrent = false): void {
  while (!state.result) {
    if (playersInHand(state).length === 1) {
      endHand(state, events, false);
      return;
    }
    const canAct = (s: number) => state.inHand[s]! && !state.allIn[s]! && state.mustAct[s]!;
    const next =
      includeCurrent && canAct(state.actor) ? state.actor : nextSeat(state, state.actor, canAct);
    includeCurrent = false;
    if (next !== -1) {
      state.actor = next;
      events.push({ type: 'turn_started', data: { playerId: state.players[next]!.id } });
      return;
    }
    // the betting round is over
    if (state.street === 'river') {
      endHand(state, events, true);
      return;
    }
    nextStreet(state, events);
    // post-flop the first seat left of the button acts
    state.actor = state.button;
  }
}

function nextStreet(state: PokerState, events: GameEvent[]): void {
  const order: PokerStreet[] = ['preflop', 'flop', 'turn', 'river'];
  state.street = order[order.indexOf(state.street) + 1]!;
  state.deck.shift(); // burn card
  const dealt = state.deck.splice(0, state.street === 'flop' ? 3 : 1);
  state.board.push(...dealt);
  events.push({ type: 'board_dealt', data: { street: state.street, cards: dealt } });

  state.bets = state.players.map(() => 0);
  state.currentBet = 0;
  state.lastRaise = blindsFor(state.handNumber).big;
  const canAct = (s: number) => state.inHand[s]! && !state.allIn[s]!;
  // with one player (or none) able to bet, nobody has a decision: the board runs out
  const deciding = seatsWhere(state, canAct).length >= 2;
  state.mustAct = state.players.map((_, s) => deciding && canAct(s));
  state.canRaise = state.players.map(() => true);
}

function endHand(state: PokerState, events: GameEvent[], showdown: boolean): void {
  const payouts = new Map<number, number>();
  const award = (seat: number, amount: number) =>
    payouts.set(seat, (payouts.get(seat) ?? 0) + amount);
  const reveals: { seat: number; cards: Deck; name: string }[] = [];

  if (!showdown) {
    const winner = playersInHand(state)[0]!;
    award(
      winner,
      state.contributed.reduce((sum, c) => sum + c, 0),
    );
  } else {
    const contenders = playersInHand(state);
    for (const seat of contenders) {
      reveals.push({
        seat,
        cards: state.holes[seat]!,
        name: handName([...state.holes[seat]!, ...state.board]),
      });
    }
    events.push({
      type: 'showdown',
      data: {
        reveals: reveals.map((r) => ({
          playerId: state.players[r.seat]!.id,
          cards: r.cards,
          handName: r.name,
        })),
      },
    });
    for (const pot of buildPots(state)) {
      if (pot.eligible.length === 1) {
        award(pot.eligible[0]!, pot.amount);
        continue;
      }
      const winners = handWinners(
        pot.eligible.map((seat) => ({
          id: String(seat),
          cards: [...state.holes[seat]!, ...state.board],
        })),
      ).map(Number);
      // an odd chip goes to the first winner left of the button
      const ordered = [...winners].sort(
        (a, b) =>
          ((a - state.button + state.players.length) % state.players.length) -
          ((b - state.button + state.players.length) % state.players.length),
      );
      const share = Math.floor(pot.amount / ordered.length);
      let rest = pot.amount - share * ordered.length;
      for (const seat of ordered) {
        award(seat, share + (rest > 0 ? 1 : 0));
        if (rest > 0) rest--;
      }
    }
  }

  for (const [seat, amount] of payouts) {
    state.stacks[seat]! += amount;
    if (state.wentAllIn[seat] && amount > 0) state.allInWins[seat] = true;
    events.push({
      type: 'pot_awarded',
      data: { playerId: state.players[seat]!.id, amount },
    });
  }
  state.lastHand = {
    handNumber: state.handNumber,
    board: [...state.board],
    reveals,
    payouts: [...payouts].map(([seat, amount]) => ({ seat, amount })),
  };
  state.actor = -1;
  state.bets = state.players.map(() => 0);
  state.contributed = state.players.map(() => 0);
  state.inHand = state.players.map(() => false);

  // players without chips, and those who forfeited, leave the table
  const departing = seatsWhere(
    state,
    (s) => !state.out[s]! && (state.stacks[s] === 0 || state.leaving[s]!),
  );
  for (const seat of departing) {
    state.out[seat] = true;
    state.leaving[seat] = false;
    events.push({
      type: 'player_out',
      data: {
        playerId: state.players[seat]!.id,
        reason: state.forfeited[seat] ? 'forfeit' : 'busted',
      },
    });
  }
  if (departing.length > 0) {
    state.departures.push(departing.map((seat) => ({ seat, stack: state.handStartStacks[seat]! })));
  }

  const remaining = seatsWhere(state, (s) => !state.out[s]!);
  if (remaining.length === 1) {
    const lastForfeiter = departing.filter((s) => state.forfeited[s]).at(-1);
    const reason: TerminationReason =
      lastForfeiter === undefined ? 'completed' : state.forfeitReason[lastForfeiter]!;
    state.result = makeResult(state, remaining[0]!, reason);
    return;
  }
  startHand(state, events);
}

// Winner first, then the players in reverse order of leaving; within one hand the bigger stack
// at the start of that hand ranks higher, and equal stacks share a place.
function makeResult(state: PokerState, winner: number, reason: TerminationReason): GameResult {
  const ordered: { seat: number; key: string }[] = [{ seat: winner, key: 'winner' }];
  const pending = seatsWhere(state, (s) => s !== winner && !state.out[s]!);
  const groups = [
    pending.map((seat) => ({ seat, stack: state.handStartStacks[seat]! })),
    ...[...state.departures].reverse(),
  ];
  groups.forEach((group, index) => {
    [...group]
      .sort((a, b) => b.stack - a.stack)
      .forEach((member) => ordered.push({ seat: member.seat, key: `${index}:${member.stack}` }));
  });
  const rankOf = new Map(
    ordered.map((entry) => [entry.seat, ordered.findIndex((other) => other.key === entry.key) + 1]),
  );
  return {
    terminationReason: reason,
    placements: state.players.map((player, seat) => ({
      playerId: player.id,
      rank: rankOf.get(seat)!,
    })),
  };
}

// ---- betting actions ----------------------------------------------------------------------

// Raises the bet to `total`. A full raise reopens the betting for everybody; a short all-in
// does not give a raise back to players who have already acted.
function raiseTo(state: PokerState, seat: number, total: number): void {
  pay(state, seat, total - state.bets[seat]!);
  const increment = total - state.currentBet;
  const full = increment >= state.lastRaise;
  state.currentBet = total;
  state.mustAct[seat] = false;
  for (const other of seatsWhere(
    state,
    (s) => s !== seat && state.inHand[s]! && !state.allIn[s]!,
  )) {
    if (full) {
      state.canRaise[other] = true;
    } else if (!state.mustAct[other]) {
      state.canRaise[other] = false;
    }
    state.mustAct[other] = true;
  }
  if (full) state.lastRaise = increment;
}

function legalFor(state: PokerState, seat: number): PokerLegal {
  const stack = state.stacks[seat]!;
  const bet = state.bets[seat]!;
  const toCall = state.currentBet - bet;
  const total = bet + stack;
  const { big } = blindsFor(state.handNumber);
  const opening = state.currentBet === 0;
  const minRaiseTo = state.currentBet + state.lastRaise;
  return {
    canFold: true,
    canCheck: toCall === 0,
    call: toCall > 0 ? Math.min(toCall, stack) : null,
    // a stack that cannot cover the minimum can only go all-in
    bet: opening && total > big ? { min: big, max: total } : null,
    raise:
      !opening && state.canRaise[seat]! && total >= minRaiseTo
        ? { min: minRaiseTo, max: total }
        : null,
    // after a short all-in a player who has already acted may only call, even with all chips
    allIn: stack > 0 && (total <= state.currentBet || state.canRaise[seat]!) ? total : null,
  };
}

function parseAmount(action: GameAction): number {
  const amount = (action.payload as { amount?: unknown } | null | undefined)?.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw invalid(`${action.type} needs a whole amount of chips`);
  }
  return amount;
}

function finalize(state: PokerState): PokerState {
  const current = state.result || state.actor < 0 ? null : state.players[state.actor]!.id;
  return { ...state, currentPlayerId: current };
}

function applyAction(
  state: PokerState,
  action: GameAction,
  playerId: string,
): { newState: PokerState; events: GameEvent[] } {
  if (state.result) throw new GameRuleError('GAME_OVER', 'the game is already finished');
  const seat = state.players.findIndex((p) => p.id === playerId);
  if (seat < 0 || state.out[seat] || state.leaving[seat])
    throw invalid('you are not playing in this game');
  if (seat !== state.actor) throw new GameRuleError('NOT_YOUR_TURN', 'it is not your turn');
  const types = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
  if (!types.includes(action.type)) throw invalid(`unknown action: ${action.type}`);

  const draft = copyState(state);
  const events: GameEvent[] = [];
  const legal = legalFor(draft, seat);
  const total = draft.bets[seat]! + draft.stacks[seat]!;
  let shown: { amount?: number; allIn?: boolean } = {};

  switch (action.type) {
    case 'fold':
      draft.inHand[seat] = false;
      draft.mustAct[seat] = false;
      break;
    case 'check':
      if (!legal.canCheck) throw invalid('there is a bet to call');
      draft.mustAct[seat] = false;
      break;
    case 'call': {
      if (legal.call === null) throw invalid('there is nothing to call');
      pay(draft, seat, legal.call);
      draft.mustAct[seat] = false;
      shown = { amount: legal.call };
      break;
    }
    case 'bet': {
      const amount = parseAmount(action);
      if (!legal.bet || amount < legal.bet.min || amount > legal.bet.max) {
        throw invalid('that bet is not allowed');
      }
      raiseTo(draft, seat, amount);
      shown = { amount };
      break;
    }
    case 'raise': {
      const amount = parseAmount(action);
      if (!legal.raise || amount < legal.raise.min || amount > legal.raise.max) {
        throw invalid('that raise is not allowed');
      }
      raiseTo(draft, seat, amount);
      shown = { amount };
      break;
    }
    case 'all_in': {
      if (legal.allIn === null) throw invalid('you cannot go all-in now');
      if (total <= draft.currentBet) {
        pay(draft, seat, draft.stacks[seat]!);
        draft.mustAct[seat] = false;
      } else {
        raiseTo(draft, seat, total);
      }
      shown = { amount: total };
      break;
    }
  }
  events.push({
    type: 'action_taken',
    data: { playerId, action: action.type, ...shown, allIn: draft.allIn[seat] },
  });
  moveOn(draft, events);
  return { newState: finalize(draft), events };
}

// the player drops out (timeout or disconnect): folds now, leaves when the hand is over
export function eliminatePlayer(
  state: PokerState,
  playerId: string,
  reason: ForfeitReason,
): { newState: PokerState; events: GameEvent[] } {
  const seat = state.players.findIndex((p) => p.id === playerId);
  if (state.result || seat < 0 || state.out[seat] || state.leaving[seat]) {
    return { newState: state, events: [] };
  }
  const draft = copyState(state);
  const events: GameEvent[] = [{ type: 'player_eliminated', data: { playerId, reason } }];
  draft.forfeited[seat] = true;
  draft.forfeitReason[seat] = reason;
  draft.leaving[seat] = true;

  const remaining = seatsWhere(draft, atTable(draft));
  if (remaining.length === 1) {
    // the match is over at once; this player counts as leaving in the hand in progress
    draft.result = makeResult(draft, remaining[0]!, reason);
    draft.actor = -1;
    return { newState: finalize(draft), events };
  }
  const wasActor = draft.actor === seat;
  draft.inHand[seat] = false;
  draft.mustAct[seat] = false;
  if (wasActor || playersInHand(draft).length === 1) moveOn(draft, events);
  return { newState: finalize(draft), events };
}

function createInitialState(players: GamePlayer[], random: RandomSource): PokerState {
  if (players.length < 2 || players.length > 6) throw new Error('Poker needs 2 to 6 players');
  const count = players.length;
  const state: PokerState = {
    gameKey: 'poker',
    players,
    currentPlayerId: null,
    stacks: players.map(() => POKER_START_STACK),
    out: players.map(() => false),
    leaving: players.map(() => false),
    forfeited: players.map(() => false),
    forfeitReason: players.map(() => null),
    button: 0,
    handNumber: 0,
    handStartStacks: players.map(() => POKER_START_STACK),
    deck: [],
    holes: players.map(() => []),
    board: [],
    street: 'preflop',
    inHand: players.map(() => false),
    allIn: players.map(() => false),
    contributed: players.map(() => 0),
    bets: players.map(() => 0),
    currentBet: 0,
    lastRaise: 0,
    mustAct: players.map(() => false),
    canRaise: players.map(() => true),
    actor: -1,
    smallBlindSeat: 0,
    bigBlindSeat: 1 % count,
    wentAllIn: players.map(() => false),
    allInWins: players.map(() => false),
    departures: [],
    lastHand: null,
    rngState: Math.floor(random() * 2 ** 32) >>> 0,
    result: null,
  };
  startHand(state, []);
  return finalize(state);
}

// exact state for tests: a hand in progress with the given cards, blinds already posted
export function createPokerStateFrom(
  players: GamePlayer[],
  setup: {
    stacks?: number[];
    button?: number;
    handNumber?: number;
    holes: Deck[];
    // burn, flop (3), burn, turn, burn, river: the order the cards leave the deck
    deck?: Deck;
    rngState?: number;
  },
): PokerState {
  const state = createInitialState(players, () => 0);
  const handNumber = setup.handNumber ?? 1;
  // start over with the chosen stacks and cards, then post the blinds the same way as a real hand
  state.stacks = setup.stacks ? [...setup.stacks] : players.map(() => POKER_START_STACK);
  state.handNumber = handNumber - 1;
  // startHand moves the button on after the first hand, so start one seat before
  const wanted = setup.button ?? 0;
  state.button = handNumber === 1 ? wanted : (wanted + players.length - 1) % players.length;
  state.rngState = setup.rngState ?? 1;
  state.out = state.stacks.map((s) => s === 0);
  const events: GameEvent[] = [];
  startHand(state, events);
  // the rest of the hand is fixed by the test
  state.holes = setup.holes.map((hole) => [...hole]);
  state.deck = setup.deck ? [...setup.deck] : state.deck;
  return finalize(state);
}

function sanitize(state: PokerState, recipientId: string): ClientPokerState {
  const me = state.players.findIndex((p) => p.id === recipientId);
  const { small, big } = blindsFor(state.handNumber);
  const pots: PokerPot[] = buildPots(state, true).map((pot) => ({
    amount: pot.amount,
    eligibleIds: pot.eligible.map((seat) => state.players[seat]!.id),
  }));
  const myTurn = me >= 0 && me === state.actor && !state.result;
  const summary = state.lastHand;
  const lastHand: PokerHandSummary | null = summary && {
    handNumber: summary.handNumber,
    board: summary.board,
    reveals: summary.reveals.map((r) => ({
      playerId: state.players[r.seat]!.id,
      cards: r.cards,
      handName: r.name,
    })),
    payouts: summary.payouts.map((p) => ({
      playerId: state.players[p.seat]!.id,
      amount: p.amount,
    })),
  };
  return {
    gameKey: 'poker',
    players: state.players,
    currentPlayerId: state.result || state.actor < 0 ? null : state.players[state.actor]!.id,
    turnDeadlineAt: null,
    handNumber: state.handNumber,
    smallBlind: small,
    bigBlind: big,
    street: state.street,
    board: state.board,
    hole: me >= 0 && state.inHand[me] ? state.holes[me]! : [],
    seats: state.players.map((player, seat) => ({
      playerId: player.id,
      stack: state.stacks[seat]!,
      bet: state.bets[seat]!,
      folded: !state.out[seat]! && !state.inHand[seat]!,
      allIn: state.allIn[seat]!,
      out: state.out[seat]!,
      isButton: seat === state.button,
      isSmallBlind: seat === state.smallBlindSeat,
      isBigBlind: seat === state.bigBlindSeat,
    })),
    pots,
    pot: state.contributed.reduce((sum, c) => sum + c, 0),
    legal: myTurn ? legalFor(state, me) : null,
    lastHand,
    result: state.result,
  };
}

function isTerminal(state: PokerState): boolean {
  return state.result !== null;
}

function getResult(state: PokerState): GameResult {
  if (!state.result) throw new Error('the game is not finished yet');
  return state.result;
}

function facts(state: PokerState): GameFacts {
  const winner =
    state.result?.terminationReason === 'completed'
      ? state.result.placements.find((p) => p.rank === 1)?.playerId
      : undefined;
  return Object.fromEntries(
    state.players.map((player, seat) => [
      player.id,
      {
        forfeited: state.forfeited[seat]!,
        pokerAllInWin: state.allInWins[seat]!,
        pokerEliminator: player.id === winner,
      },
    ]),
  );
}

export const pokerModule: ServerGameModule<PokerState, ClientPokerState> = {
  key: 'poker',
  createInitialState,
  applyAction,
  isTerminal,
  getResult,
  sanitize,
  facts,
};
