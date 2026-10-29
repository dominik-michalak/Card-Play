import {
  MACAO_REQUESTABLE_RANKS,
  SUITS,
  type Card,
  type GameAction,
  type GamePlayer,
  type MacaoPlayPayload,
  type Rank,
  type Suit,
} from '@cardplay/shared';
import { macaoModule, type MacaoState } from '../games/macao/macao';
import type { WarState } from '../games/war/war';

// the bot has no account; this id cannot clash with a user id (those are UUIDs)
export const BOT_ID = 'bot';

export function botPlayer(): GamePlayer {
  return { id: BOT_ID, username: 'Bot', isBot: true };
}

// The bot decides from what a player would see, never from the hidden state, and has no
// difficulty levels: it plays the first sensible card.

// War: the only decision is to confirm the round
export function chooseWarAction(state: WarState, botId: string): GameAction | null {
  const seat = state.players.findIndex((p) => p.id === botId);
  if (seat < 0 || state.result || state.flipped[seat]) return null;
  return { type: 'flip' };
}

function mostHeld<T extends string>(options: readonly T[], held: T[], fallback: T): T {
  let best = fallback;
  let bestCount = 0;
  for (const option of options) {
    const count = held.filter((value) => value === option).length;
    if (count > bestCount) {
      best = option;
      bestCount = count;
    }
  }
  return best;
}

export function chooseMacaoAction(state: MacaoState, botId: string): GameAction | null {
  const view = macaoModule.sanitize(state, botId);
  if (state.result || view.currentPlayerId !== botId) return null;

  const isWild = (card: Card) => card.rank === 'J' || card.rank === 'A';
  const choice = view.playable.find((card) => !isWild(card)) ?? view.playable[0];
  if (choice) {
    const rest = view.hand.filter((c) => !(c.rank === choice.rank && c.suit === choice.suit));
    const payload: MacaoPlayPayload = { card: choice, declaredMacao: view.hand.length === 2 };
    if (choice.rank === 'J') {
      // ask for what the bot holds, so it can follow up
      payload.request = {
        rank: mostHeld<Rank>(
          MACAO_REQUESTABLE_RANKS,
          rest.map((c) => c.rank),
          '7',
        ),
      };
    }
    if (choice.rank === 'A') {
      payload.request = {
        suit: mostHeld<Suit>(
          SUITS,
          rest.map((c) => c.suit),
          'clubs',
        ),
      };
    }
    return { type: 'play', payload };
  }
  if (view.canPass) return { type: 'pass' };
  if (view.canDraw) return { type: 'draw' };
  return null;
}
