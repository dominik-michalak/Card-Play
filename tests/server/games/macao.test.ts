import {
  GameRuleError,
  MACAO_MAX_TURNS,
  type Card,
  type GameAction,
  type GamePlayer,
  type Rank,
  type Suit,
} from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import {
  createMacaoStateFrom,
  eliminatePlayer,
  macaoModule,
  type MacaoState,
} from '../../../server/src/games/macao/macao';
import { seededRandom } from '../../helpers/seeded-random';

const SUIT: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
// "10h" = ten of hearts; c, d, h, s are the suits
const card = (text: string): Card => ({
  rank: text.slice(0, -1) as Rank,
  suit: SUIT[text.slice(-1)]!,
});
const cards = (text: string): Card[] =>
  text.trim() === '' ? [] : text.trim().split(/\s+/).map(card);
const players = (count: number): GamePlayer[] =>
  ['a', 'b', 'c', 'd'].slice(0, count).map((id) => ({ id, username: id, isBot: false }));

// none of these matches a 7 of hearts, so they are safe filler for draws
const FILLER = '9c 8c 6c 5c 10c 9d 8d 6d 5d 10d';

type Setup = {
  overrides?: Partial<MacaoState>;
  hands: string[];
  discard?: string; // last card is the top
  draw?: string; // first card is the top of the pile
  current?: number;
  penalty?: MacaoState['penalty'];
  skips?: number[];
  request?: MacaoState['request'];
  drawn?: string;
  reportable?: number | null;
  turn?: number;
  rngState?: number;
  eliminated?: boolean[];
};

function make(setup: Setup): MacaoState {
  return createMacaoStateFrom(players(setup.hands.length), {
    hands: setup.hands.map(cards),
    drawPile: cards(setup.draw ?? FILLER),
    discard: cards(setup.discard ?? '7h'),
    current: setup.current,
    penalty: setup.penalty,
    skips: setup.skips,
    request: setup.request,
    drawn: setup.drawn ? card(setup.drawn) : undefined,
    reportable: setup.reportable,
    turn: setup.turn,
    rngState: setup.rngState,
    eliminated: setup.eliminated,
    ...setup.overrides,
  });
}

const ids = ['a', 'b', 'c', 'd'];
const act = (state: MacaoState, seat: number, action: GameAction) =>
  macaoModule.applyAction(state, action, ids[seat]!);
const play = (text: string, extra: object = {}): GameAction => ({
  type: 'play',
  payload: { card: card(text), ...extra },
});
const DRAW: GameAction = { type: 'draw' };
const PASS: GameAction = { type: 'pass' };
const REPORT: GameAction = { type: 'report_macao' };
const top = (state: MacaoState) => state.discard[state.discard.length - 1];

function ruleError(run: () => unknown): GameRuleError {
  try {
    run();
  } catch (error) {
    if (error instanceof GameRuleError) return error;
    throw error;
  }
  throw new Error('expected a GameRuleError');
}

describe('createInitialState', () => {
  const every = (n: number, seed: number) =>
    macaoModule.createInitialState(players(n), seededRandom(seed)) as MacaoState;

  it.each([2, 3, 4])('deals five cards to each of %i players and keeps all 52 cards', (count) => {
    const state = every(count, 1);
    const all = [...state.hands.flat(), ...state.drawPile, ...state.discard];
    expect(all).toHaveLength(52);
    expect(new Set(all.map((c) => `${c.rank}${c.suit}`)).size).toBe(52);
    expect(state.discard).toHaveLength(1);
  });

  it('never starts the discard pile with a function card', () => {
    for (let seed = 1; seed <= 60; seed++) {
      expect(['2', '3', '4', 'J', 'A']).not.toContain(top(every(2, seed))!.rank);
    }
  });

  it('is deterministic for one random source and gives a private RNG state', () => {
    expect(every(3, 9)).toEqual(every(3, 9));
    expect(Number.isInteger(every(3, 9).rngState)).toBe(true);
    expect(every(3, 9).rngState).not.toBe(every(3, 10).rngState);
  });

  it.each([1, 5])('refuses %i players', (count) => {
    const crowd = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      username: `p${i}`,
      isBot: false,
    }));
    expect(() => macaoModule.createInitialState(crowd, seededRandom(1))).toThrow();
  });

  it('leaves a real choice or a finished automatic turn, never a stuck player', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const state = every(2, seed);
      const view = macaoModule.sanitize(state, ids[state.current]!);
      expect(view.canDraw || (view as { playable: Card[] }).playable.length > 0).toBe(true);
    }
  });
});

describe('playing a card', () => {
  it('accepts a card of the same suit or rank and passes the turn clockwise', () => {
    const bySuit = act(make({ hands: ['9h 5c', '7s Kh', '6s 6d'] }), 0, play('9h')).newState;
    expect(top(bySuit as MacaoState)).toEqual(card('9h'));
    expect((bySuit as MacaoState).current).toBe(1);

    const byRank = act(make({ hands: ['7s 5c', '7c 8d', '6s 6d'] }), 0, play('7s')).newState;
    expect((byRank as MacaoState).current).toBe(1);
  });

  it('refuses a card that matches neither suit nor rank', () => {
    expect(ruleError(() => act(make({ hands: ['9c 5c', '7s 8d'] }), 0, play('9c'))).code).toBe(
      'INVALID_ACTION',
    );
  });

  it('refuses a card the player does not hold', () => {
    expect(ruleError(() => act(make({ hands: ['9h 5c', '7s 8d'] }), 0, play('Kh'))).code).toBe(
      'INVALID_ACTION',
    );
  });

  it('answers NOT_YOUR_TURN to a play out of turn', () => {
    expect(ruleError(() => act(make({ hands: ['9h 5c', '7s 8d'] }), 1, play('7s'))).code).toBe(
      'NOT_YOUR_TURN',
    );
  });

  it.each([
    ['an unknown action', { type: 'cheat' }],
    ['a play without a card', { type: 'play', payload: {} }],
    ['a play with a malformed card', { type: 'play', payload: { card: { rank: 'Z', suit: 'x' } } }],
  ])('refuses %s', (_name, action) => {
    expect(ruleError(() => act(make({ hands: ['9h 5c', '7s 8d'] }), 0, action)).code).toBe(
      'INVALID_ACTION',
    );
  });

  it('refuses a player who is not in the game', () => {
    const state = make({ hands: ['9h 5c', '7s 8d'] });
    expect(ruleError(() => macaoModule.applyAction(state, play('9h'), 'stranger')).code).toBe(
      'INVALID_ACTION',
    );
  });

  it('does not change the state it was given', () => {
    const state = make({ hands: ['9h 5c', '7s 8d', '6s 6d'] });
    const frozen = structuredClone(state);
    act(state, 0, play('9h'));
    expect(state).toEqual(frozen);
  });
});

describe('turn announcements', () => {
  it('announce the next player after a move, which starts their decision window', () => {
    const result = act(make({ hands: ['9h 5c', '7s Kh', '6s 6d'] }), 0, play('9h'));
    expect(result.events).toContainEqual({ type: 'turn_started', data: { playerId: 'b' } });
  });

  it('announce the next player after a pass or a draw that ends the turn', () => {
    const drew = act(make({ hands: ['9h 5c', '7s Kh'], draw: '8h 9c' }), 0, DRAW).newState;
    const passed = act(drew as MacaoState, 0, PASS);
    expect(passed.events).toContainEqual({ type: 'turn_started', data: { playerId: 'b' } });

    const unusable = act(make({ hands: ['9h 5c', '7s Kh'], draw: '5d' }), 0, DRAW);
    expect(unusable.events).toContainEqual({ type: 'turn_started', data: { playerId: 'b' } });
  });

  it('stay quiet while the same player keeps the turn, so their window is not renewed', () => {
    const result = act(make({ hands: ['9h 5c', '7s Kh'], draw: '8h 9c' }), 0, DRAW);
    expect(result.events.some((e) => e.type === 'turn_started')).toBe(false);
    const reported = act(
      act(make({ hands: ['9h 5c', '7s Kh', '6s 6h'] }), 0, play('9h')).newState as MacaoState,
      2,
      REPORT,
    );
    expect(reported.events.some((e) => e.type === 'turn_started')).toBe(false);
  });
});

describe('Jack and Ace', () => {
  it('lets a Jack request a rank from 5 to 10 only when it matches the top card', () => {
    const state = act(
      make({ hands: ['Jh 5c', '7s 8d', '6s 6d'], discard: '9h' }),
      0,
      play('Jh', { request: { rank: '8' } }),
    ).newState as MacaoState;
    expect(state.request).toEqual({ rank: '8' });
    expect(state.current).toBe(1);
  });

  it('is not a card for everything: a Jack that does not match is refused', () => {
    const state = make({ hands: ['Js 5c', '7s 8d'] });
    expect(ruleError(() => act(state, 0, play('Js', { request: { rank: '8' } }))).code).toBe(
      'INVALID_ACTION',
    );
    const ace = make({ hands: ['As 5c', '7s 8d'] });
    expect(ruleError(() => act(ace, 0, play('As', { request: { suit: 'clubs' } }))).code).toBe(
      'INVALID_ACTION',
    );
  });

  it.each([
    ['a Jack without a request', 'Jh', undefined],
    ['a Jack asking for a suit', 'Jh', { suit: 'clubs' }],
    ['a Jack asking for a rank below 5', 'Jh', { rank: '4' }],
    ['a Jack asking for a face card', 'Jh', { rank: 'K' }],
    ['an Ace without a request', 'Ah', undefined],
    ['an Ace asking for a rank', 'Ah', { rank: '7' }],
    ['a plain card with a request', '9h', { suit: 'clubs' }],
  ] as const)('refuses %s', (_name, text, request) => {
    const state = make({ hands: ['Jh Ah 9h 5c', '7s 8d'] });
    const action = play(text, request ? { request } : {});
    expect(ruleError(() => act(state, 0, action)).code).toBe('INVALID_ACTION');
  });

  it('binds the next player to the requested rank and only for one move', () => {
    const afterJack = act(
      make({ hands: ['Jh 5c', '8s 7s 8d', '6s 6d'], discard: '9h' }),
      0,
      play('Jh', { request: { rank: '8' } }),
    ).newState as MacaoState;

    // 7s matches the top card by... nothing; 7s would be legal on 7h only. Under the request
    // only an 8 is legal, even though the top card is the Jack of hearts.
    expect(ruleError(() => act(afterJack, 1, play('7s'))).code).toBe('INVALID_ACTION');
    const moved = act(afterJack, 1, play('8d')).newState as MacaoState;
    expect(moved.request).toBeNull();
    expect(moved.current).toBe(2);
  });

  it('draws for a player who has no card of the request and lets the request lapse', () => {
    const afterJack = act(
      make({ hands: ['Jh 5c', '7s 6d', '6s 7h'], discard: '9h' }),
      0,
      play('Jh', { request: { rank: '8' } }),
    );
    const state = afterJack.newState as MacaoState;
    expect(state.hands[1]).toHaveLength(3);
    expect(state.request).toBeNull();
    expect(state.current).toBe(2);
    expect(afterJack.events.map((e) => e.type)).toContain('cards_drawn');
  });

  it('plays a drawn card that satisfies the request at once', () => {
    const state = act(
      make({ hands: ['Jh 5c', '7s 6d', '6c 7d'], discard: '9h', draw: '8c 9c' }),
      0,
      play('Jh', { request: { rank: '8' } }),
    ).newState as MacaoState;
    expect(top(state)).toEqual(card('8c'));
    expect(state.hands[1]).toEqual(cards('7s 6d'));
  });

  it('lets an Ace request a suit, which a function card of that suit also satisfies', () => {
    const afterAce = act(
      make({ hands: ['Ah 5c', '7s 2c 6d', '6s 3d'], discard: '9h' }),
      0,
      play('Ah', { request: { suit: 'clubs' } }),
    ).newState as MacaoState;
    expect(afterAce.request).toEqual({ suit: 'clubs' });
    expect(ruleError(() => act(afterAce, 1, play('7s'))).code).toBe('INVALID_ACTION');

    const next = act(afterAce, 1, play('2c')).newState as MacaoState;
    expect(next.penalty).toEqual({ kind: 'draw', amount: 2 });
  });

  it('applies a request to the first player who really moves, not to a skipped one', () => {
    const state = make({
      hands: ['Jh 5c', '7s 6d', '6s 8d 9s'],
      discard: '9h',
      skips: [0, 1, 0],
    });
    const after = act(state, 0, play('Jh', { request: { rank: '8' } })).newState as MacaoState;
    // b is skipped, so the request reaches c, who has an 8
    expect(after.current).toBe(2);
    expect(after.request).toEqual({ rank: '8' });
    expect(after.skips[1]).toBe(0);
    expect(ruleError(() => act(after, 2, play('9s'))).code).toBe('INVALID_ACTION');
  });
});

describe('draw penalties (2 and 3)', () => {
  it('makes a player without a defence draw the whole penalty and lose the turn', () => {
    const result = act(make({ hands: ['2h 5c', '7s 6d', '6h 7d'] }), 0, play('2h'));
    const state = result.newState as MacaoState;
    expect(state.hands[1]).toHaveLength(4);
    expect(state.penalty).toBeNull();
    expect(state.current).toBe(2);
    expect(result.events).toContainEqual({
      type: 'penalty_taken',
      data: { playerId: 'b', kind: 'draw', amount: 2 },
    });
  });

  it('lets a defender add a 2 or a 3 of any suit, and the penalty grows', () => {
    const afterTwo = act(make({ hands: ['2h 5c 9s', '3s 6d', '6s 7d'] }), 0, play('2h'))
      .newState as MacaoState;
    expect(afterTwo.current).toBe(1);
    expect(afterTwo.penalty).toEqual({ kind: 'draw', amount: 2 });

    const afterThree = act(afterTwo, 1, play('3s')).newState as MacaoState;
    // 2 + 3 = 5 cards, taken at once because c has no defence
    expect(afterThree.penalty).toBeNull();
    // c has no defence and takes 5
    expect(afterThree.current).toBe(0);
    expect(afterThree.hands[2]).toHaveLength(7);
  });

  it('refuses any other card while a penalty is active', () => {
    const state = act(make({ hands: ['2h 5c', '3s 6d 7h', '6s 7d'] }), 0, play('2h'))
      .newState as MacaoState;
    expect(ruleError(() => act(state, 1, play('7h'))).code).toBe('INVALID_ACTION');
    expect(ruleError(() => act(state, 1, PASS)).code).toBe('INVALID_ACTION');
  });

  it('lets a defender take the penalty by drawing', () => {
    const state = act(make({ hands: ['2h 5c', '3s 6d', '6h 7d'] }), 0, play('2h'))
      .newState as MacaoState;
    const taken = act(state, 1, DRAW).newState as MacaoState;
    expect(taken.hands[1]).toHaveLength(4);
    expect(taken.penalty).toBeNull();
    expect(taken.current).toBe(2);
  });

  it('treats the spent 2 on top as an ordinary card afterwards', () => {
    const afterPenalty = act(make({ hands: ['2h 5c', '7s 6d', '9h 4d'] }), 0, play('2h'))
      .newState as MacaoState;
    // c plays any heart (suit of the spent 2♥); another 2 would start a new penalty
    expect(act(afterPenalty, 2, play('9h')).newState).toBeDefined();
  });

  it('draws only the cards that exist when both piles run dry', () => {
    // the discard pile is just the 2♥ on top, so there is nothing to reshuffle
    const state = make({
      hands: ['9h 5c', '3s 6d', '6s 6h'],
      discard: '2h',
      draw: '9c',
      current: 1,
      penalty: { kind: 'draw', amount: 2 },
    });
    const after = act(state, 1, DRAW).newState as MacaoState;
    expect(after.hands[1]).toHaveLength(3);
    expect(after.current).toBe(2);
  });
});

describe('skip penalties (4)', () => {
  it('skips a player without a 4 and, with two players, plays the first one again', () => {
    const result = act(make({ hands: ['4h 5c 9h', '7s 6d'] }), 0, play('4h'));
    const state = result.newState as MacaoState;
    expect(state.current).toBe(0);
    expect(state.penalty).toBeNull();
    expect(result.events.some((e) => e.type === 'penalty_taken')).toBe(true);
  });

  it('passes the turn on to the next player in a bigger game', () => {
    const state = act(make({ hands: ['4h 5c', '7s 6d', '6h 7d'] }), 0, play('4h'))
      .newState as MacaoState;
    expect(state.current).toBe(2);
  });

  it('lets a 4 answer a 4 and grows the skip', () => {
    const afterFirst = act(make({ hands: ['4h 5c 9s', '4s 6d', '6s 7d'] }), 0, play('4h'))
      .newState as MacaoState;
    expect(afterFirst.current).toBe(1);
    expect(afterFirst.penalty).toEqual({ kind: 'skip', amount: 1 });

    const afterSecond = act(afterFirst, 1, play('4s')).newState as MacaoState;
    // c has no 4: c loses this turn and the next one
    expect(afterSecond.skips[2]).toBe(1);
    expect(afterSecond.current).toBe(0);
  });

  it('skips each lost turn when it comes round', () => {
    const state = make({
      hands: ['9h 5c 6h', '7s 6h', '6s 7d'],
      skips: [0, 0, 1],
      current: 0,
    });
    const afterA = act(state, 0, play('9h')).newState as MacaoState;
    expect(afterA.current).toBe(1);
    const afterB = act(afterA, 1, play('6h')).newState as MacaoState;
    // c is skipped, so a plays again
    expect(afterB.current).toBe(0);
    expect(afterB.skips[2]).toBe(0);
  });

  it('lets a player with a 4 accept the skip by passing', () => {
    const state = act(make({ hands: ['4h 5c', '4s 6d', '6h 7d'] }), 0, play('4h'))
      .newState as MacaoState;
    const accepted = act(state, 1, PASS).newState as MacaoState;
    expect(accepted.penalty).toBeNull();
    expect(accepted.current).toBe(2);
    expect(ruleError(() => act(state, 1, DRAW)).code).toBe('INVALID_ACTION');
  });

  it('refuses a 2 or a 3 against a skip', () => {
    const state = act(make({ hands: ['4h 5c', '4s 3s 6d', '6s 7d'] }), 0, play('4h'))
      .newState as MacaoState;
    expect(ruleError(() => act(state, 1, play('3s'))).code).toBe('INVALID_ACTION');
  });
});

describe('drawing', () => {
  it('draws for a player without a legal card and plays the drawn card when it fits', () => {
    const state = act(make({ hands: ['7c 5c', '9s 8d', '6c 6d'] }), 0, play('7c'))
      .newState as MacaoState;
    // b has nothing for 7♣, draws 9♣ (a club) and plays it
    expect(top(state)).toEqual(card('9c'));
    expect(state.hands[1]).toEqual(cards('9s 8d'));
    expect(state.current).toBe(2);
  });

  it('ends the turn when the drawn card is not legal', () => {
    const state = act(make({ hands: ['9h 5c', '7s 8d', '6h 6d'], draw: '5d 9c' }), 0, play('9h'))
      .newState as MacaoState;
    // b has no heart or 9: draws 5♦ (no use), keeps it, and c gets the turn
    expect(state.hands[1]).toEqual(cards('7s 8d 5d'));
    expect(state.current).toBe(2);
  });

  it('waits for a choice when the drawn card is a Jack or an Ace', () => {
    const state = act(make({ hands: ['9h 5c', '7s 8d', '6h 6d'], draw: 'Jh 9c' }), 0, play('9h'))
      .newState as MacaoState;
    expect(state.current).toBe(1);
    expect(state.drawn).toEqual(card('Jh'));
    expect(ruleError(() => act(state, 1, play('8d'))).code).toBe('INVALID_ACTION');
    const played = act(state, 1, play('Jh', { request: { rank: '6' } })).newState as MacaoState;
    expect(played.request).toEqual({ rank: '6' });
    const passed = act(state, 1, PASS).newState as MacaoState;
    expect(passed.current).toBe(2);
    expect(passed.hands[1]).toHaveLength(3);
  });

  it('lets a player draw by choice and play only the drawn card', () => {
    const state = make({ hands: ['9h 5c', '7s 8d'], draw: '8h 9c' });
    const drew = act(state, 0, DRAW).newState as MacaoState;
    expect(drew.current).toBe(0);
    expect(drew.drawn).toEqual(card('8h'));
    expect(ruleError(() => act(drew, 0, play('9h'))).code).toBe('INVALID_ACTION');
    expect(ruleError(() => act(drew, 0, DRAW)).code).toBe('INVALID_ACTION');

    const played = act(drew, 0, play('8h')).newState as MacaoState;
    expect(top(played)).toEqual(card('8h'));
    expect(played.current).toBe(1);
  });

  it('ends the turn at once when a voluntary draw gives an unusable card', () => {
    const state = act(make({ hands: ['9h 5c', '7s 8d'], draw: '5d' }), 0, DRAW)
      .newState as MacaoState;
    expect(state.hands[0]).toHaveLength(3);
    expect(state.current).toBe(1);
  });

  it('lets a player pass after drawing a playable card, and only then', () => {
    const state = make({ hands: ['9h 5c', '7s 8d'], draw: '8h 9c' });
    expect(ruleError(() => act(state, 0, PASS)).code).toBe('INVALID_ACTION');
    const drew = act(state, 0, DRAW).newState as MacaoState;
    expect((act(drew, 0, PASS).newState as MacaoState).current).toBe(1);
  });

  it('counts a draw that finds no card at all as a turn', () => {
    const state = act(make({ hands: ['9h 5c', '7s 8d'], draw: '', discard: '7h' }), 0, DRAW)
      .newState as MacaoState;
    expect(state.current).toBe(1);
    expect(state.hands[0]).toHaveLength(2);
  });
});

describe('reshuffling the draw pile', () => {
  const dry = (rngState: number) =>
    make({
      hands: ['9h 5c', '7s 8d'],
      draw: '',
      discard: '9d 8s 6h 3d 10s 7h',
      rngState,
    });

  it('keeps the top card, shuffles the rest with the private RNG state and draws from it', () => {
    const result = act(dry(12345), 0, DRAW);
    const state = result.newState as MacaoState;
    expect(top(state)).toEqual(card('7h'));
    expect(state.discard).toHaveLength(1);
    expect(state.drawPile).toHaveLength(4);
    expect(state.hands[0]).toHaveLength(3);
    expect(result.events.map((e) => e.type)).toContain('deck_reshuffled');
    expect(state.rngState).not.toBe(12345);
  });

  it('is deterministic for a given RNG state and differs for another', () => {
    const first = act(dry(12345), 0, DRAW).newState as MacaoState;
    const again = act(dry(12345), 0, DRAW).newState as MacaoState;
    const other = act(dry(999), 0, DRAW).newState as MacaoState;
    expect(again).toEqual(first);
    expect([...other.drawPile, ...other.hands[0]!]).not.toEqual([
      ...first.drawPile,
      ...first.hands[0]!,
    ]);
  });

  it('keeps all cards when it reshuffles', () => {
    const state = act(dry(5), 0, DRAW).newState as MacaoState;
    const all = [...state.hands.flat(), ...state.drawPile, ...state.discard];
    expect(all).toHaveLength(2 + 2 + 6);
  });
});

describe('Macao', () => {
  const twoCardsLeft = (hands: string[] = ['9h 5c', '7s 8d', '6s 6d']) =>
    make({ hands, reportable: undefined });

  it('lets any other player report a missing declaration, who draws five cards', () => {
    const played = act(twoCardsLeft(), 0, play('9h')).newState as MacaoState;
    expect(played.reportable).toBe(0);
    expect(macaoModule.sanitize(played, 'b')).toMatchObject({ reportablePlayerId: 'a' });

    const reported = act(played, 2, REPORT);
    const state = reported.newState as MacaoState;
    expect(state.hands[0]).toHaveLength(6);
    expect(state.reportable).toBeNull();
    expect(state.current).toBe(played.current);
    expect(reported.events).toContainEqual({
      type: 'macao_reported',
      data: { reportedId: 'a', reporterId: 'c' },
    });
  });

  it('accepts no second report', () => {
    const played = act(twoCardsLeft(), 0, play('9h')).newState as MacaoState;
    const reported = act(played, 2, REPORT).newState as MacaoState;
    expect(ruleError(() => act(reported, 1, REPORT)).code).toBe('INVALID_ACTION');
  });

  it('refuses a report from the player themselves, or when nothing is reportable', () => {
    const played = act(twoCardsLeft(), 0, play('9h')).newState as MacaoState;
    expect(ruleError(() => act(played, 0, REPORT)).code).toBe('INVALID_ACTION');
    expect(ruleError(() => act(twoCardsLeft(), 1, REPORT)).code).toBe('INVALID_ACTION');
  });

  it('accepts no report with a declaration', () => {
    const played = act(twoCardsLeft(), 0, play('9h', { declaredMacao: true }))
      .newState as MacaoState;
    expect(played.reportable).toBeNull();
    expect(ruleError(() => act(played, 2, REPORT)).code).toBe('INVALID_ACTION');
  });

  it('closes the window when the next accepted action arrives', () => {
    const played = act(twoCardsLeft(['9h 5c', '7s 8d', '6s 6d']), 0, play('9h'))
      .newState as MacaoState;
    const next = act(played, played.current, DRAW).newState as MacaoState;
    expect(ruleError(() => act(next, 2, REPORT)).code).toBe('INVALID_ACTION');
  });

  it('keeps the window open through automatic moves of the following players', () => {
    // b has no legal card and draws automatically, yet a can still be reported
    const played = act(make({ hands: ['9h 5c', '7s 8d', '6s 6d'], draw: '5d' }), 0, play('9h'))
      .newState as MacaoState;
    expect(played.reportable).toBe(0);
  });

  it('ignores a declaration when the player is not down to one card', () => {
    const state = act(
      make({ hands: ['9h 5c 6c', '7s 8d', '6s 6d'] }),
      0,
      play('9h', { declaredMacao: true }),
    ).newState as MacaoState;
    expect(state.reportable).toBeNull();
  });

  it('counts a card played automatically as declared', () => {
    // b draws 9♣ automatically, plays it, and is left with one card
    const state = act(make({ hands: ['7c 5c 6c', '9s', '6c 6d'], draw: '9c 5d' }), 0, play('7c'))
      .newState as MacaoState;
    expect(state.reportable).toBeNull();
  });
});

describe('winning', () => {
  it('ends the game at once on the last card, without running its effect', () => {
    const result = act(make({ hands: ['2h', '7s 8d', '6s 6d'] }), 0, play('2h'));
    const state = result.newState as MacaoState;
    expect(macaoModule.isTerminal(state)).toBe(true);
    expect(state.penalty).toBeNull();
    expect(macaoModule.getResult(state)).toEqual({
      terminationReason: 'completed',
      placements: [
        { playerId: 'a', rank: 1 },
        { playerId: 'b', rank: 2 },
        { playerId: 'c', rank: 2 },
      ],
    });
  });

  it('refuses everything after the game is over', () => {
    const over = act(make({ hands: ['9h', '7s 8d'] }), 0, play('9h')).newState as MacaoState;
    expect(ruleError(() => act(over, 1, play('7s'))).code).toBe('GAME_OVER');
    expect(ruleError(() => act(over, 1, REPORT)).code).toBe('GAME_OVER');
  });

  it('throws when asked for the result too early', () => {
    expect(() => macaoModule.getResult(make({ hands: ['9h 5c', '7s 8d'] }))).toThrow();
  });
});

describe('turn limit', () => {
  it('ends the game when the counter reaches the limit and gives the fewest cards the win', () => {
    const state = make({ hands: ['9h 5c 6c', '7s', '6s 6d 5s'], turn: MACAO_MAX_TURNS - 1 });
    const result = macaoModule.getResult(act(state, 0, play('9h')).newState);
    expect(result.terminationReason).toBe('turn_limit');
    expect(result.placements).toEqual([
      { playerId: 'a', rank: 2 },
      { playerId: 'b', rank: 1 },
      { playerId: 'c', rank: 2 },
    ]);
  });

  it('is a draw when several players hold the fewest cards', () => {
    const state = make({ hands: ['9h 5c', '7s', '6s 6d 5s'], turn: MACAO_MAX_TURNS - 1 });
    const result = macaoModule.getResult(act(state, 0, play('9h')).newState);
    expect(result.terminationReason).toBe('turn_limit');
    expect(result.placements.filter((p) => p.rank === 1).length).toBeGreaterThan(1);
  });

  it('counts automatic draws, passes and skips as turns', () => {
    // b draws automatically (+1), a's play (+1): the counter moves by two
    const state = make({ hands: ['9h 5c 6c', '7s 8d', '6h 6d'], draw: '5d', turn: 10 });
    expect((act(state, 0, play('9h')).newState as MacaoState).turn).toBe(12);

    const skipped = make({ hands: ['4h 5c 9h', '7s 6d'], turn: 10 });
    // 4h (+1), b's skipped turn (+1)
    expect((act(skipped, 0, play('4h')).newState as MacaoState).turn).toBe(12);
  });
});

describe('eliminating a player', () => {
  it('ends a two-player game in favour of the other player with the given reason', () => {
    const result = eliminatePlayer(make({ hands: ['9h 5c', '7s 8d'] }), 'a', 'timeout_forfeit');
    expect(macaoModule.getResult(result.newState)).toEqual({
      terminationReason: 'timeout_forfeit',
      placements: [
        { playerId: 'a', rank: 2 },
        { playerId: 'b', rank: 1 },
      ],
    });
  });

  it('keeps a bigger game going and puts the hand at the bottom of the draw pile in order', () => {
    const state = make({ hands: ['9h 5c', '7s 8d', '6s 6d'], draw: '10c 9c', current: 0 });
    const result = eliminatePlayer(state, 'b', 'disconnect_forfeit');
    const after = result.newState as MacaoState;
    expect(after.hands[1]).toEqual([]);
    expect(after.drawPile).toEqual(cards('10c 9c 7s 8d'));
    expect(after.eliminated).toEqual([false, true, false]);
    expect(result.events).toContainEqual({
      type: 'player_eliminated',
      data: { playerId: 'b', reason: 'disconnect_forfeit' },
    });
  });

  it('leaves the cards on the discard pile where they are', () => {
    const state = make({ hands: ['9h 5c', '7s 8d', '6s 6d'], discard: '3d 7h' });
    const after = eliminatePlayer(state, 'b', 'timeout_forfeit').newState as MacaoState;
    expect(after.discard).toEqual(cards('3d 7h'));
  });

  it('passes the turn on and drops the penalty and request of an eliminated current player', () => {
    const state = make({
      hands: ['9h 5c', '3s 8d', '6h 6d'],
      current: 1,
      penalty: { kind: 'draw', amount: 2 },
    });
    const after = eliminatePlayer(state, 'b', 'timeout_forfeit').newState as MacaoState;
    expect(after.penalty).toBeNull();
    expect(after.current).toBe(2);
  });

  it('skips eliminated players in the turn order', () => {
    const state = make({
      hands: ['9h 5c', '7s 8d', '6h 6d'],
      eliminated: [false, true, false],
    });
    expect((act(state, 0, play('9h')).newState as MacaoState).current).toBe(2);
  });

  it('refuses actions of an eliminated player and ends the game when one player is left', () => {
    const three = make({ hands: ['9h 5c', '7s 8d', '6s 6d'] });
    const withoutB = eliminatePlayer(three, 'b', 'timeout_forfeit').newState as MacaoState;
    expect(ruleError(() => act(withoutB, 1, REPORT)).code).toBe('INVALID_ACTION');
    const last = eliminatePlayer(withoutB, 'c', 'disconnect_forfeit').newState;
    expect(macaoModule.getResult(last)).toEqual({
      terminationReason: 'disconnect_forfeit',
      placements: [
        { playerId: 'a', rank: 1 },
        { playerId: 'b', rank: 2 },
        { playerId: 'c', rank: 2 },
      ],
    });
  });

  it('clears a pending report of the eliminated player', () => {
    const state = make({ hands: ['9h 5c', '7s 8d', '6s 6d'], reportable: 0 });
    expect(
      (eliminatePlayer(state, 'a', 'timeout_forfeit').newState as MacaoState).reportable,
    ).toBeNull();
  });
});

describe('sanitize', () => {
  const state = make({
    hands: ['9h 5c Kd', '7s 8d', '6s 6d 2c 3c'],
    discard: '4d 7h',
    draw: '10c 9c 8c',
    rngState: 424242,
  });

  it('shows the own hand and only the sizes of the others', () => {
    const view = macaoModule.sanitize(state, 'a');
    expect(view).toMatchObject({
      gameKey: 'macao',
      hand: cards('9h 5c Kd'),
      handSizes: { a: 3, b: 2, c: 4 },
      topCard: card('7h'),
      discardCount: 2,
      drawPileCount: 3,
      currentPlayerId: 'a',
      turnDeadlineAt: null,
    });
  });

  it('never exposes the hands of others, the draw pile or the RNG state', () => {
    const view = macaoModule.sanitize(state, 'b');
    for (const key of ['hands', 'drawPile', 'discard', 'rngState', 'skips', 'drawn']) {
      expect(view).not.toHaveProperty(key);
    }
    const text = JSON.stringify(view);
    expect(text).not.toContain('424242');
    // the 2♣ and 3♣ of the third player stay hidden
    expect(text).not.toContain('"rank":"2"');
    expect(text).not.toContain('"rank":"3"');
  });

  it('lists the playable cards, draw and pass options for the current player only', () => {
    const mine = macaoModule.sanitize(state, 'a') as {
      playable: Card[];
      canDraw: boolean;
      canPass: boolean;
    };
    expect(mine.playable).toEqual(cards('9h'));
    expect(mine.canDraw).toBe(true);
    expect(mine.canPass).toBe(false);
    const theirs = macaoModule.sanitize(state, 'b') as { playable: Card[]; canDraw: boolean };
    expect(theirs.playable).toEqual([]);
    expect(theirs.canDraw).toBe(false);
  });

  it('shows a drawn card to its owner only', () => {
    const drew = make({ hands: ['9h 5c 8h', '7s 8d'], drawn: '8h' });
    expect(macaoModule.sanitize(drew, 'a')).toMatchObject({
      drawnCard: card('8h'),
      canPass: true,
      playable: cards('8h'),
    });
    expect(macaoModule.sanitize(drew, 'b')).toMatchObject({ drawnCard: null });
  });

  it('shows the active penalty and request to everyone', () => {
    const view = macaoModule.sanitize(
      make({ hands: ['9h', '7s'], penalty: { kind: 'draw', amount: 4 } }),
      'b',
    );
    expect(view).toMatchObject({ penalty: { kind: 'draw', amount: 4 }, request: null });
  });
});

describe('whole games', () => {
  // always plays the first playable card (declaring Macao, asking for a fixed rank or suit)
  function chooseMove(state: MacaoState): GameAction {
    const id = ids[state.current]!;
    const view = macaoModule.sanitize(state, id) as {
      playable: Card[];
      canDraw: boolean;
      canPass: boolean;
    };
    const first = view.playable[0];
    if (first) {
      const request =
        first.rank === 'J' ? { rank: '7' } : first.rank === 'A' ? { suit: 'clubs' } : undefined;
      return play(`${first.rank}${first.suit[0]}`, { request, declaredMacao: true });
    }
    return view.canDraw ? DRAW : PASS;
  }

  it.each([2, 3, 4])(
    'plays %i-player games to the end with all 52 cards accounted for',
    (count) => {
      for (let seed = 1; seed <= 20; seed++) {
        let state = macaoModule.createInitialState(
          players(count),
          seededRandom(seed * 31),
        ) as MacaoState;
        for (let step = 0; step < 5000 && !macaoModule.isTerminal(state); step++) {
          state = act(state, state.current, chooseMove(state)).newState as MacaoState;
          const all = [...state.hands.flat(), ...state.drawPile, ...state.discard];
          expect(all).toHaveLength(52);
        }
        expect(macaoModule.isTerminal(state)).toBe(true);
      }
    },
  );
});

describe('facts', () => {
  const won = (hands: [string, string], overrides: Partial<MacaoState> = {}) =>
    act(make({ hands, overrides }), 0, play(hands[0].split(' ')[0]!)).newState as MacaoState;

  it('rewards a clean win: no missing declaration was ever punished', () => {
    const state = won(['9h', '7s 8d']);
    expect(macaoModule.facts!(state)).toEqual({
      a: { forfeited: false, macaoCleanFinish: true, macaoComeback: false },
      b: { forfeited: false, macaoCleanFinish: false, macaoComeback: false },
    });
  });

  it('takes the clean finish away from a winner who was reported earlier', () => {
    const state = won(['9h', '7s 8d'], { reports: [1, 0] });
    expect(macaoModule.getResult(state).placements[0]).toEqual({ playerId: 'a', rank: 1 });
    expect(macaoModule.facts!(state).a?.macaoCleanFinish).toBe(false);
  });

  it('counts a report in the state of the reported player', () => {
    let state = act(make({ hands: ['9h 5c', '7s 8d', '6s 6d'] }), 0, play('9h'))
      .newState as MacaoState;
    state = act(state, 2, REPORT).newState as MacaoState;
    expect(state.reports).toEqual([1, 0, 0]);
  });

  it('rewards a comeback win only after holding 15 cards', () => {
    expect(macaoModule.facts!(won(['9h', '7s 8d'], { maxHand: [15, 5] })).a?.macaoComeback).toBe(
      true,
    );
    expect(macaoModule.facts!(won(['9h', '7s 8d'], { maxHand: [14, 5] })).a?.macaoComeback).toBe(
      false,
    );
  });

  it('tracks the biggest hand through penalties and reports', () => {
    const afterPenalty = act(make({ hands: ['2h 5c', '7s 6d', '6h 6d'] }), 0, play('2h'))
      .newState as MacaoState;
    expect(afterPenalty.maxHand[1]).toBeGreaterThanOrEqual(4);
    let state = act(make({ hands: ['9h 5c', '7s 8d', '6s 6d'] }), 0, play('9h'))
      .newState as MacaoState;
    state = act(state, 2, REPORT).newState as MacaoState;
    expect(state.maxHand[0]).toBe(6);
  });

  it('marks a player who forfeited and gives nobody a win-based fact for a forfeit win', () => {
    const state = eliminatePlayer(
      make({ hands: ['9h 5c', '7s 8d'] }),
      'a',
      'timeout_forfeit',
    ).newState;
    expect(macaoModule.facts!(state)).toEqual({
      a: { forfeited: true, macaoCleanFinish: false, macaoComeback: false },
      b: { forfeited: false, macaoCleanFinish: false, macaoComeback: false },
    });
  });
});
