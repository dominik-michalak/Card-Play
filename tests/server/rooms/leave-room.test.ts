import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRooms, roomPlayers, users } from '../../../server/src/db/schema';
import { signAccessToken } from '../../../server/src/modules/auth/tokens';
import { createRoomsService } from '../../../server/src/modules/rooms/rooms.service';
import { api, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

async function seedUser(username: string) {
  const [user] = await app.db
    .insert(users)
    .values({ username, email: `${username}@example.com`, passwordHash: 'x' })
    .returning();
  return user!;
}

// seats are assigned in the order of `members`; the first member is the host
async function seedRoom(
  members: { id: string }[],
  overrides: Partial<typeof gameRooms.$inferInsert> = {},
) {
  const [room] = await app.db
    .insert(gameRooms)
    .values({
      gameType: 'war',
      mode: 'private',
      targetPlayers: 2,
      createdBy: members[0]!.id,
      ...overrides,
    })
    .returning();
  await app.db
    .insert(roomPlayers)
    .values(members.map((m, seatIndex) => ({ roomId: room!.id, userId: m.id, seatIndex })));
  return room!;
}

const tokenFor = (userId: string) =>
  signAccessToken({ userId, role: 'user' }, app.config.jwtSecret, 60);
const leaveRequest = (roomId: string, token?: string) =>
  api(app.url, `/api/v1/lobbies/${roomId}/leave`, { token });

describe('leaveRoom', () => {
  it('removes the player and keeps the room when someone else stays', async () => {
    const [host, guest] = [await seedUser('host'), await seedUser('guest')];
    const room = await seedRoom([host, guest]);

    const result = await createRoomsService(app.db).leaveRoom(room.id, guest.id);

    expect(result).toEqual({ roomId: room.id, roomClosed: false, newHostId: null });
    const remaining = await app.db
      .select()
      .from(roomPlayers)
      .where(eq(roomPlayers.roomId, room.id));
    expect(remaining.map((p) => p.userId)).toEqual([host.id]);
  });

  it('hands the host over to the player with the lowest seat index', async () => {
    const [host, second, third] = [
      await seedUser('host'),
      await seedUser('second'),
      await seedUser('third'),
    ];
    const room = await seedRoom([host, second, third], { targetPlayers: 3 });

    const result = await createRoomsService(app.db).leaveRoom(room.id, host.id);

    expect(result).toEqual({ roomId: room.id, roomClosed: false, newHostId: second.id });
    const [updated] = await app.db.select().from(gameRooms).where(eq(gameRooms.id, room.id));
    expect(updated?.createdBy).toBe(second.id);
  });

  it('deletes a waiting room when the last player leaves', async () => {
    const host = await seedUser('host');
    const room = await seedRoom([host]);

    const result = await createRoomsService(app.db).leaveRoom(room.id, host.id);

    expect(result).toEqual({ roomId: room.id, roomClosed: true, newHostId: null });
    expect(await app.db.select().from(gameRooms).where(eq(gameRooms.id, room.id))).toHaveLength(0);
  });

  it('answers ROOM_NOT_FOUND for an unknown room and for a non-member alike', async () => {
    const [host, stranger] = [await seedUser('host'), await seedUser('stranger')];
    const room = await seedRoom([host]);
    const service = createRoomsService(app.db);

    await expect(service.leaveRoom(room.id, stranger.id)).rejects.toMatchObject({
      status: 404,
      code: 'ROOM_NOT_FOUND',
    });
    await expect(
      service.leaveRoom('00000000-0000-4000-8000-000000000000', host.id),
    ).rejects.toMatchObject({ status: 404, code: 'ROOM_NOT_FOUND' });
  });

  it('refuses to leave a room whose game already started', async () => {
    const [host, guest] = [await seedUser('host'), await seedUser('guest')];
    const room = await seedRoom([host, guest], { status: 'in_progress' });

    await expect(createRoomsService(app.db).leaveRoom(room.id, guest.id)).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_ACTION',
    });
    expect(
      await app.db.select().from(roomPlayers).where(eq(roomPlayers.roomId, room.id)),
    ).toHaveLength(2);
  });

  it('survives two players leaving at the same moment', async () => {
    const [host, guest] = [await seedUser('host'), await seedUser('guest')];
    const room = await seedRoom([host, guest]);
    const service = createRoomsService(app.db);

    const results = await Promise.all([
      service.leaveRoom(room.id, host.id),
      service.leaveRoom(room.id, guest.id),
    ]);

    expect(results.filter((r) => r.roomClosed)).toHaveLength(1);
    expect(await app.db.select().from(gameRooms).where(eq(gameRooms.id, room.id))).toHaveLength(0);
  });
});

describe('POST /lobbies/:id/leave', () => {
  it('requires authentication', async () => {
    const host = await seedUser('host');
    const room = await seedRoom([host]);
    expect((await leaveRequest(room.id)).status).toBe(401);
  });

  it('runs the service and reports the outcome', async () => {
    const [host, guest] = [await seedUser('host'), await seedUser('guest')];
    const room = await seedRoom([host, guest]);

    const res = await leaveRequest(room.id, tokenFor(host.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ roomId: room.id, roomClosed: false, newHostId: guest.id });
  });

  it('rejects a malformed room id', async () => {
    const host = await seedUser('host');
    const res = await leaveRequest('not-a-uuid', tokenFor(host.id));
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
  });

  it('returns 404 for a room the caller is not in', async () => {
    const [host, stranger] = [await seedUser('host'), await seedUser('stranger')];
    const room = await seedRoom([host]);
    const res = await leaveRequest(room.id, tokenFor(stranger.id));
    expect(res.status).toBe(404);
    expect(res.body?.error.code).toBe('ROOM_NOT_FOUND');
  });
});
