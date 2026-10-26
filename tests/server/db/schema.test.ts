import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  gameRecordPlayers,
  gameRecords,
  gameRooms,
  refreshTokens,
  roomPlayers,
  userRatings,
  users,
} from '../../../server/src/db/schema';
import { openTestDb, PG, pgErrorCode, resetDb } from '../../helpers/db';

const { db, pool } = openTestDb();

afterAll(() => pool.end());
beforeEach(() => resetDb(db));

async function createUser(username = 'alice', email = `${username}@example.com`) {
  const [user] = await db
    .insert(users)
    .values({ username, email, passwordHash: 'hash' })
    .returning();
  return user!;
}

async function createRoom(
  createdBy: string,
  overrides: Partial<typeof gameRooms.$inferInsert> = {},
) {
  const [room] = await db
    .insert(gameRooms)
    .values({ gameType: 'war', mode: 'private', targetPlayers: 2, createdBy, ...overrides })
    .returning();
  return room!;
}

describe('users', () => {
  it('applies defaults', async () => {
    const user = await createUser();
    expect(user.role).toBe('user');
    expect(user.isBanned).toBe(false);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a username that differs only by case', async () => {
    await createUser('Alice');
    expect(await pgErrorCode(createUser('alice', 'other@example.com'))).toBe(PG.unique);
  });

  it('rejects an email that differs only by case', async () => {
    await createUser('alice', 'a@example.com');
    expect(await pgErrorCode(createUser('bob', 'A@Example.com'))).toBe(PG.unique);
  });

  it.each(['ab', 'a'.repeat(21)])('rejects username length %s', async (username) => {
    expect(await pgErrorCode(createUser(username, 'x@example.com'))).toBe(PG.check);
  });

  it('accepts the length boundaries', async () => {
    await createUser('abc', 'a@example.com');
    await createUser('a'.repeat(20), 'b@example.com');
  });

  it('rejects an unknown role', async () => {
    const insert = db.insert(users).values({
      username: 'eve',
      email: 'e@example.com',
      passwordHash: 'h',
      role: 'root' as 'admin',
    });
    expect(await pgErrorCode(insert)).toBe(PG.invalidText);
  });

  it('stores SQL metacharacters as plain data', async () => {
    const nasty = "a';DROP TABLE t;--";
    await createUser(nasty, 'n@example.com');
    const [found] = await db.select().from(users).where(eq(users.username, nasty));
    expect(found?.username).toBe(nasty);
  });
});

describe('user_ratings', () => {
  it('defaults to 1000 Elo and 0 games', async () => {
    const user = await createUser();
    const [rating] = await db
      .insert(userRatings)
      .values({ userId: user.id, gameType: 'war' })
      .returning();
    expect(rating).toMatchObject({ elo: 1000, gamesPlayed: 0 });
  });

  it('allows one rating per user and game', async () => {
    const user = await createUser();
    await db.insert(userRatings).values({ userId: user.id, gameType: 'war' });
    await db.insert(userRatings).values({ userId: user.id, gameType: 'poker' });
    const duplicate = db.insert(userRatings).values({ userId: user.id, gameType: 'war' });
    expect(await pgErrorCode(duplicate)).toBe(PG.unique);
  });

  it('rejects negative Elo', async () => {
    const user = await createUser();
    const insert = db.insert(userRatings).values({ userId: user.id, gameType: 'war', elo: -1 });
    expect(await pgErrorCode(insert)).toBe(PG.check);
  });

  it('is removed together with the user', async () => {
    const user = await createUser();
    await db.insert(userRatings).values({ userId: user.id, gameType: 'war' });
    await db.delete(users).where(eq(users.id, user.id));
    expect(await db.select().from(userRatings)).toHaveLength(0);
  });
});

describe('refresh_tokens', () => {
  const values = (userId: string, tokenHash: string) => ({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 1000),
  });

  it('rejects a duplicate token hash', async () => {
    const user = await createUser();
    await db.insert(refreshTokens).values(values(user.id, 'h1'));
    expect(await pgErrorCode(db.insert(refreshTokens).values(values(user.id, 'h1')))).toBe(
      PG.unique,
    );
  });

  it('rejects a token for a missing user', async () => {
    const insert = db
      .insert(refreshTokens)
      .values(values('00000000-0000-4000-8000-000000000000', 'h2'));
    expect(await pgErrorCode(insert)).toBe(PG.foreignKey);
  });
});

describe('game_rooms and room_players', () => {
  it('defaults the status to waiting', async () => {
    const user = await createUser();
    expect((await createRoom(user.id)).status).toBe('waiting');
  });

  it.each([1, 7])('rejects targetPlayers %i', async (targetPlayers) => {
    const user = await createUser();
    expect(await pgErrorCode(createRoom(user.id, { targetPlayers }))).toBe(PG.check);
  });

  it.each([2, 6])('accepts targetPlayers %i', async (targetPlayers) => {
    const user = await createUser();
    expect((await createRoom(user.id, { targetPlayers })).targetPlayers).toBe(targetPlayers);
  });

  it('keeps invite codes unique', async () => {
    const user = await createUser();
    await createRoom(user.id, { inviteCode: 'ABC123' });
    expect(await pgErrorCode(createRoom(user.id, { inviteCode: 'ABC123' }))).toBe(PG.unique);
  });

  it('rejects the same user twice in one room', async () => {
    const user = await createUser();
    const room = await createRoom(user.id);
    await db.insert(roomPlayers).values({ roomId: room.id, userId: user.id });
    const again = db.insert(roomPlayers).values({ roomId: room.id, userId: user.id });
    expect(await pgErrorCode(again)).toBe(PG.unique);
  });

  it('rejects two players on one seat but allows several unseated', async () => {
    const [a, b, c] = [await createUser('aaa'), await createUser('bbb'), await createUser('ccc')];
    const room = await createRoom(a.id, { targetPlayers: 3 });
    await db.insert(roomPlayers).values({ roomId: room.id, userId: a.id, seatIndex: 0 });
    const sameSeat = db.insert(roomPlayers).values({ roomId: room.id, userId: b.id, seatIndex: 0 });
    expect(await pgErrorCode(sameSeat)).toBe(PG.unique);
    await db.insert(roomPlayers).values({ roomId: room.id, userId: b.id });
    await db.insert(roomPlayers).values({ roomId: room.id, userId: c.id });
  });

  it('removes players with the room', async () => {
    const user = await createUser();
    const room = await createRoom(user.id);
    await db.insert(roomPlayers).values({ roomId: room.id, userId: user.id });
    await db.delete(gameRooms).where(eq(gameRooms.id, room.id));
    expect(await db.select().from(roomPlayers)).toHaveLength(0);
  });
});

describe('game_records', () => {
  let userCounter = 0;

  async function createRecord(overrides: Partial<typeof gameRecords.$inferInsert> = {}) {
    const user = await createUser(`user${userCounter++}`);
    const room = await createRoom(user.id);
    return db
      .insert(gameRecords)
      .values({
        roomId: room.id,
        gameType: 'war',
        mode: 'private',
        state: { round: 1 },
        ...overrides,
      })
      .returning();
  }

  it('allows an unfinished record', async () => {
    const [record] = await createRecord();
    expect(record).toMatchObject({ finishedAt: null, terminationReason: null, winnerId: null });
  });

  it('allows a finished draw without a winner', async () => {
    const [record] = await createRecord({ finishedAt: new Date(), terminationReason: 'draw' });
    expect(record?.winnerId).toBeNull();
  });

  it('rejects a finish time without a termination reason and vice versa', async () => {
    expect(await pgErrorCode(createRecord({ finishedAt: new Date() }))).toBe(PG.check);
    expect(await pgErrorCode(createRecord({ terminationReason: 'draw' }))).toBe(PG.check);
  });

  it('rejects an unknown termination reason', async () => {
    const insert = createRecord({
      finishedAt: new Date(),
      terminationReason: 'nope' as 'draw',
    });
    expect(await pgErrorCode(insert)).toBe(PG.invalidText);
  });

  it('stores bot participants without a user and validates ranks', async () => {
    const [record] = await createRecord();
    await db.insert(gameRecordPlayers).values({ recordId: record!.id, userId: null, finalRank: 2 });
    const badRank = db
      .insert(gameRecordPlayers)
      .values({ recordId: record!.id, userId: null, finalRank: 0 });
    expect(await pgErrorCode(badRank)).toBe(PG.check);
  });
});
