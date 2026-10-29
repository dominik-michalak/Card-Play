import type { GameKey, MatchmakingMode } from '@cardplay/shared';
import { HttpError } from '../http-error';
import { DEFAULT_RULES, findPairs, type MatchRules, type QueueEntry } from '../matchmaking/pairing';
import type { ResultsService } from '../modules/results/results.service';
import type { RoomsService } from '../modules/rooms/rooms.service';
import type { Timings } from './timings';

export type MatchmakingStatus = {
  queued: boolean;
  gameType?: GameKey;
  mode?: MatchmakingMode;
  reason?: 'left' | 'match_failed' | 'opponent_missing';
};

export type MatchmakerSink = {
  found(userId: string, roomId: string): void;
  status(userId: string, status: MatchmakingStatus): void;
};

export type MatchmakerOptions = {
  roomService: RoomsService;
  results: ResultsService;
  timings: Timings;
  sink: MatchmakerSink;
  rules?: MatchRules;
};

const conflict = (message: string) => new HttpError(409, 'ROOM_MEMBERSHIP_CONFLICT', message);

// The queues live in memory (one process, like ready flags). A player is in at most one queue and
// never while they sit in a room.
export function createMatchmaker(options: MatchmakerOptions) {
  const { roomService, results, timings, sink } = options;
  const rules = options.rules ?? DEFAULT_RULES;
  const queue = new Map<string, QueueEntry>();
  const acceptTimers = new Set<NodeJS.Timeout>();
  let ticking = false;

  const hasRoom = (userId: string): Promise<boolean> =>
    roomService.getCurrentRoom(userId).then(
      () => true,
      (error: unknown) => {
        if (error instanceof HttpError && error.status === 404) return false;
        throw error;
      },
    );

  async function join(userId: string, gameType: GameKey, mode: MatchmakingMode): Promise<void> {
    if (queue.has(userId)) throw conflict('you are already waiting for a match');
    if (await hasRoom(userId)) throw conflict('leave your current room first');
    const elo = await results.getRating(userId, gameType);
    // another join may have been accepted while the rating was read
    if (queue.has(userId)) throw conflict('you are already waiting for a match');
    queue.set(userId, { userId, gameType, mode, elo, joinedAt: Date.now() });
    sink.status(userId, { queued: true, gameType, mode });
  }

  function leave(userId: string, reason: MatchmakingStatus['reason'] = 'left'): boolean {
    if (!queue.delete(userId)) return false;
    sink.status(userId, { queued: false, reason });
    return true;
  }

  // nobody joined within the time limit: the room is closed and the players are free again
  async function expire(roomId: string, userIds: string[]): Promise<void> {
    const room = await roomService.findRoom(roomId);
    if (room?.status !== 'waiting') return;
    for (const userId of userIds) {
      await roomService.leaveRoom(roomId, userId).catch((error: unknown) => {
        if (!(error instanceof HttpError)) throw error;
      });
    }
    // told only once the room is really gone
    for (const userId of userIds)
      sink.status(userId, { queued: false, reason: 'opponent_missing' });
  }

  async function makeMatch([a, b]: [QueueEntry, QueueEntry]): Promise<void> {
    let roomId: string;
    try {
      roomId = (await roomService.createMatchRoom(a.gameType, a.mode, [a.userId, b.userId])).id;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // someone sat down in a room while waiting: they leave the queue, the other keeps waiting
      for (const entry of [a, b]) {
        if (await hasRoom(entry.userId)) {
          sink.status(entry.userId, { queued: false, reason: 'match_failed' });
        } else {
          queue.set(entry.userId, entry);
        }
      }
      return;
    }
    sink.found(a.userId, roomId);
    sink.found(b.userId, roomId);
    const timer = setTimeout(() => {
      acceptTimers.delete(timer);
      expire(roomId, [a.userId, b.userId]).catch((error: unknown) => console.error(error));
    }, timings.matchAcceptMs);
    timer.unref();
    acceptTimers.add(timer);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const pair of findPairs([...queue.values()], Date.now(), rules)) {
        queue.delete(pair[0].userId);
        queue.delete(pair[1].userId);
        await makeMatch(pair);
      }
    } finally {
      ticking = false;
    }
  }

  const interval = setInterval(() => {
    tick().catch((error: unknown) => console.error(error));
  }, timings.matchTickMs);
  interval.unref();

  return {
    join,
    leave,
    isQueued: (userId: string): boolean => queue.has(userId),
    dispose(): void {
      clearInterval(interval);
      acceptTimers.forEach((timer) => clearTimeout(timer));
      acceptTimers.clear();
      queue.clear();
    },
  };
}

export type Matchmaker = ReturnType<typeof createMatchmaker>;
