export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MAX = 4000;

// what the ticket endpoints return (dates are ISO strings in JSON)
export type TicketSummary = {
  id: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  // only in the staff view
  author?: { id: string; username: string };
};

export type TicketReply = {
  id: string;
  isStaff: boolean;
  // the author sees "Obsługa" for staff answers; the staff sees the user name
  authorName: string;
  body: string;
  createdAt: string;
};

export type TicketDetail = TicketSummary & { body: string; replies: TicketReply[] };
