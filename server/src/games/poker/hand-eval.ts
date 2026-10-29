import type { Card } from '@cardplay/shared';
import pokersolver from 'pokersolver';

const { Hand } = pokersolver;

// The only place that knows the evaluation library. Cards are written the way it expects
// ("Td" is the ten of diamonds); suits and ranks do not decide a tie.
const toCode = (card: Card): string => `${card.rank === '10' ? 'T' : card.rank}${card.suit[0]}`;

type Entry = { id: string; cards: Card[] };

// ids of the players with the best five-card hand out of their cards; several on a tie
export function handWinners(entries: Entry[]): string[] {
  const solved = entries.map((entry) => ({
    id: entry.id,
    hand: Hand.solve(entry.cards.map(toCode)),
  }));
  const winners = new Set(Hand.winners(solved.map((s) => s.hand)));
  return solved.filter((s) => winners.has(s.hand)).map((s) => s.id);
}

// "Pair", "Flush", ... for the best hand in the cards
export function handName(cards: Card[]): string {
  return Hand.solve(cards.map(toCode)).name;
}
