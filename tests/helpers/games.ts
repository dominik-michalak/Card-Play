import type { GameKey, GameMode, TerminationReason } from '@cardplay/shared';
import { gameRecordPlayers, gameRecords, gameRooms, roomPlayers } from '../../server/src/db/schema';
import type { openTestDb } from './db';

type TestDb = ReturnType<typeof openTestDb>['db'];

type Seed = {
  gameType?: GameKey;
  mode?: GameMode;
  humans: string[];
  bots?: number;
  winner?: string | null;
  reason?: TerminationReason;
  finishedAt?: Date | null;
  eloChange?: Record<string, number>;
};

// a game record as the results service leaves it, without playing the game
export async function seedGameRecord(db: TestDb, seed: Seed): Promise<string> {
  const { gameType = 'war', mode = 'private', humans, bots = 0 } = seed;
  const finishedAt = seed.finishedAt === undefined ? new Date() : seed.finishedAt;
  const reason = seed.reason ?? 'all_cards';
  const [room] = await db
    .insert(gameRooms)
    .values({
      gameType,
      mode,
      status: finishedAt ? 'finished' : 'in_progress',
      targetPlayers: Math.min(6, Math.max(2, humans.length + bots)),
      createdBy: humans[0]!,
    })
    .returning();
  await db
    .insert(roomPlayers)
    .values(humans.map((userId, seatIndex) => ({ roomId: room!.id, userId, seatIndex })));
  const [record] = await db
    .insert(gameRecords)
    .values({
      roomId: room!.id,
      gameType,
      mode,
      state: {},
      startedAt: new Date((finishedAt ?? new Date()).getTime() - 60_000),
      finishedAt,
      terminationReason: finishedAt ? reason : null,
      winnerId: seed.winner ?? null,
    })
    .returning();
  await db.insert(gameRecordPlayers).values([
    ...humans.map((userId, i) => ({
      recordId: record!.id,
      userId,
      finalRank: finishedAt && reason !== 'cancelled' ? (seed.winner === userId ? 1 : i + 2) : null,
      eloChange: seed.eloChange?.[userId] ?? null,
      eloBefore: seed.eloChange?.[userId] === undefined ? null : 1000,
    })),
    ...Array.from({ length: bots }, () => ({ recordId: record!.id, userId: null })),
  ]);
  return record!.id;
}
