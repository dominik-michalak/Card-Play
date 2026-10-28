import type { Card } from './cards';
import type { ClientGameState, GameResult } from './game';

export const WAR_MAX_ROUNDS = 1000;
export const WAR_FACE_DOWN_CARDS = 3;

// one round as the table showed it; face-down cards of a war are never revealed
export type WarRoundSummary = {
  round: number;
  // face-up pairs in seat order; more than one pair means a war happened
  comparisons: [Card, Card][];
  // null when the game ended in the middle of a war because of missing cards
  winnerId: string | null;
  poolSize: number;
};

export type ClientWarState = ClientGameState & {
  gameKey: 'war';
  // draw pile sizes by player id: the order and content of piles stay on the server
  stackSizes: Record<string, number>;
  // completed rounds
  round: number;
  // players who already confirmed the current round
  flippedPlayerIds: string[];
  lastRound: WarRoundSummary | null;
  result: GameResult | null;
};
