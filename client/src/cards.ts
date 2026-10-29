import type { Card, Suit } from '@cardplay/shared';

const SUIT_SYMBOLS: Record<Suit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
};

const RANK_WORDS: Record<string, string> = { A: 'as', K: 'król', Q: 'dama', J: 'walet' };
const SUIT_WORDS: Record<Suit, string> = {
  clubs: 'trefl',
  diamonds: 'karo',
  hearts: 'kier',
  spades: 'pik',
};

// what a screen reader should say: the symbols alone are read badly or not at all
export function cardSpoken(card: Card): string {
  return `${RANK_WORDS[card.rank] ?? card.rank} ${SUIT_WORDS[card.suit]}`;
}

export function cardLabel(card: Card): string {
  return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}
