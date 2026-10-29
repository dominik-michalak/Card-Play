import type { Card, Rank, Suit } from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import { createDeck, shuffle } from '../../../server/src/games/deck';
import { handName, handWinners } from '../../../server/src/games/poker/hand-eval';
import { CATEGORY_NAMES, bestScore, referenceWinners } from '../../helpers/poker-reference';
import { seededRandom } from '../../helpers/seeded-random';

const SUIT: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const card = (text: string): Card => ({
  rank: text.slice(0, -1) as Rank,
  suit: SUIT[text.slice(-1)]!,
});
const cards = (text: string): Card[] => text.trim().split(/\s+/).map(card);
const entry = (id: string, text: string) => ({ id, cards: cards(text) });

describe('handWinners', () => {
  it('picks the better hand', () => {
    expect(
      handWinners([entry('a', 'Ah Ad 2c 7s 9d Kc 4h'), entry('b', 'Kh Kd 2c 7s 9d Kc 4h')]),
    ).toEqual(['b']);
  });

  it('settles ties by kickers and reports a real tie', () => {
    const board = '2c 7s 9d Kc 4h';
    expect(handWinners([entry('a', `Ah Qd ${board}`), entry('b', `As Jd ${board}`)])).toEqual([
      'a',
    ]);
    // the board plays for both
    expect(
      handWinners([entry('a', '2h 3d As Ks Qs Js Ts'), entry('b', '4h 5d As Ks Qs Js Ts')]),
    ).toEqual(['a', 'b']);
  });

  it('knows the wheel is the lowest straight', () => {
    expect(
      handWinners([entry('wheel', 'Ad 2s 3d 4s 5c 9h Kc'), entry('six', '2d 3s 4d 5s 6c 9h Kc')]),
    ).toEqual(['six']);
  });

  it('ranks a flush above a straight and a straight flush above four of a kind', () => {
    expect(
      handWinners([
        entry('flush', '2h 9h Kh 4h 6h 3c 3d'),
        entry('straight', '5c 6d 7h 8s 9c 2d 2s'),
      ]),
    ).toEqual(['flush']);
    expect(
      handWinners([entry('sf', '5h 6h 7h 8h 9h Kc Kd'), entry('quads', 'Ac Ad Ah As 2c 3d 4h')]),
    ).toEqual(['sf']);
  });

  it('prefers the higher full house when two players both have one', () => {
    expect(
      handWinners([entry('a', 'Kc Kd Kh 2c 2d 9s 4h'), entry('b', 'Qc Qd Qh Ac Ad 9s 4h')]),
    ).toEqual(['a']);
  });

  it('names the hand', () => {
    expect(handName(cards('Ad 2s 3d 4s 5c 9h Kc'))).toBe('Straight');
    expect(handName(cards('Ah Ad 2c 7s 9d Kc 4h'))).toBe('Pair');
  });

  it('agrees with an independent evaluator on thousands of random deals', () => {
    const random = seededRandom(20261029);
    for (let round = 0; round < 4000; round++) {
      const deck = shuffle(createDeck(), random);
      const players = 2 + (round % 5);
      const board = deck.slice(0, 5);
      const entries = Array.from({ length: players }, (_, i) => ({
        id: `p${i}`,
        cards: [...deck.slice(5 + i * 2, 7 + i * 2), ...board],
      }));
      expect(handWinners(entries).sort()).toEqual(referenceWinners(entries).sort());
    }
  });

  it('names the same category as the independent evaluator', () => {
    const random = seededRandom(7);
    for (let round = 0; round < 1500; round++) {
      const seven = shuffle(createDeck(), random).slice(0, 7);
      expect(handName(seven)).toBe(CATEGORY_NAMES[bestScore(seven)[0]!]);
    }
  });
});
