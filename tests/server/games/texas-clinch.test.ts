import { GameRuleError, type GamePlayer } from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import { texasClinchModule } from '../../../server/src/games/texas-clinch/texas-clinch';
import { GAME_REGISTRY } from '../../../server/src/realtime/game-registry';

const players: GamePlayer[] = [
  { id: 'a', username: 'a', isBot: false },
  { id: 'b', username: 'b', isBot: false },
];

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof GameRuleError ? error.code : `unexpected: ${String(error)}`;
  }
  return undefined;
}

describe('texasClinchModule', () => {
  it('has the key of the game', () => {
    expect(texasClinchModule.key).toBe('texas_clinch');
  });

  it('refuses to start a game: the rules have not been defined', () => {
    expect(codeOf(() => texasClinchModule.createInitialState(players, Math.random))).toBe(
      'GAME_RULES_NOT_DEFINED',
    );
  });

  it('refuses every other operation as well, so nothing can pretend to play it', () => {
    const state = { gameKey: 'texas_clinch', players, currentPlayerId: null } as const;
    expect(codeOf(() => texasClinchModule.applyAction(state, { type: 'x' }, 'a'))).toBe(
      'GAME_RULES_NOT_DEFINED',
    );
    expect(codeOf(() => texasClinchModule.isTerminal(state))).toBe('GAME_RULES_NOT_DEFINED');
    expect(codeOf(() => texasClinchModule.getResult(state))).toBe('GAME_RULES_NOT_DEFINED');
    expect(codeOf(() => texasClinchModule.sanitize(state, 'a'))).toBe('GAME_RULES_NOT_DEFINED');
  });
});

describe('game registry', () => {
  it('lists Texas Clinch as a game whose rules are not defined', () => {
    expect(GAME_REGISTRY.texas_clinch?.rulesDefined).toBe(false);
    expect(GAME_REGISTRY.war?.rulesDefined).toBe(true);
    expect(GAME_REGISTRY.macao?.rulesDefined).toBe(true);
  });
});
