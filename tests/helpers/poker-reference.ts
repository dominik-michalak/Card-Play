import { RANKS, type Card } from '@cardplay/shared';

// An independent, deliberately plain evaluator used to check the library: the best of all
// five-card subsets, scored as [category, ...tie-breakers] and compared lexicographically.

const value = (card: Card): number => RANKS.indexOf(card.rank) + 2; // 2..14

function scoreFive(cards: Card[]): number[] {
  const values = cards.map(value).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0]!.suit);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // groups by size then by value: [[value, count], ...]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...new Set(values)];
  let straightHigh = 0;
  if (unique.length === 5 && unique[0]! - unique[4]! === 4) straightHigh = unique[0]!;
  if (unique.join() === '14,5,4,3,2') straightHigh = 5; // the wheel
  const kickers = groups.map(([v]) => v);

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0]![1] === 4) return [7, ...kickers];
  if (groups[0]![1] === 3 && groups[1]![1] === 2) return [6, ...kickers];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0]![1] === 3) return [3, ...kickers];
  if (groups[0]![1] === 2 && groups[1]![1] === 2) return [2, ...kickers];
  if (groups[0]![1] === 2) return [1, ...kickers];
  return [0, ...values];
}

const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

export function bestScore(seven: Card[]): number[] {
  let best: number[] | null = null;
  for (let skipA = 0; skipA < seven.length; skipA++) {
    for (let skipB = skipA + 1; skipB < seven.length; skipB++) {
      const five = seven.filter((_, i) => i !== skipA && i !== skipB);
      const score = scoreFive(five);
      if (!best || compare(score, best) > 0) best = score;
    }
  }
  return best!;
}

// ids of the players holding the best hand (several on a tie)
export function referenceWinners(entries: { id: string; cards: Card[] }[]): string[] {
  const scored = entries.map((e) => ({ id: e.id, score: bestScore(e.cards) }));
  const top = scored.reduce((best, e) => (compare(e.score, best.score) > 0 ? e : best));
  return scored.filter((e) => compare(e.score, top.score) === 0).map((e) => e.id);
}

export const CATEGORY_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];
