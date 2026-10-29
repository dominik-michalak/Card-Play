import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userAchievements, userRatings } from '../../../server/src/db/schema';
import { api, startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedGameRecord } from '../../helpers/games';
import { seedUser, tokenFor } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDb(app.db));

async function newUser(name: string) {
  const user = await seedUser(app.db, name);
  return { ...user, token: tokenFor(app.config, user.id) };
}

const get = (path: string, token?: string) =>
  api(app.url, `/api/v1${path}`, { method: 'GET', token, origin: null });

describe('GET /users/:ref/profile', () => {
  it('requires authentication', async () => {
    const alice = await newUser('alice');
    expect((await get(`/users/${alice.id}/profile`)).status).toBe(401);
  });

  it('finds a user by id, by username in any case, and as "me"', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];

    const byId = await get(`/users/${alice.id}/profile`, bob.token);
    const byName = await get('/users/ALICE/profile', bob.token);
    const mine = await get('/users/me/profile', alice.token);

    for (const res of [byId, byName, mine]) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: alice.id, username: 'alice' });
    }
  });

  it('answers 404 for an unknown user', async () => {
    const bob = await newUser('bob');
    const res = await get('/users/nobody_here/profile', bob.token);
    expect(res.status).toBe(404);
    expect(res.body?.error.code).toBe('NOT_FOUND');
  });

  it('never exposes the e-mail, the role or anything secret', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    const text = JSON.stringify((await get(`/users/${alice.id}/profile`, bob.token)).body);
    for (const secret of ['email', 'example.com', 'role', 'password', 'hash']) {
      expect(text.toLowerCase()).not.toContain(secret);
    }
  });

  it('counts wins, losses and draws per game and in total', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    const pair = [alice.id, bob.id];
    await seedGameRecord(app.db, { humans: pair, winner: alice.id });
    await seedGameRecord(app.db, { humans: pair, winner: alice.id, mode: 'competitive' });
    await seedGameRecord(app.db, { humans: pair, winner: bob.id });
    await seedGameRecord(app.db, { humans: pair, winner: null, reason: 'draw' });
    await seedGameRecord(app.db, { humans: pair, winner: alice.id, gameType: 'macao' });

    const { body } = await get(`/users/${alice.id}/profile`, bob.token);

    expect(body?.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gameType: 'war',
          played: 4,
          wins: 2,
          losses: 1,
          draws: 1,
          winRate: 50,
        }),
        expect.objectContaining({
          gameType: 'macao',
          played: 1,
          wins: 1,
          losses: 0,
          draws: 0,
          winRate: 100,
        }),
      ]),
    );
    expect(body?.totals).toEqual({ played: 5, wins: 3, losses: 1, draws: 1, winRate: 60 });
  });

  it('ignores cancelled games, bot games and games that are still running', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await seedGameRecord(app.db, { humans: [alice.id, bob.id], reason: 'cancelled' });
    await seedGameRecord(app.db, { humans: [alice.id], bots: 1, mode: 'bot', winner: alice.id });
    await seedGameRecord(app.db, { humans: [alice.id, bob.id], finishedAt: null });

    const { body } = await get(`/users/${alice.id}/profile`, bob.token);

    expect(body?.totals).toEqual({ played: 0, wins: 0, losses: 0, draws: 0, winRate: 0 });
    expect(body?.games).toEqual([]);
  });

  it('counts a multiplayer game as a win for the winner and a loss for the others', async () => {
    const [alice, bob, carol] = [
      await newUser('alice'),
      await newUser('bob'),
      await newUser('carol'),
    ];
    await seedGameRecord(app.db, {
      gameType: 'macao',
      humans: [alice.id, bob.id, carol.id],
      winner: bob.id,
      reason: 'completed',
    });

    const asAlice = (await get(`/users/${alice.id}/profile`, bob.token)).body;
    const asBob = (await get(`/users/${bob.id}/profile`, bob.token)).body;

    expect(asAlice?.totals).toMatchObject({ played: 1, wins: 0, losses: 1 });
    expect(asBob?.totals).toMatchObject({ played: 1, wins: 1, losses: 0 });
  });

  it('shows the Elo of each game', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await app.db.insert(userRatings).values([
      { userId: alice.id, gameType: 'war', elo: 1234, gamesPlayed: 3 },
      { userId: alice.id, gameType: 'macao', elo: 880, gamesPlayed: 1 },
    ]);

    const { body } = await get(`/users/${alice.id}/profile`, bob.token);

    expect(body?.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gameType: 'war', elo: 1234 }),
        expect.objectContaining({ gameType: 'macao', elo: 880 }),
      ]),
    );
  });
});

describe('achievements in the profile', () => {
  it('lists the unlocked achievements, oldest first', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await app.db.insert(userAchievements).values([
      { userId: alice.id, achievementId: 'streak_5', unlockedAt: new Date('2026-03-01T10:00:00Z') },
      {
        userId: alice.id,
        achievementId: 'first_win',
        unlockedAt: new Date('2026-01-01T10:00:00Z'),
      },
      { userId: bob.id, achievementId: 'first_win' },
    ]);

    const { body } = await get(`/users/${alice.id}/profile`, bob.token);

    expect(body?.achievements).toEqual([
      { id: 'first_win', unlockedAt: '2026-01-01T10:00:00.000Z' },
      { id: 'streak_5', unlockedAt: '2026-03-01T10:00:00.000Z' },
    ]);
  });

  it('is an empty list for a player with none', async () => {
    const alice = await newUser('alice');
    expect((await get('/users/me/profile', alice.token)).body?.achievements).toEqual([]);
  });
});

describe('GET /users/:ref/games', () => {
  it('lists finished games, the newest first, with opponents and the Elo change', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    const old = new Date('2026-01-01T10:00:00Z');
    const recent = new Date('2026-02-01T10:00:00Z');
    await seedGameRecord(app.db, { humans: [alice.id, bob.id], winner: bob.id, finishedAt: old });
    await seedGameRecord(app.db, {
      humans: [alice.id, bob.id],
      winner: alice.id,
      mode: 'competitive',
      finishedAt: recent,
      eloChange: { [alice.id]: 16, [bob.id]: -16 },
    });

    const { body } = await get(`/users/${alice.id}/games`, bob.token);

    expect(body?.total).toBe(2);
    expect(body?.items.map((g: { finishedAt: string }) => g.finishedAt)).toEqual([
      recent.toISOString(),
      old.toISOString(),
    ]);
    expect(body?.items[0]).toMatchObject({
      gameType: 'war',
      mode: 'competitive',
      result: 'win',
      terminationReason: 'all_cards',
      eloChange: 16,
      opponents: [{ userId: bob.id, username: 'bob' }],
    });
    expect(body?.items[1]).toMatchObject({ result: 'loss', eloChange: null });
  });

  it('shows a bot as an opponent, a draw as a draw and a cancelled game as cancelled', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    const t = (n: number) => new Date(Date.UTC(2026, 0, n));
    await seedGameRecord(app.db, {
      humans: [alice.id],
      bots: 1,
      mode: 'bot',
      winner: alice.id,
      finishedAt: t(3),
    });
    await seedGameRecord(app.db, { humans: [alice.id, bob.id], reason: 'draw', finishedAt: t(2) });
    await seedGameRecord(app.db, {
      humans: [alice.id, bob.id],
      reason: 'cancelled',
      finishedAt: t(1),
    });

    const { body } = await get(`/users/${alice.id}/games`, bob.token);

    expect(body?.items.map((g: { result: string }) => g.result)).toEqual([
      'win',
      'draw',
      'cancelled',
    ]);
    expect(body?.items[0].opponents).toEqual([{ userId: null, username: 'Bot' }]);
  });

  it('leaves out games that have not finished', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    await seedGameRecord(app.db, { humans: [alice.id, bob.id], finishedAt: null });
    expect((await get(`/users/${alice.id}/games`, bob.token)).body?.total).toBe(0);
  });

  it('pages with 20 games by default and at most 100', async () => {
    const [alice, bob] = [await newUser('alice'), await newUser('bob')];
    for (let i = 0; i < 25; i++) {
      await seedGameRecord(app.db, {
        humans: [alice.id, bob.id],
        winner: alice.id,
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }

    const first = (await get(`/users/${alice.id}/games`, bob.token)).body;
    expect(first?.items).toHaveLength(20);
    expect(first?.total).toBe(25);

    const rest = (await get(`/users/${alice.id}/games?limit=20&offset=20`, bob.token)).body;
    expect(rest?.items).toHaveLength(5);

    const one = (await get(`/users/${alice.id}/games?limit=1&offset=3`, bob.token)).body;
    expect(one?.items[0].finishedAt).toBe(first?.items[3].finishedAt);

    const res = await get(`/users/${alice.id}/games?limit=101`, bob.token);
    expect(res.status).toBe(400);
    expect(res.body?.error.code).toBe('INVALID_PAYLOAD');
    expect((await get(`/users/${alice.id}/games?offset=-1`, bob.token)).status).toBe(400);
    expect((await get(`/users/${alice.id}/games?limit=100`, bob.token)).status).toBe(200);
  });
});

describe('GET /leaderboard/:gameType', () => {
  it('ranks players by Elo in that game', async () => {
    const [a, b, c] = [await newUser('alice'), await newUser('bob'), await newUser('carol')];
    await app.db.insert(userRatings).values([
      { userId: a.id, gameType: 'war', elo: 1100, gamesPlayed: 4 },
      { userId: b.id, gameType: 'war', elo: 1300, gamesPlayed: 9 },
      { userId: c.id, gameType: 'macao', elo: 1500, gamesPlayed: 2 },
    ]);

    const { body } = await get('/leaderboard/war', a.token);

    expect(body?.total).toBe(2);
    expect(body?.items).toEqual([
      { rank: 1, userId: b.id, username: 'bob', elo: 1300, gamesPlayed: 9 },
      { rank: 2, userId: a.id, username: 'alice', elo: 1100, gamesPlayed: 4 },
    ]);
  });

  it('leaves out players who have not finished a game, and pages', async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await newUser(`player_${i}`));
    await app.db.insert(userRatings).values([
      ...users.slice(0, 3).map((u, i) => ({
        userId: u.id,
        gameType: 'war' as const,
        elo: 1000 + i,
        gamesPlayed: 1,
      })),
      { userId: users[3]!.id, gameType: 'war', elo: 2000, gamesPlayed: 0 },
    ]);

    const page = (await get('/leaderboard/war?limit=2&offset=1', users[0]!.token)).body;

    expect(page?.total).toBe(3);
    expect(page?.items.map((i: { rank: number }) => i.rank)).toEqual([2, 3]);
  });

  it('requires authentication and a known game', async () => {
    const a = await newUser('alice');
    expect((await get('/leaderboard/war')).status).toBe(401);
    expect((await get('/leaderboard/chess', a.token)).status).toBe(400);
    expect((await get('/leaderboard/war?limit=0', a.token)).status).toBe(400);
  });
});
