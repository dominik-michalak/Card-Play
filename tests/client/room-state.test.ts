import type { ClientGameState, Room, RoomPlayer } from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import { cardLabel, cardSpoken } from '../../client/src/cards';
import { initialRoomState, roomReducer } from '../../client/src/room-state';

const room: Room = {
  id: 'room-1',
  gameType: 'war',
  mode: 'private',
  status: 'waiting',
  targetPlayers: 2,
  createdBy: 'u1',
  inviteCode: 'ABCDEFGH',
  players: [{ userId: 'u1', username: 'host', seatIndex: 0 }],
};
const gameState: ClientGameState = {
  gameKey: 'war',
  players: [],
  currentPlayerId: null,
  turnDeadlineAt: null,
};
const players: RoomPlayer[] = [{ userId: 'u1', username: 'host', seatIndex: 0, ready: true }];

describe('roomReducer', () => {
  it('starts from the REST snapshot with nobody ready', () => {
    expect(initialRoomState(room).players).toEqual([
      { userId: 'u1', username: 'host', seatIndex: 0, ready: false },
    ]);
  });

  it('applies players, countdown and game state of its room', () => {
    let state = initialRoomState(room);
    state = roomReducer(state, { type: 'players', roomId: 'room-1', players });
    state = roomReducer(state, {
      type: 'countdown',
      roomId: 'room-1',
      startsAt: '2030-01-01T00:00:00Z',
    });
    expect(state.players[0]?.ready).toBe(true);
    expect(state.startsAt).toBe('2030-01-01T00:00:00Z');

    state = roomReducer(state, { type: 'state', roomId: 'room-1', state: gameState });
    expect(state.game).toBe(gameState);
    expect(state.startsAt).toBeNull();
  });

  it('keeps the result and the rating changes when the game finishes', () => {
    const state = roomReducer(initialRoomState(room), {
      type: 'finished',
      roomId: 'room-1',
      result: { terminationReason: 'draw', placements: [] },
      ratings: [{ userId: 'u1', eloBefore: 1000, eloChange: 16 }],
    });
    expect(state.finished?.ratings[0]?.eloChange).toBe(16);
  });

  it('ignores events of another room', () => {
    const state = initialRoomState(room);
    expect(roomReducer(state, { type: 'players', roomId: 'other', players })).toBe(state);
    expect(roomReducer(state, { type: 'state', roomId: 'other', state: gameState })).toBe(state);
  });

  it('collects chat lines of its room in order and keeps the latest 100', () => {
    let state = initialRoomState(room);
    for (let i = 0; i < 105; i++) {
      state = roomReducer(state, {
        type: 'chat',
        line: {
          roomId: 'room-1',
          userId: 'u1',
          username: 'host',
          message: `line ${i}`,
          sentAt: 't',
        },
      });
    }
    expect(state.chat).toHaveLength(100);
    expect(state.chat[0]?.message).toBe('line 5');
    expect(state.chat.at(-1)?.message).toBe('line 104');
  });

  it('ignores chat lines of another room', () => {
    const state = initialRoomState(room);
    const other = roomReducer(state, {
      type: 'chat',
      line: { roomId: 'other', userId: 'u2', username: 'x', message: 'hi', sentAt: 't' },
    });
    expect(other).toBe(state);
  });

  it('shows an error until it is dismissed', () => {
    let state = roomReducer(initialRoomState(room), { type: 'error', message: 'room is full' });
    expect(state.error).toBe('room is full');
    state = roomReducer(state, { type: 'dismiss_error' });
    expect(state.error).toBeNull();
  });
});

describe('cardSpoken', () => {
  it('names a card in words, for a screen reader', () => {
    expect(cardSpoken({ rank: '9', suit: 'hearts' })).toBe('9 kier');
    expect(cardSpoken({ rank: 'A', suit: 'spades' })).toBe('as pik');
    expect(cardSpoken({ rank: 'K', suit: 'diamonds' })).toBe('król karo');
    expect(cardSpoken({ rank: 'Q', suit: 'clubs' })).toBe('dama trefl');
    expect(cardSpoken({ rank: 'J', suit: 'hearts' })).toBe('walet kier');
    expect(cardSpoken({ rank: '10', suit: 'clubs' })).toBe('10 trefl');
  });
});

describe('cardLabel', () => {
  it('writes rank and suit symbol', () => {
    expect(cardLabel({ rank: '10', suit: 'hearts' })).toBe('10♥');
    expect(cardLabel({ rank: 'A', suit: 'spades' })).toBe('A♠');
  });
});
