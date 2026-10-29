import {
  GameRuleError,
  type ClientToServerEvents,
  type ErrorPayload,
  type GamePlayer,
  type RandomSource,
  type Room,
  type RoomPlayer,
  type ServerToClientEvents,
} from '@cardplay/shared';
import type { Server as HttpServer } from 'node:http';
import Joi from 'joi';
import { Server, type Socket } from 'socket.io';
import type { Config } from '../config';
import { HttpError } from '../http-error';
import { verifyAccessTokenWithExpiry } from '../modules/auth/tokens';
import type { ResultsService } from '../modules/results/results.service';
import type { RoomChange, RoomsService } from '../modules/rooms/rooms.service';
import { validate } from '../validate';
import { GAME_REGISTRY } from './game-registry';
import { botPlayer } from '../bots/bots';
import type { MatchRules } from '../matchmaking/pairing';
import type { FriendsService } from '../modules/friends/friends.service';
import { createGameRunner } from './game-runner';
import { createMatchmaker } from './matchmaker';
import type { Presence } from './presence';
import { createLobbyState } from './lobby-state';
import {
  actionSchema,
  friendInviteSchema,
  type FriendInvitePayload,
  matchmakingJoinSchema,
  readySchema,
  roomRefSchema,
  seatSchema,
  type ActionPayload,
  type MatchmakingJoinPayload,
  type ReadyPayload,
  type RoomRef,
  type SeatPayload,
} from './schemas';
import { DEFAULT_TIMINGS, type Timings } from './timings';

type SocketData = { userId: string; expiresAt: number; roomId?: string };
type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export type SocketServerDeps = {
  config: Config;
  roomService: RoomsService;
  results: ResultsService;
  timings?: Timings;
  random?: RandomSource;
  matchRules?: MatchRules;
  presence: Presence;
  friendsService: FriendsService;
};

const MAX_PAYLOAD_BYTES = 10_000;
// setTimeout cannot wait longer than a signed 32-bit number of milliseconds
const MAX_TIMER_MS = 2 ** 31 - 1;
// a client sending more than this many events in the window gets RATE_LIMITED
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 40;

const roomChannel = (roomId: string) => `room:${roomId}`;
const userChannel = (userId: string) => `user:${userId}`;

function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof HttpError || error instanceof GameRuleError) {
    return { code: error.code, message: error.message };
  }
  if (Joi.isError(error)) {
    return { code: 'INVALID_PAYLOAD', message: error.details.map((d) => d.message).join('; ') };
  }
  console.error(error);
  return { code: 'INTERNAL_ERROR', message: 'internal server error' };
}

// Socket.IO layer: authenticates, validates, and forwards to the shared room/game services
export function createSocketServer(httpServer: HttpServer, deps: SocketServerDeps) {
  const { config, roomService, results } = deps;
  const timings = deps.timings ?? DEFAULT_TIMINGS;

  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: { origin: config.clientOrigin, credentials: true },
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    serveClient: false,
  });

  const sockets = new Map<string, AppSocket>(); // the one live connection of each user
  const attached = new Map<string, Set<string>>(); // roomId -> users whose socket joined it
  const graceTimers = new Map<string, NodeJS.Timeout>(); // userId -> pending seat release

  const lobby = createLobbyState(timings.countdownMs, (roomId) => {
    beginGame(roomId).catch((error: unknown) => console.error(error));
  });

  const matchmaker = createMatchmaker({
    roomService,
    results,
    timings,
    rules: deps.matchRules,
    sink: {
      found: (userId, roomId) => {
        io.to(userChannel(userId)).emit('matchmaking:found', { roomId });
      },
      status: (userId, status) => {
        io.to(userChannel(userId)).emit('matchmaking:status', status);
      },
    },
  });

  const runner = createGameRunner({
    results,
    timings,
    random: deps.random,
    sink: {
      state: (roomId, userId, state) => {
        io.to(userChannel(userId)).emit('game:state_update', { roomId, state });
      },
      event: (roomId, event) => {
        io.to(roomChannel(roomId)).emit('game:event', { roomId, event });
      },
      achievement: (userId, achievement) => {
        io.to(userChannel(userId)).emit('achievement:unlocked', achievement);
      },
      finished: (roomId, result, ratings) => {
        io.to(roomChannel(roomId)).emit('game:finished', { roomId, result, ratings });
        for (const userId of [...(attached.get(roomId) ?? [])]) {
          const socket = sockets.get(userId);
          if (socket) {
            void unbind(socket, roomId);
          }
        }
      },
    },
  });

  // ---- room presence ----------------------------------------------------------------------

  async function roomPlayers(roomId: string): Promise<RoomPlayer[] | null> {
    const room = await roomService.findRoom(roomId);
    return room?.players.map((p) => ({ ...p, ready: lobby.isReady(roomId, p.userId) })) ?? null;
  }

  async function broadcastPlayers(roomId: string): Promise<void> {
    const players = await roomPlayers(roomId);
    if (players) {
      io.to(roomChannel(roomId)).emit('room:players', { roomId, players });
    }
  }

  function emitCountdown(roomId: string): void {
    const endsAt = lobby.endsAt(roomId);
    io.to(roomChannel(roomId)).emit('room:countdown', {
      roomId,
      startsAt: endsAt === null ? null : new Date(endsAt).toISOString(),
    });
  }

  // the humans a game needs: all seats, or just the host when the bot takes the other one
  const humansNeeded = (room: Room): number => (room.mode === 'bot' ? 1 : room.targetPlayers);

  function isStartable(room: Room | null): room is Room {
    return (
      room?.status === 'waiting' &&
      room.players.length === humansNeeded(room) &&
      room.players.every((p) => lobby.isReady(room.id, p.userId))
    );
  }

  // the countdown runs exactly while the room is full and every player is ready
  async function syncCountdown(roomId: string): Promise<void> {
    const room = await roomService.findRoom(roomId);
    if (isStartable(room)) {
      if (lobby.startCountdown(roomId)) emitCountdown(roomId);
    } else if (lobby.cancelCountdown(roomId)) {
      emitCountdown(roomId);
    }
  }

  // re-checks the room: it may have changed during the countdown
  async function beginGame(roomId: string): Promise<void> {
    const room = await roomService.findRoom(roomId);
    if (!isStartable(room)) {
      return;
    }
    const players: GamePlayer[] = room.players.map((p) => ({
      id: p.userId,
      username: p.username,
      isBot: false,
    }));
    if (room.mode === 'bot') players.push(botPlayer());
    try {
      await runner.start(roomId, room.gameType, players, [...(attached.get(roomId) ?? [])]);
      lobby.clearRoom(roomId);
    } catch (error) {
      io.to(roomChannel(roomId)).emit('error', toErrorPayload(error));
      for (const p of room.players) lobby.setReady(roomId, p.userId, false);
      await broadcastPlayers(roomId);
    }
  }

  function bind(socket: AppSocket, roomId: string): void {
    void socket.join(roomChannel(roomId));
    socket.data.roomId = roomId;
    const users = attached.get(roomId) ?? new Set<string>();
    users.add(socket.data.userId);
    attached.set(roomId, users);
  }

  // the socket stops being part of the room; presence bookkeeping only, no game consequences
  async function unbind(socket: AppSocket, roomId: string): Promise<void> {
    if (socket.data.roomId === roomId) {
      socket.data.roomId = undefined;
    }
    attached.get(roomId)?.delete(socket.data.userId);
    await socket.leave(roomChannel(roomId));
  }

  // the player left the room's presence: a running game pauses, a waiting room starts a grace
  async function onPresenceLost(userId: string, roomId: string): Promise<void> {
    if (runner.has(roomId)) {
      await runner.playerDisconnected(roomId, userId);
      return;
    }
    lobby.setReady(roomId, userId, false);
    await syncCountdown(roomId);
    await broadcastPlayers(roomId);
    const timer = setTimeout(() => {
      graceTimers.delete(userId);
      roomService.leaveRoom(roomId, userId).catch((error: unknown) => {
        // the room may be gone or already playing; both mean there is no seat to release
        if (!(error instanceof HttpError)) console.error(error);
      });
    }, timings.lobbyGraceMs);
    timer.unref();
    graceTimers.set(userId, timer);
  }

  async function onRoomChange(change: RoomChange): Promise<void> {
    const { roomId, kind, userId } = change;
    if (kind === 'closed') {
      lobby.clearRoom(roomId);
    } else if (kind === 'left') {
      lobby.setReady(roomId, userId, false);
      await syncCountdown(roomId);
    }
    if (kind === 'left' || kind === 'closed') {
      const socket = sockets.get(userId);
      if (socket) await unbind(socket, roomId);
    }
    if (kind !== 'closed') {
      await broadcastPlayers(roomId);
    }
  }
  roomService.onChange((change) => {
    onRoomChange(change).catch((error: unknown) => console.error(error));
  });

  // ---- connection handling ---------------------------------------------------------------

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown };
    const payload =
      typeof auth.token === 'string'
        ? verifyAccessTokenWithExpiry(auth.token, config.jwtSecret)
        : null;
    if (!payload) {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    socket.data.userId = payload.userId;
    socket.data.expiresAt = payload.expiresAt;
    next();
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;

    // one live connection per user: the newest wins
    const previous = sockets.get(userId);
    sockets.set(userId, socket);
    deps.presence.markOnline(userId);
    void socket.join(userChannel(userId));
    if (previous) {
      previous.emit('error', { code: 'FORBIDDEN', message: 'connected from another place' });
      previous.disconnect(true);
    }

    // the token is checked only at the handshake, so the socket must not outlive it; the
    // client reconnects with a fresh token
    const expiry = setTimeout(
      () => {
        socket.emit('error', { code: 'UNAUTHORIZED', message: 'access token expired' });
        socket.disconnect(true);
      },
      Math.min(Math.max(socket.data.expiresAt - Date.now(), 0), MAX_TIMER_MS),
    );
    expiry.unref();

    const recent: number[] = [];
    function guarded<T>(schema: Joi.Schema, handler: (payload: T) => Promise<void>) {
      return (raw: unknown): void => {
        const now = Date.now();
        while (recent.length > 0 && now - recent[0]! > RATE_WINDOW_MS) recent.shift();
        recent.push(now);
        const task =
          recent.length > RATE_MAX_EVENTS
            ? Promise.reject(new HttpError(429, 'RATE_LIMITED', 'too many events'))
            : Promise.resolve().then(() => handler(validate<T>(schema, raw)));
        task.catch((error: unknown) => socket.emit('error', toErrorPayload(error)));
      };
    }

    socket.on(
      'room:join',
      guarded<RoomRef>(roomRefSchema, async ({ roomId }) => {
        const room = await roomService.getRoom(roomId, userId); // membership check
        const old = socket.data.roomId;
        if (old && old !== roomId) {
          await unbind(socket, old);
          await onPresenceLost(userId, old);
        }
        clearTimeout(graceTimers.get(userId));
        graceTimers.delete(userId);
        bind(socket, roomId);
        // matchmaking and bot rooms have nobody to wait for: joining is being ready
        if (room.mode !== 'private' && room.status === 'waiting') {
          lobby.setReady(roomId, userId, true);
          await syncCountdown(roomId);
          await broadcastPlayers(roomId);
        }
        if (runner.has(roomId)) {
          await runner.playerReconnected(roomId, userId);
        }
        socket.emit('room:players', {
          roomId,
          players: room.players.map((p) => ({ ...p, ready: lobby.isReady(roomId, p.userId) })),
        });
        const endsAt = lobby.endsAt(roomId);
        if (endsAt !== null) {
          socket.emit('room:countdown', { roomId, startsAt: new Date(endsAt).toISOString() });
        }
      }),
    );

    socket.on(
      'room:leave',
      guarded<RoomRef>(roomRefSchema, async ({ roomId }) => {
        await roomService.leaveRoom(roomId, userId);
      }),
    );

    socket.on(
      'room:seat',
      guarded<SeatPayload>(seatSchema, async ({ roomId, seatIndex }) => {
        await roomService.takeSeat(roomId, userId, seatIndex);
      }),
    );

    socket.on(
      'room:ready',
      guarded<ReadyPayload>(readySchema, async ({ roomId, ready }) => {
        if (socket.data.roomId !== roomId) {
          throw new HttpError(409, 'INVALID_ACTION', 'join the room first');
        }
        const room = await roomService.getRoom(roomId, userId);
        if (room.status !== 'waiting') {
          throw new HttpError(409, 'INVALID_ACTION', 'the game has already started');
        }
        if (!GAME_REGISTRY[room.gameType]?.rulesDefined) {
          throw new HttpError(
            409,
            'GAME_RULES_NOT_DEFINED',
            'the rules of this game are not defined',
          );
        }
        lobby.setReady(roomId, userId, ready);
        await syncCountdown(roomId);
        await broadcastPlayers(roomId);
      }),
    );

    socket.on(
      'game:action',
      guarded<ActionPayload>(actionSchema, async ({ roomId, action }) => {
        if (socket.data.roomId !== roomId) {
          throw new HttpError(404, 'ROOM_NOT_FOUND', 'room not found');
        }
        await runner.applyAction(roomId, userId, action);
      }),
    );

    socket.on(
      'matchmaking:join',
      guarded<MatchmakingJoinPayload>(matchmakingJoinSchema, async ({ gameType, mode }) => {
        await matchmaker.join(userId, gameType, mode);
      }),
    );

    socket.on(
      'friend:invite',
      guarded<FriendInvitePayload>(friendInviteSchema, async ({ userId: friendId, roomId }) => {
        if (!(await deps.friendsService.areFriends(userId, friendId))) {
          throw new HttpError(403, 'FORBIDDEN', 'this player is not your friend');
        }
        const room = await roomService.getRoom(roomId, userId); // must be a member
        if (room.mode !== 'private' || room.status !== 'waiting' || !room.inviteCode) {
          throw new HttpError(409, 'INVALID_ACTION', 'only a waiting private room can be shared');
        }
        if (room.players.length >= room.targetPlayers) {
          throw new HttpError(409, 'ROOM_FULL', 'room is full');
        }
        if (!deps.presence.isOnline(friendId)) {
          throw new HttpError(409, 'INVALID_ACTION', 'your friend is offline');
        }
        const me = room.players.find((p) => p.userId === userId);
        io.to(userChannel(friendId)).emit('friend:invited', {
          fromUserId: userId,
          fromUsername: me?.username ?? '',
          gameType: room.gameType,
          inviteCode: room.inviteCode,
        });
      }),
    );

    socket.on('matchmaking:leave', () => {
      matchmaker.leave(userId);
    });

    socket.on('disconnect', () => {
      clearTimeout(expiry);
      deps.presence.markOffline(userId);
      // a player who is gone cannot accept a match
      matchmaker.leave(userId);
      if (sockets.get(userId) === socket) {
        sockets.delete(userId);
      }
      const roomId = socket.data.roomId;
      if (roomId) {
        attached.get(roomId)?.delete(userId);
        onPresenceLost(userId, roomId).catch((error: unknown) => console.error(error));
      }
    });
  });

  async function close(): Promise<void> {
    runner.dispose();
    matchmaker.dispose();
    lobby.dispose();
    graceTimers.forEach((timer) => clearTimeout(timer));
    graceTimers.clear();
    await io.close();
  }

  return { io, close };
}
