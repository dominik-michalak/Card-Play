import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { friendships, users } from '../../db/schema';
import { HttpError } from '../../http-error';
import type { Presence } from '../../realtime/presence';

export type FriendEntry = { userId: string; username: string; online: boolean };
export type PendingEntry = { userId: string; username: string; since: Date };
export type FriendList = {
  friends: FriendEntry[];
  // invitations the caller can accept or decline
  incoming: PendingEntry[];
  // invitations the caller has sent
  outgoing: PendingEntry[];
};

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === UNIQUE_VIOLATION;
}

const either = (a: string, b: string) =>
  or(
    and(eq(friendships.requesterId, a), eq(friendships.addresseeId, b)),
    and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a)),
  );

const notFound = (message: string) => new HttpError(404, 'NOT_FOUND', message);
const conflict = (message: string) => new HttpError(409, 'INVALID_ACTION', message);

export function createFriendsService(db: Db, presence: Presence) {
  async function list(userId: string): Promise<FriendList> {
    const rows = await db
      .select({
        requesterId: friendships.requesterId,
        addresseeId: friendships.addresseeId,
        status: friendships.status,
        createdAt: friendships.createdAt,
      })
      .from(friendships)
      .where(or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)));
    const otherId = (row: (typeof rows)[number]) =>
      row.requesterId === userId ? row.addresseeId : row.requesterId;
    const others = rows.map(otherId);
    const named =
      others.length === 0
        ? []
        : await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, others));
    const names = new Map(named.map((u) => [u.id, u.username]));
    const entry = (row: (typeof rows)[number]) => ({
      userId: otherId(row),
      username: names.get(otherId(row)) ?? '',
    });

    const byName = <T extends { username: string }>(a: T, b: T) =>
      a.username.localeCompare(b.username);
    return {
      friends: rows
        .filter((r) => r.status === 'accepted')
        .map((r) => ({ ...entry(r), online: presence.isOnline(otherId(r)) }))
        .sort(byName),
      incoming: rows
        .filter((r) => r.status === 'pending' && r.addresseeId === userId)
        .map((r) => ({ ...entry(r), since: r.createdAt }))
        .sort(byName),
      outgoing: rows
        .filter((r) => r.status === 'pending' && r.requesterId === userId)
        .map((r) => ({ ...entry(r), since: r.createdAt }))
        .sort(byName),
    };
  }

  // An invitation to someone who already invited the caller is an acceptance.
  async function invite(
    userId: string,
    username: string,
  ): Promise<{ status: 'pending' | 'accepted'; user: { id: string; username: string } }> {
    const [target] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`);
    if (!target) throw notFound('user not found');
    if (target.id === userId)
      throw new HttpError(400, 'INVALID_PAYLOAD', 'you cannot invite yourself');

    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(friendships).where(either(userId, target.id));
      if (existing?.status === 'accepted') throw conflict('you are already friends');
      if (existing?.requesterId === userId) throw conflict('you have already invited this player');
      if (existing) {
        await tx
          .update(friendships)
          .set({ status: 'accepted', respondedAt: new Date() })
          .where(eq(friendships.id, existing.id));
        return { status: 'accepted' as const, user: target };
      }
      try {
        await tx.insert(friendships).values({ requesterId: userId, addresseeId: target.id });
      } catch (error) {
        // two invitations at the same moment: the pair index lets only one through
        if (isUniqueViolation(error)) throw conflict('an invitation already exists');
        throw error;
      }
      return { status: 'pending' as const, user: target };
    });
  }

  async function accept(userId: string, otherId: string): Promise<void> {
    const updated = await db
      .update(friendships)
      .set({ status: 'accepted', respondedAt: new Date() })
      .where(
        and(
          eq(friendships.requesterId, otherId),
          eq(friendships.addresseeId, userId),
          eq(friendships.status, 'pending'),
        ),
      )
      .returning({ id: friendships.id });
    if (updated.length === 0) throw notFound('no invitation from this player');
  }

  // declines an invitation to the caller or withdraws one the caller sent
  async function decline(userId: string, otherId: string): Promise<void> {
    const deleted = await db
      .delete(friendships)
      .where(and(either(userId, otherId), eq(friendships.status, 'pending')))
      .returning({ id: friendships.id });
    if (deleted.length === 0) throw notFound('no pending invitation with this player');
  }

  async function remove(userId: string, otherId: string): Promise<void> {
    const deleted = await db
      .delete(friendships)
      .where(and(either(userId, otherId), eq(friendships.status, 'accepted')))
      .returning({ id: friendships.id });
    if (deleted.length === 0) throw notFound('this player is not your friend');
  }

  async function areFriends(a: string, b: string): Promise<boolean> {
    const [row] = await db
      .select({ id: friendships.id })
      .from(friendships)
      .where(and(either(a, b), eq(friendships.status, 'accepted')));
    return row !== undefined;
  }

  return { list, invite, accept, decline, remove, areFriends };
}

export type FriendsService = ReturnType<typeof createFriendsService>;
