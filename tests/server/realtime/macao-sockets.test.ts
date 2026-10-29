import type { ClientMacaoState, ErrorPayload, GameResult } from '@cardplay/shared';
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

type StateEvent = { roomId: string; state: ClientMacaoState };
type GameEventPayload = { event: { type: string; data?: Record<string, unknown> } };
type FinishedEvent = { result: GameResult };

// a running private Macao game with `count` connected players
async function runningGame(count: number) {
  const users = [];
  for (let i = 0; i < count; i++) users.push(await seedUser(server.db, `player_${i}`));
  const room = await server.roomService.createRoom(users[0]!.id, {
    gameType: 'macao',
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

describe('starting Macao', () => {
  it('gives each player their own view of the game and nothing of the others', async () => {
    const { users, first } = await runningGame(3);

    first.forEach((view, i) => {
      expect(view.gameKey).toBe('macao');
      expect(view.hand.length).toBeGreaterThanOrEqual(5);
      expect(view.handSizes[users[i]!.id]).toBe(view.hand.length);
      expect(view.turnDeadlineAt).not.toBeNull();
      for (const secret of ['hands', 'drawPile', 'rngState', 'discard']) {
        expect(view).not.toHaveProperty(secret);
      }
    });
    // everybody sees the same table
    expect(new Set(first.map((v) => JSON.stringify(v.topCard))).size).toBe(1);
    expect(new Set(first.map((v) => v.currentPlayerId)).size).toBe(1);
  });

  it('lets only the player on turn act, and tells the table about a draw', async () => {
    const { users, clients, roomId, first } = await runningGame(3);
    const current = users.findIndex((u) => u.id === first[0]!.currentPlayerId);
    const other = (current + 1) % 3;

    clients[other]!.emit('game:action', { roomId, action: { type: 'draw' } });
    expect((await clients[other]!.next<ErrorPayload>('error')).code).toBe('NOT_YOUR_TURN');

    clients[current]!.emit('game:action', { roomId, action: { type: 'draw' } });
    const drawn = await clients[other]!.next<GameEventPayload>(
      'game:event',
      (e) => e.event.type === 'cards_drawn',
    );
    expect(drawn.event.data).toEqual({ playerId: users[current]!.id, count: 1 });
  });

  it('refuses a report when nobody can be reported', async () => {
    const { clients, roomId } = await runningGame(2);
    clients[0]!.emit('game:action', { roomId, action: { type: 'report_macao' } });
    expect((await clients[0]!.next<ErrorPayload>('error')).code).toBe('INVALID_ACTION');
  });
});

describe('eliminations in a three-player game', () => {
  it('drops a player who runs out of time and plays on with the rest', async () => {
    const { clients, users } = await runningGame(3);

    const eliminated = await clients[0]!.next<GameEventPayload>(
      'game:event',
      (e) => e.event.type === 'player_eliminated',
    );
    expect(eliminated.event.data).toMatchObject({ reason: 'timeout_forfeit' });
    const goneId = eliminated.event.data!.playerId as string;
    expect(users.map((u) => u.id)).toContain(goneId);

    const after = await clients[0]!.next<StateEvent>(
      'game:state_update',
      (e) => e.state.eliminatedIds.includes(goneId) && e.state.turnDeadlineAt !== null,
    );
    expect(after.state.eliminatedIds).toEqual([goneId]);
    expect(after.state.currentPlayerId).not.toBe(goneId);
  });

  it('ends the game when the second player is out, the last one standing wins', async () => {
    const { clients } = await runningGame(3);

    const finished = await clients[0]!.next<FinishedEvent>('game:finished', () => true, 4000);

    expect(finished.result.terminationReason).toBe('timeout_forfeit');
    expect(finished.result.placements.filter((p) => p.rank === 1)).toHaveLength(1);
    expect(finished.result.placements.filter((p) => p.rank === 2)).toHaveLength(2);
  });

  it('pauses for a disconnect, then eliminates the player and carries on', async () => {
    const { clients, users } = await runningGame(3);

    clients[2]!.close();

    await clients[0]!.next<StateEvent>('game:state_update', (e) => e.state.turnDeadlineAt === null);
    const eliminated = await clients[0]!.next<GameEventPayload>(
      'game:event',
      (e) => e.event.type === 'player_eliminated',
    );
    expect(eliminated.event.data).toEqual({
      playerId: users[2]!.id,
      reason: 'disconnect_forfeit',
    });
    const resumed = await clients[0]!.next<StateEvent>(
      'game:state_update',
      (e) => e.state.eliminatedIds.includes(users[2]!.id) && e.state.turnDeadlineAt !== null,
    );
    expect(resumed.state.eliminatedIds).toEqual([users[2]!.id]);
  });
});
