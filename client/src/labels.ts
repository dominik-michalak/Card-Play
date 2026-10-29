import type { GameKey, HistoryEntry } from '@cardplay/shared';

export const GAME_LABELS: Record<GameKey, string> = {
  war: 'Wojna',
  macao: 'Makao',
  texas_clinch: 'Texas Clinch',
  poker: 'Poker',
};

export const RESULT_LABELS: Record<HistoryEntry['result'], string> = {
  win: 'wygrana',
  loss: 'porażka',
  draw: 'remis',
  cancelled: 'anulowana',
};

export const formatDate = (iso: string): string => new Date(iso).toLocaleString('pl-PL');

export const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));
