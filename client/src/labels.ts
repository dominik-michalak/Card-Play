import type { AchievementId, GameKey, HistoryEntry } from '@cardplay/shared';

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

export const ACHIEVEMENT_LABELS: Record<AchievementId, { name: string; description: string }> = {
  first_win: { name: 'Pierwsze zwycięstwo', description: 'Wygrana gra przeciwko człowiekowi.' },
  war_chain_3: {
    name: 'Łańcuch wojny',
    description: 'Pula wygrana po trzech odkrytych porównaniach wewnątrz wojny.',
  },
  macao_clean_finish: {
    name: 'Czyste Makao',
    description: 'Wygrane Makao bez kary za brak deklaracji.',
  },
  macao_comeback: { name: 'Powrót w Makao', description: 'Wygrane Makao po 15 kartach na ręce.' },
  poker_all_in_win: { name: 'Wszystko na jedną kartę', description: 'Pula wygrana po all-in.' },
  poker_eliminator: {
    name: 'Pogromca stołu',
    description: 'Mecz pokera wygrany przez zebranie wszystkich żetonów.',
  },
  fair_play_10: {
    name: 'Fair play',
    description: 'Dziesięć gier przeciwko ludziom bez walkowera.',
  },
  streak_5: { name: 'Seria', description: 'Pięć rankingowych zwycięstw z rzędu w jednej grze.' },
};
