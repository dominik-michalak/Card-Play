import {
  GAME_KEYS,
  GAME_PLAYER_LIMITS,
  ERROR_CODES,
  GameRuleError,
  TERMINATION_REASONS,
  RANKS,
  SUITS,
  isHiddenCard,
  type ClientCard,
  type ClientToServerEvents,
  type GameState,
  type ServerGameModule,
  type ServerToClientEvents,
} from '@cardplay/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('game constants', () => {
  it('has a player limit for every game key', () => {
    expect(Object.keys(GAME_PLAYER_LIMITS).sort()).toEqual([...GAME_KEYS].sort());
  });

  it('has sane player limits', () => {
    for (const { min, max } of Object.values(GAME_PLAYER_LIMITS)) {
      expect(min).toBeGreaterThanOrEqual(2);
      expect(max).toBeGreaterThanOrEqual(min);
    }
  });

  it('describes a standard 52 card deck', () => {
    expect(SUITS).toHaveLength(4);
    expect(RANKS).toHaveLength(13);
  });
});

describe('isHiddenCard', () => {
  it('tells hidden cards from real ones', () => {
    const hidden: ClientCard = { faceDown: true };
    const real: ClientCard = { suit: 'hearts', rank: 'A' };
    expect(isHiddenCard(hidden)).toBe(true);
    expect(isHiddenCard(real)).toBe(false);
  });
});

describe('error codes', () => {
  it('are UPPER_SNAKE_CASE and include the undefined rules code', () => {
    expect(ERROR_CODES).toContain('GAME_RULES_NOT_DEFINED');
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  it('lists the termination reasons from the rules', () => {
    expect([...TERMINATION_REASONS].sort()).toEqual(
      [
        'all_cards',
        'round_limit',
        'turn_limit',
        'timeout_forfeit',
        'disconnect_forfeit',
        'double_timeout',
        'draw',
        'cancelled',
        'completed',
      ].sort(),
    );
  });
});

describe('GameRuleError', () => {
  it('carries a code and is an Error', () => {
    const error = new GameRuleError('NOT_YOUR_TURN', 'wait');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('NOT_YOUR_TURN');
    expect(error.name).toBe('GameRuleError');
  });
});

describe('contracts', () => {
  it('lets a module be built for a concrete state type', () => {
    type CountState = GameState & { count: number };
    const module: ServerGameModule<CountState> = {
      key: 'war',
      createInitialState: (players) => ({
        gameKey: 'war',
        players,
        currentPlayerId: players[0]?.id ?? null,
        count: 0,
      }),
      applyAction: (state) => ({ newState: { ...state, count: state.count + 1 }, events: [] }),
      isTerminal: (state) => state.count > 0,
      getResult: (state) => ({
        placements: state.players.map((p) => ({ playerId: p.id, rank: 1 })),
        terminationReason: 'draw',
      }),
      sanitize: ({ gameKey, players, currentPlayerId }) => ({
        gameKey,
        players,
        currentPlayerId,
        turnDeadlineAt: null,
      }),
    };
    const state = module.createInitialState(
      [{ id: 'a', username: 'a', isBot: false }],
      Math.random,
    );
    expect(module.isTerminal(state)).toBe(false);
    expect(module.isTerminal(module.applyAction(state, { type: 'x' }, 'a').newState)).toBe(true);
  });

  it('keeps the socket event names from the plan', () => {
    expectTypeOf<keyof ClientToServerEvents>().toEqualTypeOf<
      | 'room:join'
      | 'room:leave'
      | 'room:seat'
      | 'room:ready'
      | 'room:chat'
      | 'game:action'
      | 'matchmaking:join'
      | 'matchmaking:leave'
      | 'friend:invite'
    >();
    expectTypeOf<keyof ServerToClientEvents>().toEqualTypeOf<
      | 'room:players'
      | 'room:countdown'
      | 'room:chat'
      | 'game:state_update'
      | 'game:event'
      | 'game:finished'
      | 'matchmaking:found'
      | 'matchmaking:status'
      | 'friend:invited'
      | 'achievement:unlocked'
      | 'error'
    >();
  });
});
