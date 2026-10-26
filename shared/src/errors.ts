export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_PAYLOAD',
  'RATE_LIMITED',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'NOT_YOUR_TURN',
  'INVALID_ACTION',
  'GAME_OVER',
  'GAME_RULES_NOT_DEFINED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorPayload = { code: ErrorCode; message: string };

// thrown by game modules; the socket layer turns it into an error event
export class GameRuleError extends Error {
  constructor(
    readonly code: Extract<
      ErrorCode,
      'NOT_YOUR_TURN' | 'INVALID_ACTION' | 'GAME_OVER' | 'GAME_RULES_NOT_DEFINED'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'GameRuleError';
  }
}
