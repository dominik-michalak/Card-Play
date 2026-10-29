import type { Card } from './cards';
import type { ClientGameState, GameResult } from './game';

export const POKER_START_STACK = 1000;
export const POKER_BASE_SMALL_BLIND = 10;
// the blinds double after this many hands
export const POKER_HANDS_PER_LEVEL = 10;

export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river';

export type PokerActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';

// `amount` of bet and raise is the player's total stake in the current round ("raise to")
export type PokerActionPayload = { amount?: number };

export type PokerSeatView = {
  playerId: string;
  stack: number;
  // chips put in during the current betting round
  bet: number;
  folded: boolean;
  allIn: boolean;
  // left the table (busted or forfeited)
  out: boolean;
  isButton: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
};

export type PokerPot = { amount: number; eligibleIds: string[] };

// what the player on turn may do, with the limits for bet and raise
export type PokerLegal = {
  canFold: boolean;
  canCheck: boolean;
  // chips needed to call (or all the player has, if that is less); null when there is nothing to call
  call: number | null;
  bet: { min: number; max: number } | null;
  raise: { min: number; max: number } | null;
  // the whole stack as a total stake, null when the player has no chips
  allIn: number | null;
};

export type PokerHandSummary = {
  handNumber: number;
  board: Card[];
  // hands shown at a showdown; empty when everybody else folded
  reveals: { playerId: string; cards: Card[]; handName: string }[];
  payouts: { playerId: string; amount: number }[];
};

export type ClientPokerState = ClientGameState & {
  gameKey: 'poker';
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
  street: PokerStreet;
  board: Card[];
  // the player's own two cards (empty when they are not in the hand)
  hole: Card[];
  seats: PokerSeatView[];
  pots: PokerPot[];
  // all chips in the middle, including bets of the current round
  pot: number;
  legal: PokerLegal | null;
  lastHand: PokerHandSummary | null;
  result: GameResult | null;
};
