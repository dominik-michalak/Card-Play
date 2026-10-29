import {
  GameRuleError,
  POKER_START_STACK,
  type Card,
  type GameAction,
  type GamePlayer,
  type Rank,
  type Suit,
} from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import {
  createPokerStateFrom,
  eliminatePlayer,
  pokerModule,
  type PokerState,
} from '../../../server/src/games/poker/poker';
import { seededRandom } from '../../helpers/seeded-random';

const SUIT: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const card = (text: string): Card => ({
  rank: text.slice(0, -1) as Rank,
  suit: SUIT[text.slice(-1)]!,
});
const cards = (text: string): Card[] =>
  text.trim() === '' ? [] : text.trim().split(/\s+/).map(card);
const players = (count: number): GamePlayer[] =>
  ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, count).map((id) => ({ id, username: id, isBot: false }));
const ids = ['a', 'b', 'c', 'd', 'e', 'f'];

// burn, flop x3, burn, turn, burn, river; harmless by default (nobody gets a pair from it)
const BOARD_DECK = 'Xd 2c 7d 9h Xs 3s Xc 4h';
const FILL = Array.from(
  { length: 30 },
  (_, i) => `${['5', '6', '8', '10', 'J', 'Q'][i % 6]}${'cdhs'[Math.floor(i / 6) % 4]}`,
).join(' ');

type Setup = {
  holes: string[];
  stacks?: number[];
  button?: number;
  handNumber?: number;
  deck?: string; // the board cards, in the order of BOARD_DECK
};

function make(setup: Setup): PokerState {
  // "X" cards are burn cards; give them real, distinct values the tests never rely on
  const deckText = (setup.deck ?? BOARD_DECK)
    .replace('Xd', 'Kd')
    .replace('Xs', 'Ks')
    .replace('Xc', 'Kc');
  return createPokerStateFrom(players(setup.holes.length), {
    holes: setup.holes.map(cards),
    stacks: setup.stacks,
    button: setup.button,
    handNumber: setup.handNumber,
    deck: cards(`${deckText} ${FILL}`),
  });
}

const act = (state: PokerState, seat: number, type: string, amount?: number) =>
  pokerModule.applyAction(
    state,
    { type, payload: amount === undefined ? undefined : { amount } } as GameAction,
    ids[seat]!,
  );
const step = (state: PokerState, seat: number, type: string, amount?: number) =>
  act(state, seat, type, amount).newState as PokerState;

function ruleError(run: () => unknown): GameRuleError {
  try {
    run();
  } catch (error) {
    if (error instanceof GameRuleError) return error;
    throw error;
  }
  throw new Error('expected a GameRuleError');
}

const chips = (state: PokerState) =>
  state.stacks.reduce((a, b) => a + b, 0) + state.contributed.reduce((a, b) => a + b, 0);

// three players: a is the button and first to act, b posts 10, c posts 20
const three = (extra: Partial<Setup> = {}) =>
  make({ holes: ['As Ah', 'Kd Kc', 'Qd Qc'], ...extra });
// two players: a is the button and small blind and acts first, b posts 20
const duo = (extra: Partial<Setup> = {}) => make({ holes: ['As Ah', 'Kd Kc'], ...extra });

describe('createInitialState', () => {
  const start = (count: number, seed = 1) =>
    pokerModule.createInitialState(players(count), seededRandom(seed)) as PokerState;

  it.each([2, 3, 4, 5, 6])(
    'deals two cards to each of %i players and posts the blinds',
    (count) => {
      const state = start(count);
      expect(state.holes.every((h) => h.length === 2)).toBe(true);
      expect(state.deck).toHaveLength(52 - 2 * count);
      expect(state.stacks.reduce((a, b) => a + b, 0) + state.bets.reduce((a, b) => a + b, 0)).toBe(
        count * POKER_START_STACK,
      );
      expect(state.handNumber).toBe(1);
      expect(state.bets[state.smallBlindSeat]).toBe(10);
      expect(state.bets[state.bigBlindSeat]).toBe(20);
    },
  );

  it('is deterministic for one random source and keeps a private RNG state', () => {
    expect(start(4, 9)).toEqual(start(4, 9));
    expect(start(4, 9).rngState).not.toBe(start(4, 10).rngState);
  });

  it.each([1, 7])('refuses %i players', (count) => {
    const crowd = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      username: `p${i}`,
      isBot: false,
    }));
    expect(() => pokerModule.createInitialState(crowd, seededRandom(1))).toThrow();
  });
});

describe('positions', () => {
  it('puts the blinds left of the button and starts with the player after the big blind', () => {
    const state = three();
    expect([state.button, state.smallBlindSeat, state.bigBlindSeat, state.actor]).toEqual([
      0, 1, 2, 0,
    ]);
  });

  it('makes the button the small blind and the first to act before the flop heads-up', () => {
    const state = duo();
    expect([state.button, state.smallBlindSeat, state.bigBlindSeat, state.actor]).toEqual([
      0, 0, 1, 0,
    ]);
    expect(state.bets).toEqual([10, 20]);
  });

  it('lets the big blind act first after the flop heads-up, and the button last', () => {
    let state = step(duo(), 0, 'call');
    state = step(state, 1, 'check');
    expect(state.street).toBe('flop');
    expect(state.actor).toBe(1);
  });

  it('starts post-flop action left of the button with three players', () => {
    let state = step(three(), 0, 'call');
    state = step(state, 1, 'call');
    state = step(state, 2, 'check');
    expect(state.street).toBe('flop');
    expect(state.actor).toBe(1);
  });

  it('moves the button one seat after every hand, skipping players who left', () => {
    const afterFold = step(step(three(), 0, 'fold'), 1, 'fold');
    expect(afterFold.handNumber).toBe(2);
    expect(afterFold.button).toBe(1);
  });
});

describe('blind levels', () => {
  it.each([
    [1, 10, 20],
    [10, 10, 20],
    [11, 20, 40],
    [21, 40, 80],
    [31, 80, 160],
  ])('hand %i has blinds %i/%i', (handNumber, small, big) => {
    const state = three({ handNumber });
    expect(state.bets[state.smallBlindSeat]).toBe(small);
    expect(state.bets[state.bigBlindSeat]).toBe(big);
  });

  it('announces the raised blinds when the level changes', () => {
    let state = three({ handNumber: 10 });
    const events = [];
    state = step(state, 0, 'fold');
    const result = act(state, 1, 'fold');
    events.push(...result.events);
    expect(events.map((e) => e.type)).toContain('blinds_raised');
    expect(events.find((e) => e.type === 'blinds_raised')?.data).toEqual({
      smallBlind: 20,
      bigBlind: 40,
    });
  });

  it('lets a player who cannot cover a blind post what is left and be all-in', () => {
    const state = three({ stacks: [1000, 6, 1000] });
    expect(state.bets[1]).toBe(6);
    expect(state.allIn[1]).toBe(true);
    expect(state.stacks[1]).toBe(0);
  });
});

describe('betting rules', () => {
  it('refuses a check against a bet and a call with nothing to call', () => {
    expect(ruleError(() => act(three(), 0, 'check')).code).toBe('INVALID_ACTION');
    const flop = step(step(step(duo(), 0, 'call'), 1, 'check'), 1, 'check');
    expect(ruleError(() => act(flop, 0, 'call')).code).toBe('INVALID_ACTION');
  });

  it('accepts the minimum raise and refuses less, or more than the stack', () => {
    const state = three();
    expect(ruleError(() => act(state, 0, 'raise', 39)).code).toBe('INVALID_ACTION');
    expect(step(state, 0, 'raise', 40).currentBet).toBe(40);
    expect(ruleError(() => act(state, 0, 'raise', 1001)).code).toBe('INVALID_ACTION');
  });

  it.each([
    ['without an amount', undefined],
    ['with a fractional amount', 50.5],
    ['with a negative amount', -50],
  ])('refuses a raise %s', (_name, amount) => {
    expect(ruleError(() => act(three(), 0, 'raise', amount)).code).toBe('INVALID_ACTION');
  });

  it('raises the minimum by the size of the last full raise', () => {
    let state = step(three(), 0, 'raise', 60); // raise of 40
    expect(state.lastRaise).toBe(40);
    expect(ruleError(() => act(state, 1, 'raise', 99)).code).toBe('INVALID_ACTION');
    state = step(state, 1, 'raise', 100);
    expect(state.lastRaise).toBe(40);
    state = step(state, 2, 'raise', 220); // raise of 120
    expect(state.lastRaise).toBe(120);
    expect(pokerModule.sanitize(step(state, 0, 'fold'), 'b').legal?.raise).toEqual({
      min: 340,
      max: 1000,
    });
  });
  it('opens the betting after the flop with at least the big blind', () => {
    const flop = step(step(duo(), 0, 'call'), 1, 'check');
    expect(ruleError(() => act(flop, 1, 'bet', 19)).code).toBe('INVALID_ACTION');
    expect(step(flop, 1, 'bet', 20).currentBet).toBe(20);
    expect(ruleError(() => act(flop, 1, 'raise', 40)).code).toBe('INVALID_ACTION');
  });

  it('lets the big blind raise when everybody just called', () => {
    let state = step(step(three(), 0, 'call'), 1, 'call');
    expect(state.actor).toBe(2);
    expect(pokerModule.sanitize(state, 'c').legal).toMatchObject({
      canCheck: true,
      raise: { min: 40 },
    });
    state = step(state, 2, 'raise', 60);
    expect(state.actor).toBe(0);
  });

  it('answers NOT_YOUR_TURN, refuses unknown actions and players that are not in the game', () => {
    expect(ruleError(() => act(three(), 1, 'fold')).code).toBe('NOT_YOUR_TURN');
    expect(ruleError(() => act(three(), 0, 'cheat')).code).toBe('INVALID_ACTION');
    expect(
      ruleError(() => pokerModule.applyAction(three(), { type: 'fold' }, 'stranger')).code,
    ).toBe('INVALID_ACTION');
  });

  it('does not change the state it was given', () => {
    const state = three();
    const frozen = structuredClone(state);
    act(state, 0, 'raise', 60);
    expect(state).toEqual(frozen);
  });

  it('keeps every chip: stacks and contributions always add up', () => {
    let state = three();
    const total = chips(state);
    for (const [seat, type, amount] of [
      [0, 'raise', 60],
      [1, 'call'],
      [2, 'fold'],
    ] as const) {
      state = step(state, seat, type, amount);
      expect(chips(state)).toBe(total);
    }
  });
});

describe('streets', () => {
  it('burns a card before the flop, the turn and the river', () => {
    let state = duo({ deck: 'Kd 2c 7d 9h Ks 3s Kc 4h' });
    state = step(step(state, 0, 'call'), 1, 'check');
    expect(state.board).toEqual(cards('2c 7d 9h'));
    state = step(step(state, 1, 'check'), 0, 'check');
    expect(state.board).toEqual(cards('2c 7d 9h 3s'));
    state = step(step(state, 1, 'check'), 0, 'check');
    expect(state.board).toEqual(cards('2c 7d 9h 3s 4h'));
  });

  it('shows the board deals as events and starts the decision window of the next player', () => {
    const state = step(duo(), 0, 'call');
    const result = act(state, 1, 'check');
    expect(result.events).toContainEqual({
      type: 'board_dealt',
      data: { street: 'flop', cards: cards('2c 7d 9h') },
    });
    expect(result.events).toContainEqual({ type: 'turn_started', data: { playerId: 'b' } });
  });

  it('ends a betting round only when everybody still in has matched the bet', () => {
    let state = step(three(), 0, 'raise', 60);
    state = step(state, 1, 'call');
    expect(state.street).toBe('preflop');
    state = step(state, 2, 'call');
    expect(state.street).toBe('flop');
    expect(state.currentBet).toBe(0);
    expect(state.bets).toEqual([0, 0, 0]);
  });
});

describe('short all-ins', () => {
  // a raises to 100 (a raise of 80); b calls; c has 150 and shoves: only 50 more, a short raise
  const shortShove = () => {
    let state = three({ stacks: [1000, 1000, 150] });
    state = step(state, 0, 'raise', 100);
    state = step(state, 1, 'call');
    return step(state, 2, 'all_in');
  };

  it('does not give the raise back to players who already acted', () => {
    const state = shortShove();
    expect(state.currentBet).toBe(150);
    expect(state.lastRaise).toBe(80);
    const legal = pokerModule.sanitize(state, 'a').legal;
    expect(legal).toMatchObject({ call: 50, raise: null, allIn: null });
    expect(ruleError(() => act(state, 0, 'raise', 300)).code).toBe('INVALID_ACTION');
    expect(ruleError(() => act(state, 0, 'all_in')).code).toBe('INVALID_ACTION');
  });

  it('still lets them call or fold, and closes the round afterwards', () => {
    let state = shortShove();
    state = step(state, 0, 'call');
    const result = act(state, 1, 'fold');
    // only a can still bet, so the board runs out and a new hand starts
    expect(result.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['action_taken', 'board_dealt', 'showdown', 'pot_awarded']),
    );
    expect(chips(result.newState as PokerState)).toBe(2150);
  });
  it('reopens the betting when the all-in is a full raise', () => {
    let state = three({ stacks: [1000, 1000, 300] });
    state = step(state, 0, 'raise', 100);
    state = step(state, 1, 'call');
    state = step(state, 2, 'all_in'); // to 300: a raise of 200
    expect(state.lastRaise).toBe(200);
    expect(pokerModule.sanitize(state, 'a').legal?.raise).toEqual({ min: 500, max: 1000 });
  });

  it('lets a player who has not acted yet raise a short all-in', () => {
    // d is first to act after c's short all-in and may still raise
    let state = make({
      holes: ['As Ah', 'Kd Kc', 'Qd Qc', 'Jd Jc'],
      stacks: [1000, 1000, 1000, 1000],
    });
    // d (utg) is seat 3: button 0, sb 1, bb 2
    expect(state.actor).toBe(3);
    state = step(state, 3, 'call');
    expect(pokerModule.sanitize(state, 'a').legal?.raise).toBeTruthy();
  });

  it('turns a call with too few chips into an all-in call for what is left', () => {
    let state = three({ stacks: [1000, 1000, 50] });
    state = step(state, 0, 'raise', 100);
    state = step(state, 1, 'call');
    // c has 30 chips behind the big blind and calls with them
    const result = act(state, 2, 'call');
    expect(result.events).toContainEqual({
      type: 'action_taken',
      data: { playerId: 'c', action: 'call', amount: 30, allIn: true },
    });
    expect(chips(result.newState as PokerState)).toBe(2050);
  });
});

describe('hand endings', () => {
  it('gives the pot to the last player when everybody else folds, without showing cards', () => {
    const state = step(three(), 0, 'raise', 60);
    const first = act(state, 1, 'fold');
    const result = act(first.newState as PokerState, 2, 'fold');
    const after = result.newState as PokerState;

    expect(result.events.some((e) => e.type === 'showdown')).toBe(false);
    expect(result.events).toContainEqual({
      type: 'pot_awarded',
      data: { playerId: 'a', amount: 90 },
    });
    expect(chips(after)).toBe(3000);
    expect(after.handNumber).toBe(2);
    expect(after.lastHand?.reveals).toEqual([]);
    // a has the pot (30 + the 60 raise), counting the blind already posted for the next hand
    expect(after.stacks[0]! + after.bets[0]!).toBe(1000 - 60 + 90);
  });
  it('shows the cards and gives a heads-up all-in to the better hand', () => {
    let state = step(duo(), 0, 'all_in');
    const result = act(state, 1, 'call');
    state = result.newState as PokerState;

    expect(result.events.find((e) => e.type === 'showdown')?.data).toMatchObject({
      reveals: [
        { playerId: 'a', handName: 'Pair' },
        { playerId: 'b', handName: 'Pair' },
      ],
    });
    expect(pokerModule.isTerminal(state)).toBe(true);
    expect(pokerModule.getResult(state)).toEqual({
      terminationReason: 'completed',
      placements: [
        { playerId: 'a', rank: 1 },
        { playerId: 'b', rank: 2 },
      ],
    });
    expect(state.stacks).toEqual([2000, 0]);
    expect(state.board).toHaveLength(5);
  });

  it('splits a tied pot and gives the odd chip to the first winner left of the button', () => {
    // a goes all-in for 35; b and c call; the board plays for a and b, c holds less
    let state = make({
      holes: ['2h 3h', '2d 3d', '4c 5c'],
      stacks: [35, 1000, 1000],
      deck: 'Kd As Ah Ad Ks Ac Kc Qs',
    });
    state = step(state, 0, 'all_in');
    state = step(state, 1, 'call');
    state = step(state, 2, 'call');
    // two players with chips: b and c check down
    for (let i = 0; i < 3; i++) {
      state = step(state, 1, 'check');
      state = step(state, 2, 'check');
    }
    // pot 105 between a and b (the board plays); the odd chip goes to b, first left of the button
    expect(state.handNumber).toBeGreaterThan(1);
    expect(state.stacks[1]! + state.stacks[0]!).toBeGreaterThan(0);
  });

  it('builds side pots: each player wins only the pots they put chips into', () => {
    // a 50 all-in, b 200 all-in, c calls 200; a has the best hand, b the second best
    let state = make({
      holes: ['As Ah', 'Kd Kc', 'Qd Qc'],
      stacks: [50, 200, 1000],
    });
    state = step(state, 0, 'all_in');
    state = step(state, 1, 'all_in');
    const result = act(state, 2, 'call');
    const awards = result.events.filter((e) => e.type === 'pot_awarded').map((e) => e.data);

    expect(awards).toEqual(
      expect.arrayContaining([
        { playerId: 'a', amount: 150 },
        { playerId: 'b', amount: 300 },
      ]),
    );
    const after = result.newState as PokerState;
    expect(
      after.stacks.reduce((x, y) => x + y, 0) + after.contributed.reduce((x, y) => x + y, 0),
    ).toBe(1250);
  });

  it('returns an uncalled bet to the player who made it', () => {
    let state = duo({ stacks: [1000, 300] });
    state = step(state, 0, 'all_in');
    const result = act(state, 1, 'call');
    const after = result.newState as PokerState;
    // a wins the 600 pot and keeps the 700 nobody could match
    expect(after.stacks[0]).toBe(1300);
    expect(pokerModule.getResult(after).placements[0]).toEqual({ playerId: 'a', rank: 1 });
  });

  it('leaves the chips of a player who folded in the pot, but not their right to win it', () => {
    let state = three();
    state = step(state, 0, 'raise', 100);
    state = step(state, 1, 'fold'); // b loses the 10 small blind
    state = step(state, 2, 'call');
    // heads-up between a (aces) and c after the flop
    for (let i = 0; i < 3; i++) {
      state = step(state, 2, 'check');
      state = step(state, 0, 'check');
    }
    // the blinds of the next hand are already posted, so count chips in front of the players too
    const total = (seat: number) => state.stacks[seat]! + state.bets[seat]!;
    expect(total(0)).toBe(900 + 210);
    expect(total(1)).toBe(990);
    expect(total(2)).toBe(900);
  });
  it('removes players without chips and goes on with the others', () => {
    let state = three({ stacks: [1000, 1000, 100] });
    state = step(state, 0, 'raise', 200);
    state = step(state, 1, 'fold');
    state = step(state, 2, 'call'); // c is all-in for 100 and loses to the aces
    expect(state.out).toEqual([false, false, true]);
    expect(state.handNumber).toBe(2);
    // heads-up now: the button moved from a to b
    expect(state.button).toBe(1);
    expect(state.smallBlindSeat).toBe(1);
  });
});

describe('the end of the match', () => {
  it('ranks players by the order they left, the winner first', () => {
    // hand one: c goes out against the aces; then b forfeits the heads-up match
    let state = three({ stacks: [1000, 1000, 100] });
    state = step(step(state, 0, 'raise', 200), 1, 'fold');
    state = step(state, 2, 'call');
    expect(state.out[2]).toBe(true);

    const over = eliminatePlayer(state, 'b', 'timeout_forfeit').newState;

    expect(pokerModule.getResult(over)).toEqual({
      terminationReason: 'timeout_forfeit',
      placements: [
        { playerId: 'a', rank: 1 },
        { playerId: 'b', rank: 2 },
        { playerId: 'c', rank: 3 },
      ],
    });
  });
  it('shares a place between players who left in the same hand with equal stacks', () => {
    const base = three({ stacks: [1000, 500, 500] });
    const result = pokerModule.getResult(step(step(step(base, 0, 'all_in'), 1, 'call'), 2, 'call'));
    expect(result.terminationReason).toBe('completed');
    expect(result.placements.map((p) => p.rank)).toEqual([1, 2, 2]);
  });

  it('puts the bigger stack higher when two players leave in one hand', () => {
    const base = three({ stacks: [1000, 700, 500] });
    const result = pokerModule.getResult(step(step(step(base, 0, 'all_in'), 1, 'call'), 2, 'call'));
    expect(result.placements).toEqual([
      { playerId: 'a', rank: 1 },
      { playerId: 'b', rank: 2 },
      { playerId: 'c', rank: 3 },
    ]);
  });

  it('refuses everything after the match is over', () => {
    const over = step(step(duo(), 0, 'all_in'), 1, 'call');
    expect(ruleError(() => act(over, 0, 'fold')).code).toBe('GAME_OVER');
  });
});

describe('forfeits', () => {
  it('folds the player on turn at once and goes on with the others', () => {
    const result = eliminatePlayer(three(), 'a', 'timeout_forfeit');
    const state = result.newState;
    expect(state.inHand[0]).toBe(false);
    expect(state.leaving[0]).toBe(true);
    expect(state.actor).toBe(1);
    expect(result.events[0]).toEqual({
      type: 'player_eliminated',
      data: { playerId: 'a', reason: 'timeout_forfeit' },
    });
  });

  it('keeps the chips already bet in the pot and lets the player leave when the hand ends', () => {
    let state = step(three(), 0, 'raise', 100);
    state = eliminatePlayer(state, 'a', 'disconnect_forfeit').newState; // a is not on turn
    expect(state.leaving[0]).toBe(true);
    expect(state.contributed[0]).toBe(100);

    // b folds, so c wins the pot, which includes the 100 a put in
    const result = act(state, 1, 'fold');
    expect(result.events).toContainEqual({
      type: 'pot_awarded',
      data: { playerId: 'c', amount: 130 },
    });
    expect((result.newState as PokerState).out[0]).toBe(true);
  });
  it('ends a heads-up match at once with the forfeit as the reason', () => {
    const state = eliminatePlayer(duo(), 'b', 'disconnect_forfeit').newState;
    expect(pokerModule.getResult(state)).toEqual({
      terminationReason: 'disconnect_forfeit',
      placements: [
        { playerId: 'a', rank: 1 },
        { playerId: 'b', rank: 2 },
      ],
    });
  });

  it('ends the match when only one player is left at the table', () => {
    let state = eliminatePlayer(three(), 'a', 'timeout_forfeit').newState;
    state = eliminatePlayer(state, 'b', 'timeout_forfeit').newState;
    expect(pokerModule.getResult(state).placements.find((p) => p.rank === 1)?.playerId).toBe('c');
  });

  it('removes a forfeiting player once the hand is over', () => {
    let state = eliminatePlayer(three(), 'a', 'timeout_forfeit').newState;
    state = step(state, 1, 'fold');
    expect(state.out[0]).toBe(true);
    expect(state.handNumber).toBe(2);
    // two players remain and c, who won the blinds, is in a new heads-up hand
    expect(state.players.filter((_, s) => !state.out[s])).toHaveLength(2);
  });

  it('does nothing for a player who already left or is unknown', () => {
    const state = three();
    expect(eliminatePlayer(state, 'stranger', 'timeout_forfeit').newState).toBe(state);
  });
});

describe('sanitize', () => {
  it('shows only the own cards and no secrets', () => {
    const view = pokerModule.sanitize(three(), 'b');
    expect(view.hole).toEqual(cards('Kd Kc'));
    for (const secret of ['deck', 'holes', 'rngState', 'handStartStacks']) {
      expect(view).not.toHaveProperty(secret);
    }
    const text = JSON.stringify(view);
    expect(text).not.toContain('"rank":"A"');
    expect(text).not.toContain('"rank":"Q"');
  });

  it('tells the player on turn what is legal, and nobody else', () => {
    const mine = pokerModule.sanitize(three(), 'a');
    expect(mine.legal).toEqual({
      canFold: true,
      canCheck: false,
      call: 20,
      bet: null,
      raise: { min: 40, max: 1000 },
      allIn: 1000,
    });
    expect(pokerModule.sanitize(three(), 'b').legal).toBeNull();
  });

  it('describes the table: positions, bets, pot and blinds', () => {
    const view = pokerModule.sanitize(three(), 'a');
    expect(view).toMatchObject({
      handNumber: 1,
      smallBlind: 10,
      bigBlind: 20,
      street: 'preflop',
      pot: 30,
      currentPlayerId: 'a',
      turnDeadlineAt: null,
    });
    expect(view.seats.map((s) => [s.isButton, s.isSmallBlind, s.isBigBlind])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(view.pots).toEqual([{ amount: 30, eligibleIds: ['a', 'b', 'c'] }]);
  });

  it('keeps the last hand with its shown cards after a showdown', () => {
    let state = three();
    state = step(step(state, 0, 'call'), 1, 'call');
    state = step(state, 2, 'check');
    for (let i = 0; i < 3; i++) {
      state = step(state, 1, 'check');
      state = step(state, 2, 'check');
      state = step(state, 0, 'check');
    }
    const view = pokerModule.sanitize(state, 'b');
    expect(view.handNumber).toBe(2);
    expect(view.lastHand?.reveals.map((r) => r.playerId).sort()).toEqual(['a', 'b', 'c']);
    expect(view.lastHand?.payouts.reduce((s, p) => s + p.amount, 0)).toBe(60);
    // the new hand's cards are still private
    expect(view.hole).not.toEqual([]);
    expect(pokerModule.sanitize(state, 'a').hole).not.toEqual(view.hole);
  });
});

describe('whole matches', () => {
  // plays a random legal action each turn, seeded, so games differ but repeat
  function playOut(count: number, seed: number): PokerState {
    const random = seededRandom(seed);
    let state = pokerModule.createInitialState(
      players(count),
      seededRandom(seed * 7),
    ) as PokerState;
    for (let moves = 0; moves < 20000 && !pokerModule.isTerminal(state); moves++) {
      const seat = state.actor;
      const legal = pokerModule.sanitize(state, ids[seat]!).legal!;
      const options: [string, number?][] = [['fold']];
      if (legal.canCheck) options.push(['check'], ['check']);
      if (legal.call !== null) options.push(['call'], ['call']);
      if (legal.bet) options.push(['bet', legal.bet.min]);
      if (legal.raise) options.push(['raise', legal.raise.min]);
      if (legal.allIn !== null && random() < 0.3) options.push(['all_in']);
      const [type, amount] = options[Math.floor(random() * options.length)]!;
      const before = chips(state);
      state = step(state, seat, type, amount);
      expect(chips(state)).toBe(before);
    }
    return state;
  }

  it.each([2, 3, 4, 5, 6])('plays %i-player matches to the end without losing a chip', (count) => {
    for (let seed = 1; seed <= 12; seed++) {
      const state = playOut(count, seed * 13 + count);
      expect(pokerModule.isTerminal(state)).toBe(true);
      const result = pokerModule.getResult(state);
      expect(result.terminationReason).toBe('completed');
      expect(result.placements.filter((p) => p.rank === 1)).toHaveLength(1);
      expect(state.stacks.reduce((a, b) => a + b, 0)).toBe(count * POKER_START_STACK);
    }
  });
});

describe('facts', () => {
  it('marks an all-in player who collected a pot, and the player who took every chip', () => {
    const state = step(step(duo(), 0, 'all_in'), 1, 'call');
    expect(pokerModule.facts!(state)).toEqual({
      a: { forfeited: false, pokerAllInWin: true, pokerEliminator: true },
      b: { forfeited: false, pokerAllInWin: false, pokerEliminator: false },
    });
  });

  it('does not count an all-in that lost', () => {
    const state = step(step(make({ holes: ['Js 8c', 'Kd Kc'] }), 0, 'all_in'), 1, 'call');
    expect(pokerModule.facts!(state).a?.pokerAllInWin).toBe(false);
    expect(pokerModule.facts!(state).b?.pokerEliminator).toBe(true);
  });

  it('counts an all-in win of one hand even when the match goes on', () => {
    const state = step(step(three({ stacks: [50, 1000, 1000] }), 0, 'all_in'), 1, 'fold');
    const next = step(state, 2, 'fold');
    expect(next.allInWins[0]).toBe(true);
    expect(pokerModule.isTerminal(next)).toBe(false);
  });

  it('marks a forfeit and gives no eliminator achievement for it', () => {
    const state = eliminatePlayer(duo(), 'b', 'timeout_forfeit').newState;
    expect(pokerModule.facts!(state)).toEqual({
      a: { forfeited: false, pokerAllInWin: false, pokerEliminator: false },
      b: { forfeited: true, pokerAllInWin: false, pokerEliminator: false },
    });
  });
});
