export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANKS)[number];

export type Card = { suit: Suit; rank: Rank };

export type Deck = Card[];

// what a client sees instead of a card it must not know (rival hand, deck)
export type HiddenCard = { faceDown: true };

export type ClientCard = Card | HiddenCard;

export function isHiddenCard(card: ClientCard): card is HiddenCard {
  return 'faceDown' in card;
}
