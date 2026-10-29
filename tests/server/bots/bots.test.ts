import type { Card, GamePlayer, Rank, Suit } from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import {
  BOT_ID,
  botPlayer,
  chooseMacaoAction,
  chooseWarAction,
} from '../../../server/src/bots/bots';
import {
  createMacaoStateFrom,
  macaoModule,
  type MacaoState,
} from '../../../server/src/games/macao/macao';
import { createWarState, warModule, type WarState } from '../../../server/src/games/war/war';
import { createDeck } from '../../../server/src/games/deck';
import { seededRandom } from '../../helpers/seeded-random';

const SUIT: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const card = (text: string): Card => ({
  rank: text.slice(0, -1) as Rank,
  suit: SUIT[text.slice(-1)]!,
});
const cards = (text: string): Card[] => text.trim().split(/\s+/).filter(Boolean).map(card);

const human: GamePlayer = { id: 'human', username: 'human', isBot: false };
const players: GamePlayer[] = [human, botPlayer()];

describe('botPlayer', () => {
  it('is a bot without an account', () => {
    expect(botPlayer()).toEqual({ id: BOT_ID, username: 'Bot', isBot: true });
  });
});

describe('chooseWarAction', () => {
  const start = (): WarState => createWarState(players, createDeck());

  it('flips once per round', () => {
    const state = start();
    expect(chooseWarAction(state, BOT_ID)).toEqual({ type: 'flip' });

    const afterBot = warModule.applyAction(state, { type: 'flip' }, BOT_ID).newState;
    expect(chooseWarAction(afterBot, BOT_ID)).toBeNull();
  });

  it('flips again when the next round starts', () => {
    const state = start();
    const half = warModule.applyAction(state, { type: 'flip' }, BOT_ID).newState;
    const resolved = warModule.applyAction(half, { type: 'flip' }, 'human').newState;
    expect(chooseWarAction(resolved, BOT_ID)).toEqual({ type: 'flip' });
  });

  it('does nothing in a finished game or for someone who is not playing', () => {
    const over = { ...start(), result: { terminationReason: 'draw', placements: [] } } as WarState;
    expect(chooseWarAction(over, BOT_ID)).toBeNull();
    expect(chooseWarAction(start(), 'stranger')).toBeNull();
  });

  it('plays whole games against itself with every action accepted', () => {
    let state = createWarState(
      [botPlayer(), { id: 'bot2', username: 'Bot 2', isBot: true }],
      createDeck(),
    );
    for (let step = 0; step < 6000 && !warModule.isTerminal(state); step++) {
      for (const id of [BOT_ID, 'bot2']) {
        const action = chooseWarAction(state, id);
        if (action) state = warModule.applyAction(state, action, id).newState;
      }
    }
    expect(warModule.isTerminal(state)).toBe(true);
  });
});

describe('chooseMacaoAction', () => {
  const duo: GamePlayer[] = [botPlayer(), human];
  const make = (hands: [string, string], extra: Partial<MacaoState> = {}) =>
    createMacaoStateFrom(duo, {
      hands: hands.map(cards),
      drawPile: cards('9c 8c 6c 5c 10c 9d 8d 6d 5d 10d'),
      discard: cards('7h'),
      ...extra,
    });

  it('does nothing when it is not the bot turn or the game is over', () => {
    expect(chooseMacaoAction(make(['9h 5c', '7s 8d'], { current: 1 }), BOT_ID)).toBeNull();
    const over = make(['9h', '7s 8d']);
    const finished = macaoModule.applyAction(
      over,
      { type: 'play', payload: { card: card('9h') } },
      BOT_ID,
    ).newState as MacaoState;
    expect(chooseMacaoAction(finished, BOT_ID)).toBeNull();
  });

  it('plays a legal card, preferring ordinary cards to a Jack or an Ace', () => {
    const state = make(['Jh 9h 5c', '7s 8d']);
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({
      type: 'play',
      payload: { card: card('9h') },
    });
  });

  it('asks for the rank it holds most when it plays a Jack', () => {
    const state = make(['Jh 8c 8d 6c 5c', '7s 9d']);
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({
      type: 'play',
      payload: { card: card('Jh'), request: { rank: '8' } },
    });
  });

  it('falls back to a 7 when it holds no rank from 5 to 10', () => {
    const state = make(['Jh Kd 2c', '7s 9d']);
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({
      payload: { card: card('Jh'), request: { rank: '7' } },
    });
  });

  it('asks for the suit it holds most when it plays an Ace', () => {
    const state = make(['Ah 8c 6c 5c 9d', '7s 9d']);
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({
      payload: { card: card('Ah'), request: { suit: 'clubs' } },
    });
  });

  it('declares Macao when the card leaves one in hand', () => {
    const state = make(['9h 5c', '7s 8d']);
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({ payload: { declaredMacao: true } });
    const more = make(['9h 5c 6c', '7s 8d']);
    expect(chooseMacaoAction(more, BOT_ID)).toMatchObject({ payload: { declaredMacao: false } });
  });

  it('defends against a penalty when it can', () => {
    const state = make(['3s 9h', '7s 8d'], { penalty: { kind: 'draw', amount: 2 } });
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({ payload: { card: card('3s') } });
  });

  it('plays the card it has just drawn when it fits', () => {
    const state = make(['9h 5c', '7s 8d'], { drawn: card('9h') });
    expect(chooseMacaoAction(state, BOT_ID)).toMatchObject({ payload: { card: card('9h') } });
  });

  it('plays whole games against itself with every action accepted, for 2 players', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const pair: GamePlayer[] = [
        { id: 'bot', username: 'a', isBot: true },
        { id: 'bot2', username: 'b', isBot: true },
      ];
      let state = macaoModule.createInitialState(pair, seededRandom(seed * 17)) as MacaoState;
      for (let step = 0; step < 4000 && !macaoModule.isTerminal(state); step++) {
        const id = pair[state.current]!.id;
        const action = chooseMacaoAction(state, id);
        expect(action).not.toBeNull();
        state = macaoModule.applyAction(state, action!, id).newState as MacaoState;
      }
      expect(macaoModule.isTerminal(state)).toBe(true);
    }
  });
});
