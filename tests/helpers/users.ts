import { users } from '../../server/src/db/schema';
import { signAccessToken } from '../../server/src/modules/auth/tokens';
import type { openTestDb } from './db';
import type { Config } from '../../server/src/config';

type TestDb = ReturnType<typeof openTestDb>['db'];

export async function seedUser(db: TestDb, username: string) {
  const [user] = await db
    .insert(users)
    .values({ username, email: `${username}@example.com`, passwordHash: 'x' })
    .returning();
  return user!;
}

export const tokenFor = (config: Config, userId: string) =>
  signAccessToken({ userId, role: 'user' }, config.jwtSecret, 60);
