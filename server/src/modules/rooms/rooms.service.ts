import { GAME_PLAYER_LIMITS, type Room, type RoomStatus } from '@cardplay/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { gameRooms, roomPlayers, users } from '../../db/schema';
import { HttpError } from '../../http-error';
import { generateInviteCode, INVITE_CODE_TTL_MS } from './invite-code';
import type { CreateRoomInput } from './rooms.schemas';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;
type RoomRow = typeof gameRooms.$inferSelect;

export type LeaveResult = {
  roomId: string;
  // the last player left and the waiting room was deleted
  roomClosed: boolean;
  // set only when the leaver was the host and the role moved to someone else
  newHostId: string | null;
};

// what happened to a room, for the socket layer to broadcast
export type RoomChange = {
  roomId: string;
  kind: 'joined' | 'left' | 'seated' | 'closed';
  userId: string;
};

export type RoomsServiceOptions = {
  generateInviteCode?: () => string;
};

// a finished room frees its players; waiting and running ones keep them
const ACTIVE_STATUSES: RoomStatus[] = ['waiting', 'in_progress'];
const MAX_CODE_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === UNIQUE_VIOLATION;
}

const roomNotFound = () => new HttpError(404, 'ROOM_NOT_FOUND', 'room not found');

// every action here is shared by REST and the socket events, so the rules live in one place
export function createRoomsService(db: Db, options: RoomsServiceOptions = {}) {
  const newInviteCode = options.generateInviteCode ?? generateInviteCode;
  const listeners: ((change: RoomChange) => void)[] = [];

  // listeners run after the transaction committed, so they always see the stored state
  function notify(change: RoomChange): void {
    for (const listener of listeners) {
      listener(change);
    }
  }

  async function snapshot(exec: Executor, room: RoomRow): Promise<Room> {
    const players = await exec
      .select({
        userId: roomPlayers.userId,
        username: users.username,
        seatIndex: roomPlayers.seatIndex,
      })
      .from(roomPlayers)
      .innerJoin(users, eq(users.id, roomPlayers.userId))
      .where(eq(roomPlayers.roomId, room.id))
      .orderBy(asc(roomPlayers.seatIndex));
    return {
      id: room.id,
      gameType: room.gameType,
      mode: room.mode,
      status: room.status,
      targetPlayers: room.targetPlayers,
      createdBy: room.createdBy,
      inviteCode: room.inviteCode,
      players,
    };
  }

  async function memberIds(exec: Executor, roomId: string): Promise<string[]> {
    const rows = await exec
      .select({ userId: roomPlayers.userId })
      .from(roomPlayers)
      .where(eq(roomPlayers.roomId, roomId));
    return rows.map((r) => r.userId);
  }

  // locks the room row, so concurrent actions on one room run one after another
  async function lockRoom(tx: Tx, roomId: string): Promise<RoomRow | undefined> {
    const [room] = await tx.select().from(gameRooms).where(eq(gameRooms.id, roomId)).for('update');
    return room;
  }

  // same answer for "no such room" and "not your room", so ids cannot be probed
  async function lockMemberRoom(tx: Tx, roomId: string, userId: string): Promise<RoomRow> {
    const room = await lockRoom(tx, roomId);
    if (!room || !(await memberIds(tx, roomId)).includes(userId)) {
      throw roomNotFound();
    }
    return room;
  }

  // serialises one user's create/join calls, so two parallel requests cannot both pass the check
  async function lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  }

  // a user may sit in only one unfinished room; rejoining the same room is not a conflict
  async function requireNoOtherRoom(tx: Tx, userId: string, sameRoomId?: string): Promise<void> {
    const rooms = await tx
      .select({ id: gameRooms.id })
      .from(roomPlayers)
      .innerJoin(gameRooms, eq(gameRooms.id, roomPlayers.roomId))
      .where(and(eq(roomPlayers.userId, userId), inArray(gameRooms.status, ACTIVE_STATUSES)));
    if (rooms.some((r) => r.id !== sameRoomId)) {
      throw new HttpError(409, 'ROOM_MEMBERSHIP_CONFLICT', 'leave your current room first');
    }
  }

  function requireWaiting(room: RoomRow): void {
    if (room.status !== 'waiting') {
      throw new HttpError(409, 'INVALID_ACTION', 'the game has already started');
    }
  }

  async function createRoom(userId: string, input: CreateRoomInput): Promise<Room> {
    const targetPlayers = input.targetPlayers ?? GAME_PLAYER_LIMITS[input.gameType].min;
    // a code collision aborts the transaction, so each attempt gets a new one
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          await lockUser(tx, userId);
          await requireNoOtherRoom(tx, userId);
          const [room] = await tx
            .insert(gameRooms)
            .values({
              gameType: input.gameType,
              mode: 'private',
              targetPlayers,
              createdBy: userId,
              inviteCode: newInviteCode(),
            })
            .returning();
          await tx.insert(roomPlayers).values({ roomId: room!.id, userId, seatIndex: 0 });
          return snapshot(tx, room!);
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    throw new Error('could not generate a unique invite code');
  }

  async function joinByCode(userId: string, code: string): Promise<Room> {
    const joined = await db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const [found] = await tx
        .select({ id: gameRooms.id })
        .from(gameRooms)
        .where(eq(gameRooms.inviteCode, code));
      const room = found && (await lockRoom(tx, found.id));
      const expired = room && Date.now() - room.createdAt.getTime() > INVITE_CODE_TTL_MS;
      if (!room || room.status !== 'waiting' || expired) {
        throw roomNotFound();
      }

      const seats = await tx
        .select({ userId: roomPlayers.userId, seatIndex: roomPlayers.seatIndex })
        .from(roomPlayers)
        .where(eq(roomPlayers.roomId, room.id));
      const alreadyInside = seats.some((s) => s.userId === userId);
      await requireNoOtherRoom(tx, userId, alreadyInside ? room.id : undefined);
      if (alreadyInside) {
        return snapshot(tx, room);
      }
      if (seats.length >= room.targetPlayers) {
        throw new HttpError(409, 'ROOM_FULL', 'room is full');
      }
      const taken = new Set(seats.map((s) => s.seatIndex));
      let seatIndex = 0;
      while (taken.has(seatIndex)) {
        seatIndex++;
      }
      await tx.insert(roomPlayers).values({ roomId: room.id, userId, seatIndex });
      return snapshot(tx, room);
    });
    notify({ roomId: joined.id, kind: 'joined', userId });
    return joined;
  }

  async function getRoom(roomId: string, userId: string): Promise<Room> {
    return db.transaction(async (tx) => snapshot(tx, await lockMemberRoom(tx, roomId, userId)));
  }

  // the room the user is bound to by the one-active-room rule
  async function getCurrentRoom(userId: string): Promise<Room> {
    const [found] = await db
      .select({ room: gameRooms })
      .from(roomPlayers)
      .innerJoin(gameRooms, eq(gameRooms.id, roomPlayers.roomId))
      .where(and(eq(roomPlayers.userId, userId), inArray(gameRooms.status, ACTIVE_STATUSES)));
    if (!found) {
      throw roomNotFound();
    }
    return snapshot(db, found.room);
  }

  async function takeSeat(roomId: string, userId: string, seatIndex: number): Promise<Room> {
    const room = await db.transaction(async (tx) => {
      const room = await lockMemberRoom(tx, roomId, userId);
      requireWaiting(room);
      if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= room.targetPlayers) {
        throw new HttpError(400, 'INVALID_PAYLOAD', 'seat is outside the table');
      }
      const [occupant] = await tx
        .select({ userId: roomPlayers.userId })
        .from(roomPlayers)
        .where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.seatIndex, seatIndex)));
      if (occupant && occupant.userId !== userId) {
        throw new HttpError(409, 'INVALID_ACTION', 'seat is taken');
      }
      await tx
        .update(roomPlayers)
        .set({ seatIndex })
        .where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.userId, userId)));
      return snapshot(tx, room);
    });
    notify({ roomId, kind: 'seated', userId });
    return room;
  }

  // used by POST /lobbies/:id/leave and by the socket event `room:leave`
  async function leaveRoom(roomId: string, userId: string): Promise<LeaveResult> {
    const result = await db.transaction(async (tx) => {
      const room = await lockMemberRoom(tx, roomId, userId);
      requireWaiting(room);

      await tx
        .delete(roomPlayers)
        .where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.userId, userId)));

      const [next] = await tx
        .select({ userId: roomPlayers.userId })
        .from(roomPlayers)
        .where(eq(roomPlayers.roomId, roomId))
        .orderBy(asc(roomPlayers.seatIndex))
        .limit(1);

      if (!next) {
        await tx.delete(gameRooms).where(eq(gameRooms.id, roomId));
        return { roomId, roomClosed: true, newHostId: null };
      }
      if (room.createdBy === userId) {
        await tx.update(gameRooms).set({ createdBy: next.userId }).where(eq(gameRooms.id, roomId));
        return { roomId, roomClosed: false, newHostId: next.userId };
      }
      return { roomId, roomClosed: false, newHostId: null };
    });
    notify({ roomId, kind: result.roomClosed ? 'closed' : 'left', userId });
    return result;
  }

  // for the socket layer, which has already authenticated the caller by other means
  async function findRoom(roomId: string): Promise<Room | null> {
    const [room] = await db.select().from(gameRooms).where(eq(gameRooms.id, roomId));
    return room ? snapshot(db, room) : null;
  }

  return {
    createRoom,
    joinByCode,
    getRoom,
    getCurrentRoom,
    takeSeat,
    leaveRoom,
    findRoom,
    onChange: (listener: (change: RoomChange) => void): void => {
      listeners.push(listener);
    },
  };
}

export type RoomsService = ReturnType<typeof createRoomsService>;
