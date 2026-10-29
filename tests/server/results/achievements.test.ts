import type {
  AchievementId,
  GameFacts,
  GameKey,
  GameMode,
  GamePlayer,
  GameResult,
  GameState,
  TerminationReason,
} from '@cardplay/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  gameRecordPlayers,
  gameRooms,
  roomPlayers,
  userAchievements,
} from '../../../server/src/db/schema';
import { createResultsService } from '../../../server/src/modules/results/results.service';
import { startTestApp } from '../../helpers/app';
import { resetDb } from '../../helpers/db';
import { seedUser } from '../../helpers/users';

let app: Awaited<ReturnType<typeof startTestApp>>;
let results: ReturnType<typeof createResultsService>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb(app.db);
  results = createResultsService(app.db);
});

type User = { id: string; username: string };
const two = async () =>
  [await seedUser(app.db, 'player_a'), await seedUser(app.db, 'player_b')] as const;

type Play = {
  users: readonly User[];
  winner?: User | null;
  mode?: GameMode;
  gameType?: GameKey;
  reason?: TerminationReason;
  facts?: GameFacts;
  bots?: number;
};

// one whole game through the results service, as the runner would do it
async function play(options: Play) {
  const { users, mode = 'private', gameType = 'war', reason = 'all_cards', bots = 0 } = options;
  const [room] = await app.db
    .insert(gameRooms)
    .values({ gameType, mode, targetPlayers: users.length + bots, createdBy: users[0]!.id })
    .returning();
  await app.db
    .insert(roomPlayers)
    .values(users.map((u, seatIndex) => ({ roomId: room!.id, userId: u.id, seatIndex })));
  const gamePlayers: GamePlayer[] = [
    ...users.map((u) => ({ id: u.id, username: u.username, isBot: false })),
    ...Array.from({ length: bots }, (_, i) => ({ id: `bot-${i}`, username: 'Bot', isBot: true })),
  ];
  const state: GameState = { gameKey: gameType, players: gamePlayers, currentPlayerId: null };
  const recordId = await results.startGame(room!.id, state);
  const winner = options.winner === undefined ? users[0]! : options.winner;
  const result: GameResult = {
    terminationReason: reason,
    placements: gamePlayers.map((p) => ({
      playerId: p.id,
      rank: winner === null || winner.id === p.id ? 1 : 2,
    })),
  };
  return results.finishGame(recordId, result, state, options.facts);
}

const unlockedBy = (outcome: Awaited<ReturnType<typeof play>>, user: User): AchievementId[] =>
  outcome.achievements.filter((a) => a.userId === user.id).map((a) => a.achievementId);

describe('first_win', () => {
  it('goes to the winner of a game against a human, in any mode', async () => {
    const [a, b] = await two();
    const outcome = await play({ users: [a, b], winner: a, mode: 'private' });

    expect(unlockedBy(outcome, a)).toEqual(['first_win']);
    expect(unlockedBy(outcome, b)).toEqual([]);
    const [row] = await app.db
      .select()
      .from(userAchievements)
      .where(eq(userAchievements.userId, a.id));
    expect(row).toMatchObject({ achievementId: 'first_win' });
    expect(outcome.achievements[0]).toEqual({
      userId: a.id,
      achievementId: 'first_win',
      unlockedAt: expect.any(Date),
    });
  });

  it('is unlocked once only', async () => {
    const [a, b] = await two();
    await play({ users: [a, b], winner: a });
    const second = await play({ users: [a, b], winner: a });
    expect(second.achievements).toEqual([]);
    expect(await app.db.select().from(userAchievements)).toHaveLength(1);
  });

  it.each([
    ['a draw', { winner: null, reason: 'draw' as const }],
    ['a cancelled game', { winner: null, reason: 'cancelled' as const }],
  ])('is not earned in %s', async (_name, extra) => {
    const [a, b] = await two();
    expect((await play({ users: [a, b], ...extra })).achievements).toEqual([]);
  });

  it('is not earned against a bot', async () => {
    const a = await seedUser(app.db, 'player_a');
    const outcome = await play({ users: [a], bots: 1, mode: 'bot', winner: a });
    expect(outcome.achievements).toEqual([]);
  });

  it('is earned in a win over several humans', async () => {
    const users = [
      await seedUser(app.db, 'player_a'),
      await seedUser(app.db, 'player_b'),
      await seedUser(app.db, 'player_c'),
    ];
    const outcome = await play({ users, winner: users[2], gameType: 'macao', reason: 'completed' });
    expect(unlockedBy(outcome, users[2]!)).toEqual(['first_win']);
  });
});

describe('achievements from the facts of a game', () => {
  it.each([
    ['war', 'war_chain_3', { warChain3: true }],
    ['macao', 'macao_clean_finish', { macaoCleanFinish: true }],
    ['macao', 'macao_comeback', { macaoComeback: true }],
    ['poker', 'poker_all_in_win', { pokerAllInWin: true }],
    ['poker', 'poker_eliminator', { pokerEliminator: true }],
  ] as const)('unlocks %s %s only for the player the fact names', async (gameType, id, fact) => {
    const [a, b] = await two();
    // the loser can have a fact too: winning a war pool or an all-in pot does not need the match
    const outcome = await play({
      users: [a, b],
      gameType,
      winner: a,
      facts: { [a.id]: { ...fact }, [b.id]: {} },
    });
    expect(unlockedBy(outcome, a)).toEqual(expect.arrayContaining([id]));
    expect(unlockedBy(outcome, b)).toEqual([]);
  });

  it('lets the loser of a game earn a fact-based achievement', async () => {
    const [a, b] = await two();
    const outcome = await play({
      users: [a, b],
      winner: a,
      facts: { [b.id]: { warChain3: true } },
    });
    expect(unlockedBy(outcome, b)).toEqual(['war_chain_3']);
  });

  it('ignores facts of a game against a bot or a cancelled game', async () => {
    const a = await seedUser(app.db, 'player_a');
    const botGame = await play({
      users: [a],
      bots: 1,
      mode: 'bot',
      facts: { [a.id]: { warChain3: true } },
    });
    expect(botGame.achievements).toEqual([]);

    const [b, c] = [await seedUser(app.db, 'player_b'), await seedUser(app.db, 'player_c')];
    const cancelled = await play({
      users: [b, c],
      winner: null,
      reason: 'cancelled',
      facts: { [b.id]: { warChain3: true } },
    });
    expect(cancelled.achievements).toEqual([]);
  });

  it('stores who forfeited', async () => {
    const [a, b] = await two();
    const outcome = await play({
      users: [a, b],
      winner: a,
      reason: 'timeout_forfeit',
      facts: { [b.id]: { forfeited: true } },
    });
    const rows = await app.db
      .select()
      .from(gameRecordPlayers)
      .where(eq(gameRecordPlayers.recordId, outcome.recordId));
    expect(rows.find((r) => r.userId === b.id)?.forfeited).toBe(true);
    expect(rows.find((r) => r.userId === a.id)?.forfeited).toBe(false);
  });
});

describe('fair_play_10', () => {
  it('comes with the tenth game against humans that the player did not forfeit', async () => {
    const [a, b] = await two();
    for (let i = 0; i < 9; i++) {
      const outcome = await play({ users: [a, b], winner: i % 2 === 0 ? a : b });
      expect(unlockedBy(outcome, a)).not.toContain('fair_play_10');
    }
    const tenth = await play({ users: [a, b], winner: a });
    expect(unlockedBy(tenth, a)).toContain('fair_play_10');
    expect(unlockedBy(tenth, b)).toContain('fair_play_10');
  });

  it('does not count forfeits, cancelled games or games against a bot', async () => {
    const [a, b] = await two();
    // b is the clean player in eight games that a lost by forfeit
    for (let i = 0; i < 8; i++) {
      await play({
        users: [a, b],
        winner: b,
        reason: 'timeout_forfeit',
        facts: { [a.id]: { forfeited: true } },
      });
    }
    // none of these may count towards b's ten
    for (let i = 0; i < 3; i++) await play({ users: [a, b], winner: null, reason: 'cancelled' });
    for (let i = 0; i < 3; i++) await play({ users: [b], bots: 1, mode: 'bot' });

    const ninth = await play({ users: [a, b], winner: b });
    expect(unlockedBy(ninth, b)).not.toContain('fair_play_10');
    expect(unlockedBy(ninth, a)).not.toContain('fair_play_10');

    const tenth = await play({ users: [a, b], winner: b });
    expect(unlockedBy(tenth, b)).toContain('fair_play_10');
    // a forfeited eight of its ten games, so it is nowhere near
    expect(unlockedBy(tenth, a)).not.toContain('fair_play_10');
  });
});

describe('streak_5', () => {
  const ranked = (users: readonly User[], winner: User | null, gameType: GameKey = 'war') =>
    play({
      users,
      winner,
      mode: 'competitive',
      gameType,
      reason: winner ? 'all_cards' : 'draw',
    });

  it('comes with the fifth ranked win in a row in one game', async () => {
    const [a, b] = await two();
    for (let i = 0; i < 4; i++) {
      expect(unlockedBy(await ranked([a, b], a), a)).not.toContain('streak_5');
    }
    expect(unlockedBy(await ranked([a, b], a), a)).toContain('streak_5');
  });

  it('is broken by a loss or a draw', async () => {
    const [a, b] = await two();
    for (let i = 0; i < 4; i++) await ranked([a, b], a);
    await ranked([a, b], null);
    expect(unlockedBy(await ranked([a, b], a), a)).not.toContain('streak_5');
  });

  it('ignores games of another kind and unrated games in between', async () => {
    const [a, b] = await two();
    for (let i = 0; i < 4; i++) await ranked([a, b], a);
    await ranked([a, b], b, 'macao');
    await play({ users: [a, b], winner: b, mode: 'unrated' });
    expect(unlockedBy(await ranked([a, b], a), a)).toContain('streak_5');
  });

  it('is not earned in unrated games', async () => {
    const [a, b] = await two();
    for (let i = 0; i < 6; i++) {
      expect(
        unlockedBy(await play({ users: [a, b], winner: a, mode: 'unrated' }), a),
      ).not.toContain('streak_5');
    }
  });
});

describe('idempotence', () => {
  it('records an achievement once even when two games finish at the same moment', async () => {
    const [a, b] = await two();
    const [c, d] = [await seedUser(app.db, 'player_c'), await seedUser(app.db, 'player_d')];
    // a wins two games in parallel (against different opponents, in different rooms)
    const outcomes = await Promise.all([
      play({ users: [a, b], winner: a }),
      play({ users: [a, c], winner: a }),
    ]);
    void d;

    const all = outcomes.flatMap((o) => unlockedBy(o, a));
    expect(all.filter((id) => id === 'first_win')).toHaveLength(1);
    expect(
      await app.db.select().from(userAchievements).where(eq(userAchievements.userId, a.id)),
    ).toHaveLength(1);
  });
});
