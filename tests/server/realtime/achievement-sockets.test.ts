import type { UnlockedAchievement } from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userAchievements } from '../../../server/src/db/schema';
import { resetDb } from '../../helpers/db';
import { startRealtimeServer } from '../../helpers/realtime';
import { seedUser } from '../../helpers/users';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  server = await startRealtimeServer();
});
afterAll(() => server.close());
beforeEach(() => resetDb(server.db));

describe('achievement:unlocked', () => {
  it('tells the winner of a private game, and only the winner, and stores it', async () => {
    const host = await seedUser(server.db, 'host_player');
    const guest = await seedUser(server.db, 'guest_player');
    const room = await server.roomService.createRoom(host.id, { gameType: 'war' });
    await server.roomService.joinByCode(guest.id, room.inviteCode!);
    const hostClient = await server.connectAs(host.id);
    const guestClient = await server.connectAs(guest.id);
    for (const client of [hostClient, guestClient]) {
      client.emit('room:join', { roomId: room.id });
      await client.next('room:players');
      client.emit('room:ready', { roomId: room.id, ready: true });
    }
    await hostClient.next('game:state_update');

    // the host confirms the round, the guest does not: the guest loses by timeout
    hostClient.emit('game:action', { roomId: room.id, action: { type: 'flip' } });
    const unlocked = await hostClient.next<UnlockedAchievement>(
      'achievement:unlocked',
      () => true,
      4000,
    );

    expect(unlocked.id).toBe('first_win');
    expect(new Date(unlocked.unlockedAt).getTime()).toBeGreaterThan(Date.now() - 10_000);
    await guestClient.quiet('achievement:unlocked', 200);
    expect(
      await server.db.select().from(userAchievements).where(eq(userAchievements.userId, host.id)),
    ).toHaveLength(1);
  });
});
