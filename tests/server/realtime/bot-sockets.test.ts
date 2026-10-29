import type { ClientGameState, ClientMacaoState, GameResult, RoomPlayer } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRecordPlayers, gameRecords, userRatings } from '../../../server/src/db/schema';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));

type StateEvent = { roomId: string; state: ClientGameState };
type GameEventPayload = { event: { type: string; data?: Record<string, unknown> } };
type FinishedEvent = { result: GameResult; ratings: unknown[] };

// the human joins a bot room and does nothing else: the game must start by itself
async function botRoom(gameType: 'war' | 'macao') {
  const host = await seedUser(server.db, 'human_player');
  const room = await server.roomService.createRoom(host.id, { gameType, mode: 'bot' });
  const client = await server.connectAs(host.id);
  client.emit('room:join', { roomId: room.id });
  return { host, room, client };
}

describe('a game against the bot', () => {
  it('starts without a ready click and seats the bot as the second player', async () => {
    const { client, host } = await botRoom('war');

    const players = await client.next<{ players: RoomPlayer[] }>('room:players');
    expect(players.players.map((p) => p.userId)).toEqual([host.id]);
    const start = await client.next<StateEvent>('game:state_update');

    expect(start.state.players).toEqual([
      { id: host.id, username: 'human_player', isBot: false },
      { id: 'bot', username: 'Bot', isBot: true },
    ]);
    expect(start.state.turnDeadlineAt).not.toBeNull();
  });

  it('flips for the bot in War, and a player who does nothing loses by timeout', async () => {
    const { client, room, host } = await botRoom('war');
    await client.next('game:state_update');

    client.emit('game:action', { roomId: room.id, action: { type: 'flip' } });
    await client.next<GameEventPayload>('game:event', (e) => e.event.type === 'round_resolved');

    const finished = await client.next<FinishedEvent>('game:finished', () => true, 3000);
    expect(finished.result.terminationReason).toBe('timeout_forfeit');
    expect(finished.result.placements.find((p) => p.rank === 1)?.playerId).toBe('bot');
    expect(finished.ratings).toEqual([]);

    const [record] = await server.db.select().from(gameRecords);
    expect(record).toMatchObject({ mode: 'bot', winnerId: null });
    const rows = await server.db
      .select()
      .from(gameRecordPlayers)
      .where(eq(gameRecordPlayers.recordId, record!.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([host.id, null].sort());
    expect(await server.db.select().from(userRatings)).toEqual([]);
  });

  it('plays its Macao moves by itself after a short delay', async () => {
    const { client, room } = await botRoom('macao');
    const first = await client.next<StateEvent>('game:state_update');
    const botMoved = client.next<GameEventPayload>(
      'game:event',
      (e) =>
        ['card_played', 'cards_drawn'].includes(e.event.type) && e.event.data?.playerId === 'bot',
      3000,
    );

    if (first.state.currentPlayerId !== 'bot') {
      // hand the turn over: draw, and pass if the drawn card was playable. The bot may also
      // answer at once (an automatic move), so either event can come first.
      const mustPass = client
        .next<{ state: ClientMacaoState }>('game:state_update', (e) => e.state.canPass, 3000)
        .catch(() => null);
      client.emit('game:action', { roomId: room.id, action: { type: 'draw' } });
      const winner = await Promise.race([botMoved.then(() => 'bot'), mustPass.then(() => 'pass')]);
      if (winner === 'pass') {
        client.emit('game:action', { roomId: room.id, action: { type: 'pass' } });
      }
    }

    const move = await botMoved;
    expect(move.event.data?.playerId).toBe('bot');
  });
});
