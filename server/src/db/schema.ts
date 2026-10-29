import {
  FRIENDSHIP_STATUSES,
  GAME_KEYS,
  GAME_MODES,
  ROOM_STATUSES,
  TERMINATION_REASONS,
  USER_ROLES,
} from '@cardplay/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const gameTypeEnum = pgEnum('game_type', GAME_KEYS);
export const gameModeEnum = pgEnum('game_mode', GAME_MODES);
export const roomStatusEnum = pgEnum('room_status', ROOM_STATUSES);
export const terminationReasonEnum = pgEnum('termination_reason', TERMINATION_REASONS);
export const friendshipStatusEnum = pgEnum('friendship_status', FRIENDSHIP_STATUSES);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull().default('user'),
    isBanned: boolean('is_banned').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // case-insensitive uniqueness stops "Admin" impersonating "admin"
    uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    check('users_username_length', sql`char_length(${t.username}) between 3 and 20`),
  ],
);

// one Elo rating per user and game; gamesPlayed counts completed games against humans, in any mode
export const userRatings = pgTable(
  'user_ratings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameType: gameTypeEnum('game_type').notNull(),
    elo: integer('elo').notNull().default(1000),
    gamesPlayed: integer('games_played').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.gameType] }),
    index('user_ratings_leaderboard_idx').on(t.gameType, t.elo.desc()),
    check('user_ratings_non_negative', sql`${t.elo} >= 0 and ${t.gamesPlayed} >= 0`),
  ],
);

// only the hash is stored, so a leaked table cannot be used to refresh sessions
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
);

export const gameRooms = pgTable(
  'game_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameType: gameTypeEnum('game_type').notNull(),
    mode: gameModeEnum('mode').notNull(),
    status: roomStatusEnum('status').notNull().default('waiting'),
    targetPlayers: integer('target_players').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    inviteCode: text('invite_code').unique(),
    createdAt: createdAt(),
  },
  (t) => [
    // per-game ranges (e.g. War = 2) are enforced by the application
    check('game_rooms_target_players', sql`${t.targetPlayers} between 2 and 6`),
  ],
);

export const roomPlayers = pgTable(
  'room_players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => gameRooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    seatIndex: integer('seat_index'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('room_players_room_user').on(t.roomId, t.userId),
    unique('room_players_room_seat').on(t.roomId, t.seatIndex),
    check('room_players_seat_index', sql`${t.seatIndex} >= 0`),
  ],
);

// created when a game starts, finished when the engine reports a terminal state
export const gameRecords = pgTable(
  'game_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => gameRooms.id),
    gameType: gameTypeEnum('game_type').notNull(),
    mode: gameModeEnum('mode').notNull(),
    state: jsonb('state').notNull(),
    terminationReason: terminationReasonEnum('termination_reason'),
    winnerId: uuid('winner_id').references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('game_records_type_mode_finished_idx').on(t.gameType, t.mode, t.finishedAt.desc()),
    check(
      'game_records_finished_consistency',
      sql`(${t.finishedAt} is null) = (${t.terminationReason} is null)`,
    ),
  ],
);

// userId is null for bots, which have no account
export const gameRecordPlayers = pgTable(
  'game_record_players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => gameRecords.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id),
    finalRank: integer('final_rank'),
    eloBefore: integer('elo_before'),
    eloChange: integer('elo_change'),
  },
  (t) => [
    index('game_record_players_user_idx').on(t.userId),
    index('game_record_players_record_idx').on(t.recordId),
    check('game_record_players_rank', sql`${t.finalRank} >= 1`),
  ],
);

// one row per pair of users, whoever invited whom; an invitation that is declined is deleted
export const friendships = pgTable(
  'friendships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: uuid('addressee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatusEnum('status').notNull().default('pending'),
    createdAt: createdAt(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => [
    // the same pair cannot appear twice, in either direction
    uniqueIndex('friendships_pair_idx').on(
      sql`least(${t.requesterId}, ${t.addresseeId})`,
      sql`greatest(${t.requesterId}, ${t.addresseeId})`,
    ),
    index('friendships_addressee_idx').on(t.addresseeId),
    check('friendships_not_self', sql`${t.requesterId} <> ${t.addresseeId}`),
  ],
);
