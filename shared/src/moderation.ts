import type { UserRole } from './rooms';

// moderators give temporary bans; admins also give permanent ones and assign roles
export const MODERATOR_MAX_BAN_HOURS = 30 * 24;
export const ADMIN_MAX_BAN_HOURS = 365 * 24;
export const BAN_REASON_MAX = 500;

export const MODERATION_ACTIONS = [
  'ban',
  'unban',
  'role_change',
  'ticket_reply',
  'ticket_status',
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

// who outranks whom: only a higher role may ban someone
export const ROLE_RANK: Record<UserRole, number> = { user: 0, moderator: 1, admin: 2 };

export type BanState = {
  active: boolean;
  permanent: boolean;
  // ISO time a temporary ban ends
  until: string | null;
};

export type ManagedUser = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  ban: BanState;
};

export type BanRecord = {
  id: string;
  reason: string;
  permanent: boolean;
  expiresAt: string | null;
  createdAt: string;
  // user names of the staff members
  imposedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
};

export type ManagedUserDetail = ManagedUser & { bans: BanRecord[] };

export type AuditEntry = {
  id: string;
  action: ModerationAction;
  actor: { id: string; username: string } | null;
  target: { id: string; username: string } | null;
  details: Record<string, unknown>;
  createdAt: string;
};
