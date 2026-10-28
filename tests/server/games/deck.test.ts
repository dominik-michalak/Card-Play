import { describe, expect, it } from 'vitest';
import { createDeck, shuffle } from '../../../server/src/games/deck';
import { secureRandom } from '../../../server/src/games/random';
import { seededRandom } from '../../helpers/seeded-random';

const key = (card: { suit: string; rank: string }) => `${card.rank}-${card.suit}`;

describe('createDeck', () => {
  it('has 52 different cards and no jokers', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(key)).size).toBe(52);
  });
});

describe('shuffle', () => {
  it('keeps the same cards and does not touch the input', () => {
    const deck = createDeck();
    const before = deck.map(key);
    const shuffled = shuffle(deck, seededRandom(1));
    expect(deck.map(key)).toEqual(before);
    expect([...shuffled.map(key)].sort()).toEqual([...before].sort());
  });

  it('is repeatable for the same seed and differs for another one', () => {
    const a = shuffle(createDeck(), seededRandom(7)).map(key);
    const b = shuffle(createDeck(), seededRandom(7)).map(key);
    const c = shuffle(createDeck(), seededRandom(8)).map(key);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(createDeck().map(key));
  });
});

describe('secureRandom', () => {
  it('returns floats in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const value = secureRandom();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
