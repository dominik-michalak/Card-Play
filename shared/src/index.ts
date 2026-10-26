export const GAME_KEYS = ['war', 'macao', 'texas_clinch', 'poker'] as const;
export type GameKey = (typeof GAME_KEYS)[number];
