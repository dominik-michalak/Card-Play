import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gameRooms } from '../../../server/src/db/schema';
import { api, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser, tokenFor } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

const INVITE_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

async function newUser(name: string) {
  const user = await seedUser(app.db, name);
  return { ...user, token: tokenFor(app.config, user.id) };
}

const create = (token: string | undefined, body: unknown = { gameType: 'war' }) =>
  api(app.url, '/api/v1/lobbies', { token, body });
const join = (token: string | undefined, code: unknown) =>
  api(app.url, '/api/v1/lobbies/join', { token, body: { code } });

describe('POST /lobbies', () => {
  it('requires authentication', async () => {
    expect((await create(undefined)).status).toBe(401);
  });

  it('creates a private room with the host in seat 0 and an invite code', async () => {
    const host = await newUser('host');
    const res = await create(host.token);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      gameType: 'war',
      mode: 'private',
      status: 'waiting',
      targetPlayers: 2,
      createdBy: host.id,
      players: [{ userId: host.id, username: 'host', seatIndex: 0 }],
    });
    expect(res.body?.inviteCode).toMatch(INVITE_CODE);
  });

  it('uses the requested player count within the game limits', async () => {
    const host = await newUser('host');
    const res = await create(host.token, { gameType: 'poker', targetPlayers: 4 });
    expect(res.status).toBe(201);
    expect(res.body?.targetPlayers).toBe(4);
  });

  it.each([
    ['an unknown game', { gameType: 'chess' }],
    ['a missing game', {}],
    ['too many players for the game', { gameType: 'war', targetPlayers: 3 }],
    ['a non-integer player count', { gameType: 'poker', targetPlayers: 2.5 }],
    ['a client-chosen mode', { gameType: 'war', mode: 'competitive' }],
  ])('rejects %s', async (_name, body) => {
    const host = await newUser('host');
    const res = await create(host.token, body);
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
  });

  it('gives every room a different code', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const host = await newUser(`host_${i}`);
      codes.add((await create(host.token)).body?.inviteCode);
    }
    expect(codes.size).toBe(15);
  });
});

describe('POST /lobbies with a bot', () => {
  it.each(['war', 'macao'] as const)(
    'creates a bot room for %s without an invite code',
    async (gameType) => {
      const host = await newUser('host');

      const res = await create(host.token, { gameType, mode: 'bot' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        gameType,
        mode: 'bot',
        status: 'waiting',
        targetPlayers: 2,
        inviteCode: null,
        players: [{ userId: host.id, seatIndex: 0 }],
      });
    },
  );

  it.each([
    ['a game without a bot', { gameType: 'poker', mode: 'bot' }],
    ['more than one opponent', { gameType: 'macao', mode: 'bot', targetPlayers: 3 }],
    ['a ranked mode chosen by the client', { gameType: 'war', mode: 'competitive' }],
    ['an unrated mode chosen by the client', { gameType: 'war', mode: 'unrated' }],
  ])('rejects %s', async (_name, body) => {
    const host = await newUser('host');
    const res = await create(host.token, body);
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
  });

  it('still binds the host to one active room', async () => {
    const host = await newUser('host');
    await create(host.token, { gameType: 'war', mode: 'bot' });
    expect((await create(host.token)).body?.error.code).toBe('ROOM_MEMBERSHIP_CONFLICT');
  });

  it('accepts an explicit private mode', async () => {
    const host = await newUser('host');
    const res = await create(host.token, { gameType: 'war', mode: 'private' });
    expect(res.status).toBe(201);
    expect(res.body?.inviteCode).toMatch(INVITE_CODE);
  });
});

describe('POST /lobbies/join', () => {
  it('seats the guest at the lowest free seat', async () => {
    const [host, guest] = [await newUser('host'), await newUser('guest')];
    const { inviteCode } = (await create(host.token)).body!;

    const res = await join(guest.token, inviteCode);

    expect(res.status).toBe(200);
    expect(res.body?.players).toMatchObject([
      { userId: host.id, seatIndex: 0 },
      { userId: guest.id, username: 'guest', seatIndex: 1 },
    ]);
  });

  it('accepts a code typed in lower case with spaces around it', async () => {
    const [host, guest] = [await newUser('host'), await newUser('guest')];
    const { inviteCode } = (await create(host.token)).body!;
    expect((await join(guest.token, ` ${inviteCode.toLowerCase()} `)).status).toBe(200);
  });

  it('requires authentication', async () => {
    expect((await join(undefined, 'ABCDEFGH')).status).toBe(401);
  });

  it('answers 404 for a well-formed code that does not exist', async () => {
    const guest = await newUser('guest');
    const res = await join(guest.token, 'ABCDEFGH');
    expect(res.status).toBe(404);
    expect(res.body?.error.code).toBe('ROOM_NOT_FOUND');
  });

  it.each([
    ['short', 'ABC'],
    ['wrong alphabet', 'AAAAAAA0'],
    ['not a string', 12345678],
  ])('rejects a code that is %s', async (_name, code) => {
    const guest = await newUser('guest');
    expect((await join(guest.token, code)).status).toBe(400);
  });

  it('answers 404 once the code is older than 10 minutes', async () => {
    const [host, guest] = [await newUser('host'), await newUser('guest')];
    const created = (await create(host.token)).body!;
    await app.db
      .update(gameRooms)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000 - 1000) })
      .where(eq(gameRooms.id, created.id));

    expect((await join(guest.token, created.inviteCode)).status).toBe(404);
  });

  it('answers 404 once the game has started', async () => {
    const [host, guest] = [await newUser('host'), await newUser('guest')];
    const created = (await create(host.token)).body!;
    await app.db
      .update(gameRooms)
      .set({ status: 'in_progress' })
      .where(eq(gameRooms.id, created.id));

    expect((await join(guest.token, created.inviteCode)).status).toBe(404);
  });

  it('answers ROOM_FULL when every seat is taken', async () => {
    const [host, guest, late] = [
      await newUser('host'),
      await newUser('guest'),
      await newUser('late'),
    ];
    const { inviteCode } = (await create(host.token)).body!;
    await join(guest.token, inviteCode);

    const res = await join(late.token, inviteCode);
    expect(res.status).toBe(409);
    expect(res.body?.error.code).toBe('ROOM_FULL');
  });

  it('is idempotent for a player who is already inside', async () => {
    const [host, guest] = [await newUser('host'), await newUser('guest')];
    const { inviteCode } = (await create(host.token)).body!;
    await join(guest.token, inviteCode);

    const again = await join(guest.token, inviteCode);
    expect(again.status).toBe(200);
    expect(again.body?.players).toHaveLength(2);
  });

  it('gives the last seat to exactly one of two simultaneous guests', async () => {
    const [host, a, b] = [
      await newUser('host'),
      await newUser('guest_a'),
      await newUser('guest_b'),
    ];
    const { inviteCode } = (await create(host.token)).body!;

    const results = await Promise.all([join(a.token, inviteCode), join(b.token, inviteCode)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('GET /lobbies/:id', () => {
  it('returns the room with its invite code to a member', async () => {
    const host = await newUser('host');
    const created = (await create(host.token)).body!;

    const res = await api(app.url, `/api/v1/lobbies/${created.id}`, {
      method: 'GET',
      token: host.token,
      origin: null,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
  });

  it('answers 404 to a player who is not in the room', async () => {
    const [host, stranger] = [await newUser('host'), await newUser('stranger')];
    const created = (await create(host.token)).body!;

    const res = await api(app.url, `/api/v1/lobbies/${created.id}`, {
      method: 'GET',
      token: stranger.token,
      origin: null,
    });
    expect(res.status).toBe(404);
  });
});

describe('one active room per player', () => {
  it('refuses to create a second room while sitting in a waiting one', async () => {
    const host = await newUser('host');
    await create(host.token);

    const res = await create(host.token);

    expect(res.status).toBe(409);
    expect(res.body?.error.code).toBe('ROOM_MEMBERSHIP_CONFLICT');
  });

  it('refuses to join another room while sitting in a waiting one', async () => {
    const [host, other, guest] = [
      await newUser('host'),
      await newUser('other'),
      await newUser('guest'),
    ];
    await create(host.token);
    const { inviteCode } = (await create(other.token)).body!;
    await join(guest.token, inviteCode);

    const res = await join(host.token, inviteCode);

    expect(res.status).toBe(409);
    expect(res.body?.error.code).toBe('ROOM_MEMBERSHIP_CONFLICT');
  });

  it.each(['waiting', 'in_progress'] as const)(
    'refuses to create a room while sitting in a %s one',
    async (status) => {
      const host = await newUser('host');
      const first = (await create(host.token)).body!;
      await app.db.update(gameRooms).set({ status }).where(eq(gameRooms.id, first.id));

      const res = await create(host.token);

      expect(res.status).toBe(409);
      expect(res.body?.error.code).toBe('ROOM_MEMBERSHIP_CONFLICT');
    },
  );

  it('refuses to join a room while sitting in a game that is in progress', async () => {
    const [host, other] = [await newUser('host'), await newUser('other')];
    const first = (await create(host.token)).body!;
    await app.db.update(gameRooms).set({ status: 'in_progress' }).where(eq(gameRooms.id, first.id));
    const { inviteCode } = (await create(other.token)).body!;

    const res = await join(host.token, inviteCode);

    expect(res.status).toBe(409);
    expect(res.body?.error.code).toBe('ROOM_MEMBERSHIP_CONFLICT');
  });

  it('does not count a finished game', async () => {
    const host = await newUser('host');
    const first = (await create(host.token)).body!;
    await app.db.update(gameRooms).set({ status: 'finished' }).where(eq(gameRooms.id, first.id));

    expect((await create(host.token)).status).toBe(201);
  });

  it('allows a new room after leaving the previous one', async () => {
    const host = await newUser('host');
    const first = (await create(host.token)).body!;
    await api(app.url, `/api/v1/lobbies/${first.id}/leave`, { token: host.token });

    expect((await create(host.token)).status).toBe(201);
  });

  it('lets two simultaneous creates through only once', async () => {
    const host = await newUser('host');

    const results = await Promise.all([create(host.token), create(host.token)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('GET /lobbies/current', () => {
  const current = (token: string) =>
    api(app.url, '/api/v1/lobbies/current', { method: 'GET', token, origin: null });

  it('requires authentication', async () => {
    const res = await api(app.url, '/api/v1/lobbies/current', { method: 'GET', origin: null });
    expect(res.status).toBe(401);
  });

  it('returns the room the player sits in, so a page refresh can find it again', async () => {
    const host = await newUser('host');
    const created = (await create(host.token)).body!;

    const res = await current(host.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
  });

  it('also finds a game that is in progress', async () => {
    const host = await newUser('host');
    const created = (await create(host.token)).body!;
    await app.db
      .update(gameRooms)
      .set({ status: 'in_progress' })
      .where(eq(gameRooms.id, created.id));

    expect((await current(host.token)).body?.status).toBe('in_progress');
  });

  it.each(['finished'] as const)('answers 404 when the only room is %s', async (status) => {
    const host = await newUser('host');
    const created = (await create(host.token)).body!;
    await app.db.update(gameRooms).set({ status }).where(eq(gameRooms.id, created.id));

    const res = await current(host.token);
    expect(res.status).toBe(404);
    expect(res.body?.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('answers 404 to a player without a room', async () => {
    const host = await newUser('host');
    expect((await current(host.token)).status).toBe(404);
  });
});
