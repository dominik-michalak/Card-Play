import {
  ADMIN_MAX_BAN_HOURS,
  MODERATOR_MAX_BAN_HOURS,
  ROLE_RANK,
  type AuditEntry,
  type BanRecord,
  type ManagedUser,
  type ManagedUserDetail,
  type ModerationAction,
  type UserRole,
} from '@cardplay/shared';
import { aliasedTable, and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { bans, moderationActions, refreshTokens, users } from '../../db/schema';
import { HttpError } from '../../http-error';
import { banState } from './bans';
import type { BanEvents } from './ban-events';

export type Actor = { id: string; role: UserRole };
export type Page = { limit: number; offset: number };
export type BanInput = { durationHours?: number; permanent?: true; reason: string };

type UserRow = typeof users.$inferSelect;

const forbidden = (message: string) => new HttpError(403, 'FORBIDDEN', message);
const notFound = () => new HttpError(404, 'NOT_FOUND', 'user not found');

const toManaged = (user: UserRow): ManagedUser => ({
  id: user.id,
  username: user.username,
  role: user.role,
  createdAt: user.createdAt.toISOString(),
  ban: banState(user),
});

export function createModerationService(db: Db, banEvents: BanEvents) {
  async function record(
    actorId: string,
    action: ModerationAction,
    targetUserId: string | null,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await db.insert(moderationActions).values({ actorId, action, targetUserId, details });
  }

  async function find(userId: string): Promise<UserRow> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound();
    return user;
  }

  async function listUsers(
    filter: { search?: string; banned?: boolean },
    { limit, offset }: Page,
  ): Promise<{ total: number; items: ManagedUser[] }> {
    // % and _ in the search text are ordinary characters, not wildcards
    const escaped = filter.search?.replace(/[\\%_]/g, (c) => `\\${c}`);
    const where = and(
      escaped === undefined
        ? undefined
        : sql`lower(${users.username}) like ${`%${escaped.toLowerCase()}%`} escape '\\'`,
      filter.banned ? or(eq(users.isBanned, true), gt(users.bannedUntil, new Date())) : undefined,
    );
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(users).where(where);
    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(sql`lower(${users.username})`, users.id)
      .limit(limit)
      .offset(offset);
    return { total, items: rows.map(toManaged) };
  }

  async function getUser(userId: string): Promise<ManagedUserDetail> {
    const user = await find(userId);
    const imposer = aliasedTable(users, 'imposer');
    const revoker = aliasedTable(users, 'revoker');
    const history = await db
      .select({
        id: bans.id,
        reason: bans.reason,
        permanent: bans.permanent,
        expiresAt: bans.expiresAt,
        createdAt: bans.createdAt,
        revokedAt: bans.revokedAt,
        imposedBy: imposer.username,
        revokedBy: revoker.username,
      })
      .from(bans)
      .leftJoin(imposer, eq(imposer.id, bans.imposedBy))
      .leftJoin(revoker, eq(revoker.id, bans.revokedBy))
      .where(eq(bans.userId, userId))
      .orderBy(desc(bans.createdAt));
    return {
      ...toManaged(user),
      bans: history.map((b): BanRecord => ({
        id: b.id,
        reason: b.reason,
        permanent: b.permanent,
        expiresAt: b.expiresAt?.toISOString() ?? null,
        createdAt: b.createdAt.toISOString(),
        imposedBy: b.imposedBy,
        revokedAt: b.revokedAt?.toISOString() ?? null,
        revokedBy: b.revokedBy,
      })),
    };
  }

  async function ban(actor: Actor, targetId: string, input: BanInput): Promise<ManagedUser> {
    if (actor.id === targetId) throw forbidden('you cannot ban yourself');
    if (input.permanent && actor.role !== 'admin')
      throw forbidden('only an admin can ban for good');
    const maxHours = actor.role === 'admin' ? ADMIN_MAX_BAN_HOURS : MODERATOR_MAX_BAN_HOURS;
    if (input.durationHours !== undefined && input.durationHours > maxHours) {
      throw new HttpError(400, 'INVALID_PAYLOAD', `a ban can last at most ${maxHours} hours`);
    }
    const expiresAt =
      input.durationHours === undefined
        ? null
        : new Date(Date.now() + input.durationHours * 3_600_000);

    const updated = await db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, targetId)).for('update');
      if (!target) throw notFound();
      // only a higher role may ban
      if (ROLE_RANK[actor.role] <= ROLE_RANK[target.role]) {
        throw forbidden('you cannot ban a user of your rank or above');
      }
      if (banState(target).active) {
        throw new HttpError(409, 'INVALID_ACTION', 'this user is already banned');
      }
      await tx.insert(bans).values({
        userId: targetId,
        imposedBy: actor.id,
        reason: input.reason,
        permanent: expiresAt === null,
        expiresAt,
      });
      const [row] = await tx
        .update(users)
        .set({ isBanned: expiresAt === null, bannedUntil: expiresAt })
        .where(eq(users.id, targetId))
        .returning();
      // the sessions end now, so no refresh token can bring the user back
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, targetId), isNull(refreshTokens.revokedAt)));
      await tx.insert(moderationActions).values({
        actorId: actor.id,
        action: 'ban',
        targetUserId: targetId,
        details:
          input.durationHours === undefined
            ? { reason: input.reason, permanent: true }
            : { reason: input.reason, durationHours: input.durationHours },
      });
      return row!;
    });
    banEvents.banned(targetId);
    return toManaged(updated);
  }

  async function unban(actor: Actor, targetId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, targetId)).for('update');
      if (!target) throw notFound();
      if (!banState(target).active) throw notFound();
      if (target.isBanned && actor.role !== 'admin') {
        throw forbidden('only an admin can lift a permanent ban');
      }
      await tx
        .update(bans)
        .set({ revokedAt: new Date(), revokedBy: actor.id })
        .where(and(eq(bans.userId, targetId), isNull(bans.revokedAt)));
      await tx
        .update(users)
        .set({ isBanned: false, bannedUntil: null })
        .where(eq(users.id, targetId));
      await tx
        .insert(moderationActions)
        .values({ actorId: actor.id, action: 'unban', targetUserId: targetId, details: {} });
    });
  }

  async function setRole(actor: Actor, targetId: string, role: UserRole): Promise<ManagedUser> {
    if (actor.id === targetId) throw forbidden('you cannot change your own role');
    return db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, targetId)).for('update');
      if (!target) throw notFound();
      const [row] = await tx.update(users).set({ role }).where(eq(users.id, targetId)).returning();
      await tx.insert(moderationActions).values({
        actorId: actor.id,
        action: 'role_change',
        targetUserId: targetId,
        details: { from: target.role, to: role },
      });
      return toManaged(row!);
    });
  }

  async function audit({ limit, offset }: Page): Promise<{ total: number; items: AuditEntry[] }> {
    const actor = aliasedTable(users, 'actor');
    const target = aliasedTable(users, 'target');
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(moderationActions);
    const rows = await db
      .select({
        id: moderationActions.id,
        action: moderationActions.action,
        details: moderationActions.details,
        createdAt: moderationActions.createdAt,
        actorId: moderationActions.actorId,
        actorName: actor.username,
        targetId: moderationActions.targetUserId,
        targetName: target.username,
      })
      .from(moderationActions)
      .leftJoin(actor, eq(actor.id, moderationActions.actorId))
      .leftJoin(target, eq(target.id, moderationActions.targetUserId))
      .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
      .limit(limit)
      .offset(offset);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actorId && r.actorName ? { id: r.actorId, username: r.actorName } : null,
        target: r.targetId && r.targetName ? { id: r.targetId, username: r.targetName } : null,
        details: r.details as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  return { record, listUsers, getUser, ban, unban, setRole, audit };
}

export type ModerationService = ReturnType<typeof createModerationService>;
