import type { GameKey, GameMode, MatchmakingMode, ServerToClientEvents } from '@cardplay/shared';

type StatusPayload = Parameters<ServerToClientEvents['matchmaking:status']>[0];

export type MatchmakingView = {
  queued: { gameType: GameKey; mode: MatchmakingMode } | null;
  message: string | null;
};

export type MatchmakingAction =
  | { type: 'status'; status: StatusPayload }
  | { type: 'found' }
  | { type: 'error'; message: string }
  | { type: 'dismiss' };

export const initialMatchmakingState: MatchmakingView = { queued: null, message: null };

const DROPPED: Record<string, string> = {
  opponent_missing: 'Przeciwnik nie dołączył do pokoju. Szukaj ponownie.',
  match_failed: 'Nie udało się utworzyć meczu (czy jesteś już w pokoju?). Szukaj ponownie.',
};

export function matchmakingReducer(
  state: MatchmakingView,
  action: MatchmakingAction,
): MatchmakingView {
  switch (action.type) {
    case 'status': {
      const { status } = action;
      if (status.queued && status.gameType && status.mode) {
        return { queued: { gameType: status.gameType, mode: status.mode }, message: null };
      }
      return { queued: null, message: (status.reason && DROPPED[status.reason]) ?? null };
    }
    case 'found':
      return { queued: null, message: null };
    case 'error':
      return { ...state, message: action.message };
    case 'dismiss':
      return { ...state, message: null };
  }
}

const MODE_LABELS: Record<GameMode, string> = {
  competitive: 'rankingowy',
  unrated: 'towarzyski',
  bot: 'z botem',
  private: 'prywatny',
};

export const matchModeLabel = (mode: GameMode): string => MODE_LABELS[mode];
