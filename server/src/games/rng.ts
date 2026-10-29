import type { Deck } from '@cardplay/shared';
import { shuffle } from './deck';

// mulberry32 with its state in plain sight: a game state can carry it, which keeps the game
// functions pure (the same state and action always give the same result)
export function nextRandom(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 2 ** 32, state: next };
}

export function shuffleWithState(deck: Deck, state: number): { deck: Deck; state: number } {
  let current = state;
  const shuffled = shuffle(deck, () => {
    const step = nextRandom(current);
    current = step.state;
    return step.value;
  });
  return { deck: shuffled, state: current };
}
