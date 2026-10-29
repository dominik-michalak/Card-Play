import {
  GameRuleError,
  type Card,
  type ClientPokerState,
  type GameAction,
  type GamePlayer,
  type Rank,
  type Suit,
} from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import { createPokerStateFrom, type PokerState } from '../../../server/src/games/poker/poker';
import { texasClinchModule } from '../../../server/src/games/texas-clinch/texas-clinch';
import { GAME_REGISTRY } from '../../../server/src/realtime/game-registry';
import { seededRandom } from '../../helpers/seeded-random';

const SUIT: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const card = (text: string): Card => ({
  rank: text.slice(0, -1) as Rank,
  suit: SUIT[text.slice(-1)]!,
});
const players = (count: number): GamePlayer[] =>
  ['a', 'b', 'c', 'd', 'e'].slice(0, count).map((id) => ({ id, username: id, isBot: false }));

const act = (state: PokerState, playerId: string, type: string): PokerState =>
  texasClinchModule.applyAction(state, { type } as GameAction, playerId).newState as PokerState;
const sanitized = (state: PokerState, playerId: string) =>
  texasClinchModule.sanitize(state, playerId) as ClientPokerState;

describe('texasClinchModule', () => {
  it('has the key of the game and deals a Texas Clinch hand', () => {
    const state = texasClinchModule.createInitialState(players(3), seededRandom(1)) as PokerState;
    expect(texasClinchModule.key).toBe('texas_clinch');
    expect(state.gameKey).toBe('texas_clinch');
    expect(sanitized(state, 'a').gameKey).toBe('texas_clinch');
  });

  it.each([2, 3, 4])('seats %i players', (count) => {
    expect(() =>
      texasClinchModule.createInitialState(players(count), seededRandom(1)),
    ).not.toThrow();
  });

  it.each([1, 5])('refuses %i players: the table is for 2 to 4', (count) => {
    expect(() => texasClinchModule.createInitialState(players(count), seededRandom(1))).toThrow(
      /2 to 4/,
    );
  });

  it('starts everybody with 500 chips and posts the 10/20 blinds', () => {
    const state = texasClinchModule.createInitialState(players(3), seededRandom(1)) as PokerState;
    const view = sanitized(state, 'a');
    expect(view.smallBlind).toBe(10);
    expect(view.bigBlind).toBe(20);
    expect(view.pot).toBe(30);
    expect(view.seats.map((s) => s.stack + s.bet)).toEqual([500, 500, 500]);
  });

  it.each([
    [1, 10, 20],
    [5, 10, 20],
    [6, 20, 40],
    [10, 20, 40],
    [11, 40, 80],
  ])('hand %i is played at %i/%i: the blinds double every 5 hands', (hand, small, big) => {
    const state = createPokerStateFrom(players(2), {
      gameKey: 'texas_clinch',
      handNumber: hand,
      holes: [
        [card('2c'), card('3d')],
        [card('4c'), card('5d')],
      ],
    });
    const view = sanitized(state, 'a');
    expect([view.smallBlind, view.bigBlind]).toEqual([small, big]);
  });

  it('keeps the other players cards hidden', () => {
    const state = texasClinchModule.createInitialState(players(3), seededRandom(2)) as PokerState;
    const view = sanitized(state, 'a');
    expect(view.hole).toEqual(state.holes[0]);
    expect(JSON.stringify(view)).not.toContain(JSON.stringify(state.holes[1]));
  });

  it('plays to the end: the last player with chips wins the match, nothing is ranked', () => {
    let state = texasClinchModule.createInitialState(players(2), seededRandom(7)) as PokerState;
    // both players shove every hand, so the match ends within a few hands
    for (let i = 0; i < 400 && !texasClinchModule.isTerminal(state); i++) {
      const actor = state.players[state.actor]!.id;
      state = act(state, actor, sanitized(state, actor).legal?.allIn != null ? 'all_in' : 'call');
    }
    expect(texasClinchModule.isTerminal(state)).toBe(true);
    const result = texasClinchModule.getResult(state);
    expect(result.terminationReason).toBe('completed');
    expect(result.placements.find((p) => p.rank === 1)).toBeDefined();
    const facts = texasClinchModule.facts?.(state);
    for (const own of Object.values(facts ?? {})) {
      expect(own.pokerEliminator).toBeFalsy();
      expect(own.pokerAllInWin).toBeFalsy();
    }
  });

  it('refuses a move from a player who is not on turn', () => {
    const state = texasClinchModule.createInitialState(players(3), seededRandom(1)) as PokerState;
    const other = state.players.find((_, seat) => seat !== state.actor)!.id;
    expect(() => act(state, other, 'fold')).toThrow(GameRuleError);
  });
});

describe('the runner entry of Texas Clinch', () => {
  const entry = GAME_REGISTRY.texas_clinch!;

  it('is registered with its own module and no bot', () => {
    expect(entry.module.key).toBe('texas_clinch');
    const state = entry.module.createInitialState(players(2), seededRandom(1));
    expect(entry.botAction(state, 'a')).toBeNull();
  });

  it('ends a two player match when one of them forfeits', () => {
    const state = entry.module.createInitialState(players(2), seededRandom(1));
    const { newState } = entry.forfeit(state, 'a', 'disconnect_forfeit');
    expect(entry.module.isTerminal(newState)).toBe(true);
    expect(entry.module.getResult(newState).terminationReason).toBe('disconnect_forfeit');
  });

  it('takes the player on turn out of a larger game when the time is up', () => {
    const state = entry.module.createInitialState(players(3), seededRandom(1));
    const { newState } = entry.resolveTimeout(state);
    expect(entry.module.isTerminal(newState)).toBe(false);
    expect(entry.activePlayerIds(newState)).toHaveLength(2);
  });
});
