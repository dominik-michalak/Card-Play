import type { ClientGameState, Room, RoomPlayer } from '@cardplay/shared';
import { describe, expect, it } from 'vitest';
import { cardLabel } from '../../client/src/cards';
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

  it('shows an error until it is dismissed', () => {
    let state = roomReducer(initialRoomState(room), { type: 'error', message: 'room is full' });
    expect(state.error).toBe('room is full');
    state = roomReducer(state, { type: 'dismiss_error' });
    expect(state.error).toBeNull();
  });
});

describe('cardLabel', () => {
  it('writes rank and suit symbol', () => {
    expect(cardLabel({ rank: '10', suit: 'hearts' })).toBe('10♥');
    expect(cardLabel({ rank: 'A', suit: 'spades' })).toBe('A♠');
  });
});
