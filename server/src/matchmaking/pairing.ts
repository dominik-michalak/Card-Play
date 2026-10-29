import type { GameKey } from '@cardplay/shared';

export const BASE_ELO_WINDOW = 200;
export const WIDEN_STEP = 50;
export const WIDEN_EVERY_MS = 30_000;

export type MatchRules = { base: number; step: number; everyMs: number };
export const DEFAULT_RULES: MatchRules = {
  base: BASE_ELO_WINDOW,
  step: WIDEN_STEP,
  everyMs: WIDEN_EVERY_MS,
};

export type QueueMode = 'competitive' | 'unrated';

export type QueueEntry = {
  userId: string;
  gameType: GameKey;
  mode: QueueMode;
  // rating in that game when the player joined
  elo: number;
  // milliseconds since the epoch
  joinedAt: number;
};

// how far apart ratings may be after waiting this long
export function eloWindow(waitedMs: number, rules: MatchRules = DEFAULT_RULES): number {
  return rules.base + rules.step * Math.floor(Math.max(0, waitedMs) / rules.everyMs);
}

// Pure pairing: each queue (game and mode) is handled on its own. The player who has waited
// longest picks first and gets the closest rating inside the wider of the two windows.
export function findPairs(
  entries: QueueEntry[],
  now: number,
  rules: MatchRules = DEFAULT_RULES,
): [QueueEntry, QueueEntry][] {
  const pairs: [QueueEntry, QueueEntry][] = [];
  const taken = new Set<string>();
  const byAge = [...entries].sort((a, b) => a.joinedAt - b.joinedAt);

  for (const first of byAge) {
    if (taken.has(first.userId)) continue;
    let best: QueueEntry | undefined;
    for (const other of byAge) {
      if (other === first || taken.has(other.userId)) continue;
      if (other.gameType !== first.gameType || other.mode !== first.mode) continue;
      const window = Math.max(
        eloWindow(now - first.joinedAt, rules),
        eloWindow(now - other.joinedAt, rules),
      );
      const gap = Math.abs(first.elo - other.elo);
      if (gap <= window && (!best || gap < Math.abs(first.elo - best.elo))) best = other;
    }
    if (best) {
      taken.add(first.userId);
      taken.add(best.userId);
      pairs.push([first, best]);
    }
  }
  return pairs;
}
