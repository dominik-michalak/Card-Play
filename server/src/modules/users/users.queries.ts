import type { UserRole } from '@cardplay/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { users } from '../../db/schema';

export type UserRow = typeof users.$inferSelect;
export type PublicUser = { id: string; username: string; email: string; role: UserRole };

export function toPublicUser(user: UserRow): PublicUser {
  return { id: user.id, username: user.username, email: user.email, role: user.role };
}

export async function insertUser(
  db: Db,
  values: { username: string; email: string; passwordHash: string },
): Promise<UserRow> {
  const [user] = await db.insert(users).values(values).returning();
  return user!;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  return user;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}
