import { sql } from 'drizzle-orm';
import { createDb } from '../../server/src/db/client';

export function openTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; global setup did not run');
  }
  return createDb(url);
}

export async function resetDb(db: ReturnType<typeof openTestDb>['db']): Promise<void> {
  await db.execute(
    sql`truncate table game_record_players, game_records, room_players, game_rooms,
        friendships, ticket_replies, tickets, user_achievements, refresh_tokens, user_ratings, users restart identity cascade`,
  );
}

// drizzle wraps driver errors; the Postgres SQLSTATE sits on `cause`
export async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

export const PG = {
  invalidText: '22P02',
  foreignKey: '23503',
  unique: '23505',
  check: '23514',
} as const;
