import type { Card, Rank, Suit } from './cards';
import type { ClientGameState, GameResult } from './game';

export const MACAO_HAND_SIZE = 5;
// cards a player draws for a missed Macao declaration
export const MACAO_REPORT_PENALTY = 5;
// completed, skipped and automatic turns together; the game ends when the limit is reached
export const MACAO_MAX_TURNS = 1000;
// ranks a Jack may request
export const MACAO_REQUESTABLE_RANKS = [
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
] as const satisfies readonly Rank[];

export type MacaoRequest = { rank: Rank } | { suit: Suit };
export type MacaoPenalty = { kind: 'draw' | 'skip'; amount: number };

// payload of the `play` action; `request` is required for a Jack (rank) and an Ace (suit)
export type MacaoPlayPayload = {
  card: Card;
  request?: MacaoRequest;
  declaredMacao?: boolean;
};

// what one player sees; rival hands, the draw pile and the RNG state stay on the server
export type ClientMacaoState = ClientGameState & {
  gameKey: 'macao';
  hand: Card[];
  handSizes: Record<string, number>;
  topCard: Card;
  discardCount: number;
  drawPileCount: number;
  penalty: MacaoPenalty | null;
  request: MacaoRequest | null;
  // cards of `hand` that may be played now (empty unless it is this player's turn)
  playable: Card[];
  canDraw: boolean;
  canPass: boolean;
  // the card this player just drew, which is the only one they may play this turn
  drawnCard: Card | null;
  // who can be reported for a missing Macao declaration right now
  reportablePlayerId: string | null;
  eliminatedIds: string[];
  turn: number;
  result: GameResult | null;
};
