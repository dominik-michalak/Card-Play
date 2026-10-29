import { describe, expect, it } from 'vitest';
import {
  BASE_ELO_WINDOW,
  WIDEN_EVERY_MS,
  WIDEN_STEP,
  eloWindow,
  findPairs,
  type QueueEntry,
} from '../../../server/src/matchmaking/pairing';

const entry = (
  userId: string,
  elo: number,
  joinedAt = 0,
  extra: Partial<QueueEntry> = {},
): QueueEntry => ({
  userId,
  gameType: 'war',
  mode: 'competitive',
  elo,
  joinedAt,
  ...extra,
});
const ids = (pairs: [QueueEntry, QueueEntry][]) =>
  pairs.map(([a, b]) => [a.userId, b.userId].sort().join('+'));

describe('eloWindow', () => {
  it('starts at 200 and widens by 50 every 30 seconds', () => {
    expect(BASE_ELO_WINDOW).toBe(200);
    expect(WIDEN_STEP).toBe(50);
    expect(WIDEN_EVERY_MS).toBe(30_000);
    expect(eloWindow(0)).toBe(200);
    expect(eloWindow(29_999)).toBe(200);
    expect(eloWindow(30_000)).toBe(250);
    expect(eloWindow(95_000)).toBe(350);
  });
});

describe('findPairs', () => {
  it('pairs players whose ratings differ by at most 200', () => {
    expect(ids(findPairs([entry('a', 1000), entry('b', 1200)], 0))).toEqual(['a+b']);
    expect(findPairs([entry('a', 1000), entry('b', 1201)], 0)).toEqual([]);
  });

  it('widens the window with the waiting time', () => {
    const queue = [entry('a', 1000, 0), entry('b', 1300, 0)];
    expect(findPairs(queue, 59_999)).toEqual([]);
    expect(ids(findPairs(queue, 60_000))).toEqual(['a+b']);
  });

  it('lets the longer wait decide when one player is new and the other has waited', () => {
    const queue = [entry('old', 1000, 0), entry('new', 1250, 100_000)];
    // old has waited 100 s (window 400); new just arrived (window 200)
    expect(ids(findPairs(queue, 100_000))).toEqual(['new+old']);
  });

  it('keeps queues apart by game and by mode', () => {
    expect(findPairs([entry('a', 1000), entry('b', 1000, 0, { gameType: 'macao' })], 0)).toEqual(
      [],
    );
    expect(findPairs([entry('a', 1000), entry('b', 1000, 0, { mode: 'unrated' })], 0)).toEqual([]);
    expect(
      ids(
        findPairs(
          [entry('a', 1000, 0, { mode: 'unrated' }), entry('b', 1000, 0, { mode: 'unrated' })],
          0,
        ),
      ),
    ).toEqual(['a+b']);
  });

  it('gives the longest waiting player the closest opponent', () => {
    const queue = [entry('first', 1000, 0), entry('far', 1100, 1), entry('near', 1050, 2)];
    expect(ids(findPairs(queue, 10))).toEqual(['first+near']);
  });

  it('uses each player once', () => {
    const queue = [
      entry('a', 1000, 0),
      entry('b', 1010, 1),
      entry('c', 1020, 2),
      entry('d', 1030, 3),
    ];
    const pairs = findPairs(queue, 10);
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.flat().map((e) => e.userId)).size).toBe(4);
  });

  it('leaves a lone player and an odd one out waiting', () => {
    expect(findPairs([entry('a', 1000)], 0)).toEqual([]);
    expect(findPairs([entry('a', 1000), entry('b', 1000), entry('c', 1000)], 0)).toHaveLength(1);
  });

  it('accepts custom rules, so tests do not have to wait half a minute', () => {
    const rules = { base: 0, step: 100, everyMs: 10 };
    const queue = [entry('a', 1000, 0), entry('b', 1250, 0)];
    expect(findPairs(queue, 20, rules)).toEqual([]);
    expect(ids(findPairs(queue, 30, rules))).toEqual(['a+b']);
  });
});
