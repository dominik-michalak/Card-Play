import type { ClientPokerState, ErrorPayload, GameResult } from '@cardplay/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer, type TestClient } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));

type StateEvent = { roomId: string; state: ClientPokerState };
type GameEventPayload = { event: { type: string; data?: Record<string, unknown> } };
type FinishedEvent = { result: GameResult };

async function runningGame(count: number) {
  const users = [];
  for (let i = 0; i < count; i++) users.push(await seedUser(server.db, `player_${i}`));
  const room = await server.roomService.createRoom(users[0]!.id, {
    gameType: 'poker',
    targetPlayers: count,
  });
  for (const user of users.slice(1)) await server.roomService.joinByCode(user.id, room.inviteCode!);
  const clients: TestClient[] = [];
  for (const user of users) {
    const client = await server.connectAs(user.id);
    clients.push(client);
    client.emit('room:join', { roomId: room.id });
    await client.next('room:players');
  }
  for (const client of clients) client.emit('room:ready', { roomId: room.id, ready: true });
  const first = await Promise.all(clients.map((c) => c.next<StateEvent>('game:state_update')));
  return { users, clients, roomId: room.id, first: first.map((f) => f.state) };
}

describe('Poker over sockets', () => {
  it('seats 2 to 6 players, each seeing only their own cards', async () => {
    const { users, first } = await runningGame(3);

    first.forEach((view, i) => {
      expect(view.gameKey).toBe('poker');
      expect(view.hole).toHaveLength(2);
      expect(view.seats.map((s) => s.playerId)).toEqual(users.map((u) => u.id));
      expect(view.seats.map((s) => s.stack + s.bet)).toEqual([1000, 1000, 1000]);
      expect(view.turnDeadlineAt).not.toBeNull();
      for (const secret of ['deck', 'holes', 'rngState']) expect(view).not.toHaveProperty(secret);
      expect(view.legal === null).toBe(view.currentPlayerId !== users[i]!.id);
    });
    expect(new Set(first.map((v) => JSON.stringify(v.hole))).size).toBe(3);
  });

  it('lets only the player on turn act and tells the table about the action', async () => {
    const { users, clients, roomId, first } = await runningGame(3);
    const current = users.findIndex((u) => u.id === first[0]!.currentPlayerId);
    const other = (current + 1) % 3;

    clients[other]!.emit('game:action', { roomId, action: { type: 'fold' } });
    expect((await clients[other]!.next<ErrorPayload>('error')).code).toBe('NOT_YOUR_TURN');

    clients[current]!.emit('game:action', { roomId, action: { type: 'fold' } });
    const event = await clients[other]!.next<GameEventPayload>(
      'game:event',
      (e) => e.event.type === 'action_taken',
    );
    expect(event.event.data).toMatchObject({ playerId: users[current]!.id, action: 'fold' });
  });

  it('refuses an illegal raise with INVALID_ACTION', async () => {
    const { users, clients, roomId, first } = await runningGame(2);
    const current = users.findIndex((u) => u.id === first[0]!.currentPlayerId);
    clients[current]!.emit('game:action', {
      roomId,
      action: { type: 'raise', payload: { amount: 21 } },
    });
    expect((await clients[current]!.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });

  it('drops a player who runs out of time, who folds, and plays on', async () => {
    const { clients, users } = await runningGame(3);

    const out = await clients[0]!.next<GameEventPayload>(
      'game:event',
      (e) => e.event.type === 'player_eliminated',
    );

    expect(out.event.data).toMatchObject({ reason: 'timeout_forfeit' });
    expect(users.map((u) => u.id)).toContain(out.event.data!.playerId);
  });

  it('ends a heads-up match when a player does not come back', async () => {
    const { clients } = await runningGame(2);
    clients[1]!.close();

    const finished = await clients[0]!.next<FinishedEvent>('game:finished', () => true, 4000);

    expect(finished.result.terminationReason).toBe('disconnect_forfeit');
    expect(finished.result.placements.filter((p) => p.rank === 1)).toHaveLength(1);
  });
});
