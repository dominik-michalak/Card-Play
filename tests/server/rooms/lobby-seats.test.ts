import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function fullRoom() {
  const [host, guest] = [await seedUser(app.db, 'host'), await seedUser(app.db, 'guest')];
  const room = await service.createRoom(host.id, { gameType: 'war' });
  await service.joinByCode(guest.id, room.inviteCode!);
  return { host, guest, roomId: room.id };
}

describe('seats', () => {
  it('moves a player to a free seat', async () => {
    const host = await seedUser(app.db, 'host');
    const room = await service.createRoom(host.id, { gameType: 'poker', targetPlayers: 4 });

    const updated = await service.takeSeat(room.id, host.id, 3);

    expect(updated.players).toMatchObject([{ userId: host.id, seatIndex: 3 }]);
  });

  it('refuses a seat somebody else occupies', async () => {
    const { host, roomId } = await fullRoom();
    await expect(service.takeSeat(roomId, host.id, 1)).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_ACTION',
    });
  });

  it('refuses a seat outside the table', async () => {
    const { host, roomId } = await fullRoom();
    await expect(service.takeSeat(roomId, host.id, 2)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PAYLOAD',
    });
  });

  it('answers ROOM_NOT_FOUND to someone outside the room', async () => {
    const { roomId } = await fullRoom();
    const stranger = await seedUser(app.db, 'stranger');
    await expect(service.takeSeat(roomId, stranger.id, 0)).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
    });
  });
});
