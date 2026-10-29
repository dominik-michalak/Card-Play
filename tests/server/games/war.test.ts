import {
  GameRuleError,
  RANKS,
  WAR_MAX_ROUNDS,
  type Card,
  type Deck,
  type GameAction,
  type GamePlayer,
  type Rank,
} from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import { createDeck } from '../../../server/src/games/deck';
import {
  createWarState,
  createWarStateFromStacks,
  forfeitWar,
  resolveFlipTimeout,
  warModule,
  type WarState,
} from '../../../server/src/games/war/war';
import { seededRandom } from '../../helpers/seeded-random';

const alice: GamePlayer = { id: 'alice', username: 'alice', isBot: false };
const bob: GamePlayer = { id: 'bob', username: 'bob', isBot: false };
const players = [alice, bob];

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
// card(rank, suit index): suits make cards of one rank distinguishable in order checks
const card = (rank: Rank, suit = 0): Card => ({ rank, suit: SUITS[suit]! });
const filler = (count: number, rank: Rank = '2'): Deck =>
  Array.from({ length: count }, (_, i) => card(rank, i % 4));

const flip: GameAction = { type: 'flip' };

function startWith(a: Deck, b: Deck): WarState {
  return createWarStateFromStacks(players, [a, b]);
}

// both players confirm the round
function playRound(state: WarState) {
  const first = warModule.applyAction(state, flip, 'alice');
  const second = warModule.applyAction(first.newState, flip, 'bob');
  return { newState: second.newState, events: [...first.events, ...second.events] };
}

function expectRuleError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GameRuleError);
    expect((error as GameRuleError).code).toBe(code);
    return;
  }
  throw new Error(`expected GameRuleError ${code}`);
}

describe('initial state', () => {
  it('deals 26 cards each from a full deck without repeats', () => {
    const state = warModule.createInitialState(players, seededRandom(42));
    expect(state.stacks[0]).toHaveLength(26);
    expect(state.stacks[1]).toHaveLength(26);
    const all = [...state.stacks[0], ...state.stacks[1]].map((c) => `${c.rank}-${c.suit}`);
    expect(new Set(all).size).toBe(52);
    expect(state.result).toBeNull();
    expect(state.round).toBe(0);
    expect(warModule.isTerminal(state)).toBe(false);
  });

  it('is repeatable for the same seed', () => {
    const a = warModule.createInitialState(players, seededRandom(5));
    const b = warModule.createInitialState(players, seededRandom(5));
    expect(a).toEqual(b);
  });

  it('deals an ordered deck one card at a time', () => {
    const deck = createDeck();
    const state = createWarState(players, deck);
    expect(state.stacks[0][0]).toEqual(deck[0]);
    expect(state.stacks[1][0]).toEqual(deck[1]);
    expect(state.stacks[0][1]).toEqual(deck[2]);
  });

  it('rejects a wrong number or duplicate of players and a short deck', () => {
    expect(() => createWarState([alice], createDeck())).toThrow();
    expect(() => createWarState([alice, alice], createDeck())).toThrow();
    expect(() => createWarState(players, createDeck().slice(1))).toThrow();
  });
});

describe('ordinary round', () => {
  it('waits for both flips', () => {
    const state = startWith([card('A'), ...filler(3)], [card('2'), ...filler(3)]);
    const { newState, events } = warModule.applyAction(state, flip, 'alice');
    expect(newState.round).toBe(0);
    expect(newState.flipped).toEqual([true, false]);
    expect(events).toEqual([{ type: 'flip_accepted', data: { playerId: 'alice' } }]);
    expect(newState.stacks[0]).toHaveLength(4);
  });

  it('gives the pool to the higher card, seat 0 card first', () => {
    const state = startWith([card('A', 1), ...filler(2)], [card('K', 2), ...filler(2)]);
    const { newState, events } = playRound(state);
    expect(newState.stacks[0]).toHaveLength(4);
    expect(newState.stacks[1]).toHaveLength(2);
    expect(newState.stacks[0].slice(-2)).toEqual([card('A', 1), card('K', 2)]);
    expect(newState.flipped).toEqual([false, false]);
    expect(newState.round).toBe(1);
    expect(events.at(-1)).toEqual({
      type: 'round_resolved',
      data: {
        round: 1,
        comparisons: [[card('A', 1), card('K', 2)]],
        winnerId: 'alice',
        poolSize: 2,
      },
    });
  });

  it('keeps the seat order of the pool when seat 1 wins', () => {
    const state = startWith([card('3', 1), ...filler(2)], [card('9', 2), ...filler(2)]);
    const { newState } = playRound(state);
    expect(newState.stacks[1].slice(-2)).toEqual([card('3', 1), card('9', 2)]);
    expect(newState.stacks[0]).toHaveLength(2);
  });

  it('compares ranks only, ignoring suits, with ace on top', () => {
    const state = startWith([card('2', 0), ...filler(2)], [card('A', 3), ...filler(2)]);
    expect(playRound(state).newState.lastRound?.winnerId).toBe('bob');
    expect(RANKS.indexOf('10')).toBeLessThan(RANKS.indexOf('J'));
    const tens = startWith([card('10'), ...filler(2)], [card('J'), ...filler(2)]);
    expect(playRound(tens).newState.lastRound?.winnerId).toBe('bob');
  });

  it('can start the next round after one is resolved', () => {
    const state = startWith(
      [card('A'), card('A', 1), ...filler(2)],
      [card('2'), card('3'), ...filler(2)],
    );
    const next = playRound(playRound(state).newState).newState;
    expect(next.round).toBe(2);
  });
});

describe('war', () => {
  it('adds three face-down cards, then one face-up, and the winner takes everything in order', () => {
    const a: Deck = [card('5', 0), card('2', 0), card('3', 0), card('4', 0), card('K', 0)];
    const b: Deck = [card('5', 1), card('6', 1), card('7', 1), card('8', 1), card('9', 1)];
    const { newState, events } = playRound(
      startWith([...a, ...filler(2, '3')], [...b, ...filler(2, '4')]),
    );

    const expectedPool = [
      card('5', 0),
      card('5', 1),
      card('2', 0),
      card('6', 1),
      card('3', 0),
      card('7', 1),
      card('4', 0),
      card('8', 1),
      card('K', 0),
      card('9', 1),
    ];
    expect(newState.stacks[0].slice(-10)).toEqual(expectedPool);
    expect(newState.stacks[0]).toHaveLength(12);
    expect(newState.stacks[1]).toHaveLength(2);
    expect(newState.round).toBe(1);

    const summary = events.at(-1)?.data as { comparisons: unknown[]; poolSize: number };
    expect(summary.comparisons).toEqual([
      [card('5', 0), card('5', 1)],
      [card('K', 0), card('9', 1)],
    ]);
    expect(summary.poolSize).toBe(10);
  });

  it('repeats the war on another tie and keeps one pool', () => {
    const a: Deck = [
      card('5'),
      ...filler(3),
      card('7'),
      ...filler(3),
      card('Q'),
      ...filler(1, '3'),
    ];
    const b: Deck = [
      card('5', 1),
      ...filler(3),
      card('7', 1),
      ...filler(3),
      card('9', 1),
      ...filler(1, '4'),
    ];
    const { newState } = playRound(startWith(a, b));
    expect(newState.round).toBe(1);
    expect(newState.lastRound?.comparisons).toHaveLength(3);
    // first comparison (2 cards) plus two wars of 8 cards each
    expect(newState.lastRound?.poolSize).toBe(18);
    expect(newState.stacks[0]).toHaveLength(1 + 18);
    expect(newState.stacks[1]).toHaveLength(1);
  });

  it('is lost by the player without four cards when only he is short', () => {
    // alice ties with 3 cards left in total, so she cannot put 3 down and 1 up
    const state = startWith([card('5'), ...filler(2)], [card('5', 1), ...filler(10)]);
    const { newState } = playRound(state);
    expect(warModule.isTerminal(newState)).toBe(true);
    expect(warModule.getResult(newState)).toEqual({
      terminationReason: 'all_cards',
      placements: [
        { playerId: 'alice', rank: 2 },
        { playerId: 'bob', rank: 1 },
      ],
    });
    expect(newState.lastRound?.winnerId).toBeNull();
  });

  it('loses when exactly three cards are left after the tie (no last card rescue)', () => {
    const state = startWith([card('5'), ...filler(3)], [card('5', 1), ...filler(10)]);
    expect(warModule.getResult(playRound(state).newState).placements[0]).toEqual({
      playerId: 'alice',
      rank: 2,
    });
  });

  it('fights the war with exactly four cards left', () => {
    const a: Deck = [card('5'), card('2'), card('3'), card('4'), card('A')];
    const b: Deck = [card('5', 1), ...filler(3), card('K', 1), ...filler(1)];
    const { newState } = playRound(startWith(a, b));
    expect(newState.lastRound?.winnerId).toBe('alice');
  });

  it('gives the win to the player with more cards when both are short', () => {
    const state = startWith([card('5'), ...filler(1)], [card('5', 1), ...filler(2)]);
    const result = warModule.getResult(playRound(state).newState);
    expect(result.terminationReason).toBe('all_cards');
    expect(result.placements).toEqual([
      { playerId: 'alice', rank: 2 },
      { playerId: 'bob', rank: 1 },
    ]);
  });

  it('is a draw when both are short with equal stacks', () => {
    const state = startWith([card('5'), ...filler(2)], [card('5', 1), ...filler(2)]);
    const result = warModule.getResult(playRound(state).newState);
    expect(result.terminationReason).toBe('draw');
    expect(result.placements.map((p) => p.rank)).toEqual([1, 1]);
  });
});

describe('end of the game', () => {
  it('ends with all_cards when a stack is empty after a round', () => {
    const state = startWith([card('2')], [card('A'), ...filler(3)]);
    const { newState } = playRound(state);
    expect(newState.stacks[0]).toHaveLength(0);
    expect(warModule.getResult(newState)).toEqual({
      terminationReason: 'all_cards',
      placements: [
        { playerId: 'alice', rank: 2 },
        { playerId: 'bob', rank: 1 },
      ],
    });
  });

  it('ends after the round limit and the bigger stack wins', () => {
    const base = startWith([card('A'), ...filler(5)], [card('2'), ...filler(2)]);
    const almost: WarState = { ...base, round: WAR_MAX_ROUNDS - 2 };
    const before = playRound(almost).newState;
    expect(warModule.isTerminal(before)).toBe(false);

    const { newState } = playRound({ ...base, round: WAR_MAX_ROUNDS - 1 });
    expect(newState.round).toBe(WAR_MAX_ROUNDS);
    expect(warModule.getResult(newState)).toEqual({
      terminationReason: 'round_limit',
      placements: [
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 2 },
      ],
    });
  });

  it('is a draw at the round limit with equal stacks', () => {
    // alice 2 -> 3 cards, bob 4 -> 3 cards
    const base = startWith([card('A'), card('3')], [card('2'), ...filler(3)]);
    const { newState } = playRound({ ...base, round: WAR_MAX_ROUNDS - 1 });
    const result = warModule.getResult(newState);
    expect(result.terminationReason).toBe('round_limit');
    expect(result.placements.map((p) => p.rank)).toEqual([1, 1]);
  });

  it('rejects further actions with GAME_OVER', () => {
    const state = startWith([card('2')], [card('A'), ...filler(3)]);
    const { newState } = playRound(state);
    expectRuleError(() => warModule.applyAction(newState, flip, 'alice'), 'GAME_OVER');
  });

  it('refuses to give a result before the end', () => {
    const state = warModule.createInitialState(players, seededRandom(1));
    expect(() => warModule.getResult(state)).toThrow();
  });
});

describe('invalid actions', () => {
  const state = startWith([card('A'), ...filler(3)], [card('2'), ...filler(3)]);

  it('rejects a player who is not in the game', () => {
    expectRuleError(() => warModule.applyAction(state, flip, 'mallory'), 'INVALID_ACTION');
  });

  it('rejects unknown action types', () => {
    expectRuleError(
      () => warModule.applyAction(state, { type: 'flipp' }, 'alice'),
      'INVALID_ACTION',
    );
    expectRuleError(
      () => warModule.applyAction(state, { type: 'timeout_forfeit' }, 'alice'),
      'INVALID_ACTION',
    );
  });

  it('rejects a second flip in the same round', () => {
    const once = warModule.applyAction(state, flip, 'alice').newState;
    expectRuleError(() => warModule.applyAction(once, flip, 'alice'), 'INVALID_ACTION');
  });

  it('ignores a payload: the flip cannot choose a card', () => {
    const crafted: GameAction = { type: 'flip', payload: { card: { rank: 'A', suit: 'spades' } } };
    const a = playRound(state).newState;
    const once = warModule.applyAction(state, crafted, 'alice').newState;
    const b = warModule.applyAction(once, crafted, 'bob').newState;
    expect(b).toEqual(a);
  });
});

describe('purity', () => {
  it('does not change the input state and repeats for the same input', () => {
    const state = warModule.createInitialState(players, seededRandom(3));
    const snapshot = structuredClone(state);
    const once = warModule.applyAction(state, flip, 'alice').newState;
    const first = warModule.applyAction(once, flip, 'bob');
    const second = warModule.applyAction(once, flip, 'bob');
    expect(state).toEqual(snapshot);
    expect(first).toEqual(second);
  });
});

describe('flip timeout', () => {
  const state = startWith([card('A'), ...filler(3)], [card('2'), ...filler(3)]);

  it('makes the player who did not flip lose', () => {
    const aliceFlipped = warModule.applyAction(state, flip, 'alice').newState;
    expect(warModule.getResult(resolveFlipTimeout(aliceFlipped))).toEqual({
      terminationReason: 'timeout_forfeit',
      placements: [
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 2 },
      ],
    });

    const bobFlipped = warModule.applyAction(state, flip, 'bob').newState;
    expect(warModule.getResult(resolveFlipTimeout(bobFlipped)).placements[1]).toEqual({
      playerId: 'bob',
      rank: 1,
    });
  });

  it('is a draw when nobody flipped', () => {
    expect(warModule.getResult(resolveFlipTimeout(state))).toEqual({
      terminationReason: 'double_timeout',
      placements: [
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 1 },
      ],
    });
  });

  it('cannot end a finished game again', () => {
    expectRuleError(() => resolveFlipTimeout(resolveFlipTimeout(state)), 'GAME_OVER');
  });
});

describe('sanitize', () => {
  const state = warModule.createInitialState(players, seededRandom(11));

  it('shows pile sizes but no cards of either pile', () => {
    for (const viewer of ['alice', 'bob']) {
      const view = warModule.sanitize(state, viewer);
      expect(view.stackSizes).toEqual({ alice: 26, bob: 26 });
      expect(view).not.toHaveProperty('stacks');
      const json = JSON.stringify(view);
      for (const hidden of state.stacks.flat()) {
        expect(json).not.toContain(JSON.stringify(hidden));
      }
    }
  });

  it('shows the face-up cards of the last round and who confirmed the next one', () => {
    const played = playRound(state).newState;
    const once = warModule.applyAction(played, flip, 'bob').newState;
    const view = warModule.sanitize(once, 'alice');
    expect(view.round).toBe(1);
    expect(view.flippedPlayerIds).toEqual(['bob']);
    expect(view.lastRound?.comparisons[0]).toHaveLength(2);
    expect(view.result).toBeNull();
  });

  it('does not reveal the face-down cards of a war', () => {
    const a: Deck = [
      card('5', 0),
      card('2', 0),
      card('3', 0),
      card('4', 0),
      card('K', 0),
      ...filler(2),
    ];
    const b: Deck = [
      card('5', 1),
      card('6', 1),
      card('7', 1),
      card('8', 1),
      card('9', 1),
      ...filler(2),
    ];
    const view = warModule.sanitize(playRound(startWith(a, b)).newState, 'bob');
    const json = JSON.stringify(view.lastRound);
    for (const hidden of [
      card('2', 0),
      card('3', 0),
      card('4', 0),
      card('6', 1),
      card('7', 1),
      card('8', 1),
    ]) {
      expect(json).not.toContain(JSON.stringify(hidden));
    }
  });

  it('includes the result when the game is over', () => {
    const over = resolveFlipTimeout(state);
    expect(warModule.sanitize(over, 'alice').result?.terminationReason).toBe('double_timeout');
  });
});

describe('whole games', () => {
  it('always finish within the round limit and never lose cards on the way', () => {
    for (let seed = 1; seed <= 25; seed++) {
      let state = warModule.createInitialState(players, seededRandom(seed));
      while (!warModule.isTerminal(state)) {
        state = playRound(state).newState;
        if (!warModule.isTerminal(state)) {
          expect(state.stacks[0].length + state.stacks[1].length).toBe(52);
        }
      }
      expect(state.round).toBeLessThanOrEqual(WAR_MAX_ROUNDS);
      const { placements, terminationReason } = warModule.getResult(state);
      expect(placements).toHaveLength(2);
      expect(['all_cards', 'round_limit', 'draw']).toContain(terminationReason);
    }
  });
});

describe('forfeitWar', () => {
  it.each(['timeout_forfeit', 'disconnect_forfeit'] as const)(
    'gives the other player the win after a %s',
    (reason) => {
      const state = startWith(filler(26), filler(26));
      expect(warModule.getResult(forfeitWar(state, 'alice', reason))).toEqual({
        terminationReason: reason,
        placements: [
          { playerId: 'alice', rank: 2 },
          { playerId: 'bob', rank: 1 },
        ],
      });
      expect(warModule.getResult(forfeitWar(state, 'bob', reason)).placements).toEqual([
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 2 },
      ]);
    },
  );

  it('does not change the state it was given', () => {
    const state = startWith(filler(26), filler(26));
    forfeitWar(state, 'alice', 'timeout_forfeit');
    expect(state.result).toBeNull();
  });
});

describe('facts', () => {
  const flipBoth = (state: WarState) => playRound(state).newState;
  // initial tie, then `ties` more ties inside the war, then a decision for alice
  function chainState(extraTies: number): WarState {
    const mine: Deck = [card('K', 0)];
    const theirs: Deck = [card('K', 1)];
    const ranks: Rank[] = ['5', '7', '9'];
    for (let i = 0; i < extraTies; i++) {
      mine.push(...filler(3, '2'), card(ranks[i]!, 0));
      theirs.push(...filler(3, '3'), card(ranks[i]!, 1));
    }
    mine.push(...filler(3, '2'), card('A', 0));
    theirs.push(...filler(3, '3'), card('9', 1));
    return startWith([...mine, ...filler(10, '4')], [...theirs, ...filler(10, '4')]);
  }

  it('marks the winner of a pool won after three face-up comparisons inside a war', () => {
    const state = flipBoth(chainState(2)); // initial tie + two ties in the war + the deciding one
    expect(state.lastRound?.comparisons).toHaveLength(4);
    expect(warModule.facts!(state)).toEqual({
      alice: { forfeited: false, warChain3: true },
      bob: { forfeited: false, warChain3: false },
    });
  });

  it('needs three comparisons inside the war, not two', () => {
    const state = flipBoth(chainState(1));
    expect(state.lastRound?.comparisons).toHaveLength(3);
    expect(warModule.facts!(state).alice?.warChain3).toBe(false);
  });

  it('remembers a chain from an earlier round', () => {
    let state = flipBoth(chainState(2));
    state = flipBoth(state);
    expect(warModule.facts!(state).alice?.warChain3).toBe(true);
  });

  it('marks the player who lost to a forfeit', () => {
    const state = startWith(filler(26), filler(26));
    expect(warModule.facts!(forfeitWar(state, 'alice', 'timeout_forfeit'))).toEqual({
      alice: { forfeited: true, warChain3: false },
      bob: { forfeited: false, warChain3: false },
    });
    expect(warModule.facts!(forfeitWar(state, 'bob', 'disconnect_forfeit')).bob?.forfeited).toBe(
      true,
    );
  });

  it('does not call a double timeout a forfeit', () => {
    const state = startWith(filler(26), filler(26));
    expect(warModule.facts!(resolveFlipTimeout(state)).alice?.forfeited).toBe(false);
  });
});
