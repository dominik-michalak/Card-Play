export const ACHIEVEMENT_IDS = [
  'first_win',
  'war_chain_3',
  'macao_clean_finish',
  'macao_comeback',
  'poker_all_in_win',
  'poker_eliminator',
  'fair_play_10',
  'streak_5',
] as const;
export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];

// What a game reports about one player when it ends. The room turns these facts, plus the
// stored history, into achievements; the games themselves know nothing about achievements.
export type PlayerFacts = {
  // lost the game by a timeout or a disconnect
  forfeited?: boolean;
  // won a War pool after at least three face-up comparisons inside the war
  warChain3?: boolean;
  // won Macao without ever being penalised for a missing declaration
  macaoCleanFinish?: boolean;
  // won Macao after holding at least 15 cards
  macaoComeback?: boolean;
  // went all-in in a hand and collected a pot of that hand
  pokerAllInWin?: boolean;
  // won a Poker match by collecting every chip
  pokerEliminator?: boolean;
};

// by player id
export type GameFacts = Record<string, PlayerFacts>;

export type UnlockedAchievement = { id: AchievementId; unlockedAt: string };
