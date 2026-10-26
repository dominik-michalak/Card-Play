import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { refreshTokens } from '../../db/schema';

export async function insertRefreshToken(
  db: Db,
  values: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.insert(refreshTokens).values(values);
}

// single atomic UPDATE: of two concurrent requests with the same token only one wins
export async function revokeActiveToken(db: Db, tokenHash: string): Promise<string | undefined> {
  const [row] = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: refreshTokens.userId });
  return row?.userId;
}

export async function findRefreshToken(db: Db, tokenHash: string) {
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
  return row;
}

export async function revokeAllForUser(db: Db, userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
