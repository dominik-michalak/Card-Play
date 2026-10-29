import { describe, expect, it } from 'vitest';
import {
  initialMatchmakingState,
  matchmakingReducer,
  matchModeLabel,
} from '../../client/src/matchmaking-state';

describe('matchmakingReducer', () => {
  it('shows the queue the player joined', () => {
    const state = matchmakingReducer(initialMatchmakingState, {
      type: 'status',
      status: { queued: true, gameType: 'macao', mode: 'competitive' },
    });
    expect(state).toEqual({ queued: { gameType: 'macao', mode: 'competitive' }, message: null });
  });

  it('forgets the queue when the player leaves it, without a message', () => {
    const queued = matchmakingReducer(initialMatchmakingState, {
      type: 'status',
      status: { queued: true, gameType: 'war', mode: 'unrated' },
    });
    expect(
      matchmakingReducer(queued, { type: 'status', status: { queued: false, reason: 'left' } }),
    ).toEqual({ queued: null, message: null });
  });

  it.each([
    ['opponent_missing', 'Przeciwnik nie dołączył'],
    ['match_failed', 'Nie udało się'],
  ] as const)('explains a dropped match (%s)', (reason, text) => {
    const state = matchmakingReducer(initialMatchmakingState, {
      type: 'status',
      status: { queued: false, reason },
    });
    expect(state.queued).toBeNull();
    expect(state.message).toContain(text);
  });

  it('leaves the queue once a match is found', () => {
    const queued = matchmakingReducer(initialMatchmakingState, {
      type: 'status',
      status: { queued: true, gameType: 'war', mode: 'competitive' },
    });
    expect(matchmakingReducer(queued, { type: 'found' }).queued).toBeNull();
  });

  it('shows a server error until it is dismissed', () => {
    let state = matchmakingReducer(initialMatchmakingState, { type: 'error', message: 'busy' });
    expect(state.message).toBe('busy');
    state = matchmakingReducer(state, { type: 'dismiss' });
    expect(state.message).toBeNull();
  });
});

describe('matchModeLabel', () => {
  it('names every mode a room can have', () => {
    expect(matchModeLabel('competitive')).toBe('rankingowy');
    expect(matchModeLabel('unrated')).toBe('towarzyski');
    expect(matchModeLabel('bot')).toBe('z botem');
    expect(matchModeLabel('private')).toBe('prywatny');
  });
});
