import { RANKS, SUITS, type Card, type Deck, type RandomSource } from '@cardplay/shared';

export function createDeck(): Deck {
  return SUITS.flatMap((suit) => RANKS.map((rank): Card => ({ suit, rank })));
}

// Fisher-Yates on a copy; the caller decides where the randomness comes from
export function shuffle(deck: Deck, random: RandomSource): Deck {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
