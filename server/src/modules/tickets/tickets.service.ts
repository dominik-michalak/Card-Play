import type { TicketStatus } from '@cardplay/shared';
import { and, asc, count, desc, eq, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { ticketReplies, tickets, users } from '../../db/schema';
import { HttpError } from '../../http-error';

export type Page = { limit: number; offset: number };

export type TicketSummaryDto = {
  id: string;
  subject: string;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  author?: { id: string; username: string };
};
export type TicketReplyDto = {
  id: string;
  isStaff: boolean;
  authorName: string;
  body: string;
  createdAt: Date;
};
export type TicketDetailDto = TicketSummaryDto & { body: string; replies: TicketReplyDto[] };

const STAFF_NAME = 'Obsługa';

const notFound = () => new HttpError(404, 'NOT_FOUND', 'ticket not found');

export function createTicketsService(db: Db) {
  async function detail(ticketId: string, forStaff: boolean): Promise<TicketDetailDto | null> {
    const [row] = await db
      .select({
        id: tickets.id,
        subject: tickets.subject,
        body: tickets.body,
        status: tickets.status,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        authorId: tickets.authorId,
        authorName: users.username,
      })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.authorId))
      .where(eq(tickets.id, ticketId));
    if (!row) return null;
    const replies = await db
      .select({
        id: ticketReplies.id,
        isStaff: ticketReplies.isStaff,
        body: ticketReplies.body,
        createdAt: ticketReplies.createdAt,
        username: users.username,
      })
      .from(ticketReplies)
      .innerJoin(users, eq(users.id, ticketReplies.authorId))
      .where(eq(ticketReplies.ticketId, ticketId))
      .orderBy(asc(ticketReplies.createdAt), asc(ticketReplies.id));
    return {
      id: row.id,
      subject: row.subject,
      body: row.body,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(forStaff && { author: { id: row.authorId, username: row.authorName } }),
      replies: replies.map((r) => ({
        id: r.id,
        isStaff: r.isStaff,
        // the author never learns which member of the staff answered
        authorName: r.isStaff && !forStaff ? STAFF_NAME : r.username,
        body: r.body,
        createdAt: r.createdAt,
      })),
    };
  }

  async function page(
    where: SQL | undefined,
    { limit, offset }: Page,
    forStaff: boolean,
  ): Promise<{ total: number; items: TicketSummaryDto[] }> {
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(tickets)
      .where(where);
    const rows = await db
      .select({
        id: tickets.id,
        subject: tickets.subject,
        status: tickets.status,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        authorId: tickets.authorId,
        authorName: users.username,
      })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.authorId))
      .where(where)
      .orderBy(desc(tickets.updatedAt), desc(tickets.id))
      .limit(limit)
      .offset(offset);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ...(forStaff && { author: { id: r.authorId, username: r.authorName } }),
      })),
    };
  }

  async function create(
    authorId: string,
    input: { subject: string; body: string },
  ): Promise<TicketDetailDto> {
    const [created] = await db
      .insert(tickets)
      .values({ authorId, ...input })
      .returning({ id: tickets.id });
    return (await detail(created!.id, false))!;
  }

  // another user's ticket looks exactly like one that does not exist
  async function getOwn(userId: string, ticketId: string): Promise<TicketDetailDto> {
    const found = await detail(ticketId, false);
    const [owner] = found
      ? await db
          .select({ authorId: tickets.authorId })
          .from(tickets)
          .where(eq(tickets.id, ticketId))
      : [];
    if (!found || owner?.authorId !== userId) throw notFound();
    return found;
  }

  // Locks the ticket, so a reply cannot slip in while the status changes.
  async function addReply(
    ticketId: string,
    authorId: string,
    body: string,
    asStaff: boolean,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [ticket] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!ticket || (!asStaff && ticket.authorId !== authorId)) throw notFound();
      if (ticket.status === 'closed') {
        throw new HttpError(409, 'INVALID_ACTION', 'this ticket is closed');
      }
      await tx.insert(ticketReplies).values({ ticketId, authorId, body, isStaff: asStaff });
      let status = ticket.status;
      // staff takes an open ticket on; the author reopens a resolved one
      if (asStaff && status === 'open') status = 'in_progress';
      if (!asStaff && status === 'resolved') status = 'open';
      await tx
        .update(tickets)
        .set({ status, updatedAt: new Date(), ...(asStaff && { handledBy: authorId }) })
        .where(eq(tickets.id, ticketId));
    });
  }

  async function setStatus(staffId: string, ticketId: string, status: TicketStatus): Promise<void> {
    const updated = await db
      .update(tickets)
      .set({ status, updatedAt: new Date(), handledBy: staffId })
      .where(eq(tickets.id, ticketId))
      .returning({ id: tickets.id });
    if (updated.length === 0) throw notFound();
  }

  return {
    create,
    listOwn: (userId: string, paging: Page) => page(eq(tickets.authorId, userId), paging, false),
    getOwn,
    reply: (userId: string, ticketId: string, body: string) =>
      addReply(ticketId, userId, body, false),

    listAll: (status: TicketStatus | undefined, paging: Page) =>
      page(status ? and(eq(tickets.status, status)) : undefined, paging, true),
    getAny: async (ticketId: string) =>
      (await detail(ticketId, true)) ?? Promise.reject(notFound()),
    staffReply: (staffId: string, ticketId: string, body: string) =>
      addReply(ticketId, staffId, body, true),
    setStatus,
  };
}

export type TicketsService = ReturnType<typeof createTicketsService>;
