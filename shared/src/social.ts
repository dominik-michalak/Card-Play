import type { GameKey } from './game';
import type { GameMode } from './rooms';
import type { TerminationReason } from './game';

// what the profile, ranking and friends endpoints return (dates are ISO strings in JSON)

export type GameStats = {
  played: number;
  wins: number;
  losses: number;
  draws: number;
  // percent of played games that were won, one decimal
  winRate: number;
};

export type ProfileGame = GameStats & { gameType: GameKey; elo: number | null };

export type ProfileView = {
  id: string;
  username: string;
  createdAt: string;
  games: ProfileGame[];
  totals: GameStats;
};

export type HistoryEntry = {
  recordId: string;
  gameType: GameKey;
  mode: GameMode;
  startedAt: string;
  finishedAt: string;
  terminationReason: TerminationReason;
  result: 'win' | 'loss' | 'draw' | 'cancelled';
  finalRank: number | null;
  eloChange: number | null;
  opponents: { userId: string | null; username: string }[];
};

export type LeaderboardEntry = {
  rank: number;
  userId: string;
  username: string;
  elo: number;
  gamesPlayed: number;
};

export type Paged<T> = { total: number; items: T[] };

export type FriendEntry = { userId: string; username: string; online: boolean };
export type PendingFriendEntry = { userId: string; username: string; since: string };
export type FriendListView = {
  friends: FriendEntry[];
  incoming: PendingFriendEntry[];
  outgoing: PendingFriendEntry[];
};
