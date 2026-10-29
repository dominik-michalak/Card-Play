import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRooms, roomPlayers } from '../../../server/src/db/schema';
import { createRoomsService } from '../../../server/src/modules/rooms/rooms.service';
import { startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;
let service: ReturnType<typeof createRoomsService>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb(app.db);
  service = createRoomsService(app.db);
});

describe('createMatchRoom', () => {
  it.each(['competitive', 'unrated'] as const)('seats both players in a %s room', async (mode) => {
    const [a, b] = [await seedUser(app.db, 'player_a'), await seedUser(app.db, 'player_b')];

    const room = await service.createMatchRoom('macao', mode, [a.id, b.id]);

    expect(room).toMatchObject({
      gameType: 'macao',
      mode,
      status: 'waiting',
      targetPlayers: 2,
      inviteCode: null,
      createdBy: a.id,
    });
    expect(room.players.map((p) => [p.userId, p.seatIndex])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);
  });

  it('makes both players belong to the room (one active room rule)', async () => {
    const [a, b] = [await seedUser(app.db, 'player_a'), await seedUser(app.db, 'player_b')];
    const room = await service.createMatchRoom('war', 'competitive', [a.id, b.id]);

    expect((await service.getCurrentRoom(a.id)).id).toBe(room.id);
    expect((await service.getCurrentRoom(b.id)).id).toBe(room.id);
  });

  it('creates nothing when one of the players is already in a room', async () => {
    const [a, b] = [await seedUser(app.db, 'player_a'), await seedUser(app.db, 'player_b')];
    await service.createRoom(b.id, { gameType: 'war' });
    const rooms = (await app.db.select().from(gameRooms)).length;

    await expect(service.createMatchRoom('war', 'competitive', [a.id, b.id])).rejects.toMatchObject(
      {
        status: 409,
        code: 'ROOM_MEMBERSHIP_CONFLICT',
      },
    );

    expect(await app.db.select().from(gameRooms)).toHaveLength(rooms);
    expect(await app.db.select().from(roomPlayers).where(eq(roomPlayers.userId, a.id))).toEqual([]);
  });

  it('refuses to match a player with themselves', async () => {
    const a = await seedUser(app.db, 'player_a');
    await expect(service.createMatchRoom('war', 'competitive', [a.id, a.id])).rejects.toThrow();
  });
});
