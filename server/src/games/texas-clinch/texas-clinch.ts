import { GameRuleError, type ServerGameModule } from '@cardplay/shared';

// Texas Clinch has no approved rules yet (rules/rules, section 4), so this module exists only to
// make the game visible and to fail loudly instead of quietly playing some other game.
function notDefined(): never {
  throw new GameRuleError(
    'GAME_RULES_NOT_DEFINED',
    'the rules of Texas Clinch are not defined yet',
  );
}

export const texasClinchModule: ServerGameModule = {
  key: 'texas_clinch',
  createInitialState: notDefined,
  applyAction: notDefined,
  isTerminal: notDefined,
  getResult: notDefined,
  sanitize: notDefined,
};
