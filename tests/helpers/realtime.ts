import type { ClientToServerEvents, ServerToClientEvents } from '@cardplay/shared';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createApp } from '../../server/src/app';
import { createResultsService } from '../../server/src/modules/results/results.service';
import { createRoomsService } from '../../server/src/modules/rooms/rooms.service';
import { createSocketServer } from '../../server/src/realtime/socket-server';
import type { MatchRules } from '../../server/src/matchmaking/pairing';
import type { Timings } from '../../server/src/realtime/timings';
import { testConfig } from './app';
import { openTestDb } from './db';
import { tokenFor } from './users';

export const FAST: Timings = {
  countdownMs: 80,
  turnMs: 400,
  disconnectMs: 300,
  lobbyGraceMs: 300,
  botDelayMs: 30,
  matchTickMs: 30,
  matchAcceptMs: 800,
};

type Received = { name: string; payload: unknown };

// a socket.io client that remembers every event, so a test never misses one that came early
export class TestClient {
  readonly received: Received[] = [];
  private readonly consumed = new Set<number>();
  constructor(readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>) {
    socket.onAny((name: string, payload: unknown) => this.received.push({ name, payload }));
  }

  emit<E extends keyof ClientToServerEvents>(
    name: E,
    ...args: Parameters<ClientToServerEvents[E]>
  ): void {
    this.socket.emit(name, ...args);
  }

  all<T = Record<string, never>>(name: string): T[] {
    return this.received.filter((r) => r.name === name).map((r) => r.payload as T);
  }

  // resolves with the first not yet consumed event that matches
  async next<T = Record<string, never>>(
    name: string,
    match: (payload: T) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.received.findIndex(
        (entry, i) => !this.consumed.has(i) && entry.name === name && match(entry.payload as T),
      );
      if (index >= 0) {
        this.consumed.add(index);
        return this.received[index]!.payload as T;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for "${name}"`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // asserts that nothing matching arrives within the window
  async quiet(name: string, ms = 250): Promise<void> {
    const before = this.all(name).length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.all(name).length !== before) throw new Error(`unexpected "${name}" event`);
  }

  close(): void {
    this.socket.close();
  }
}

export async function startRealtimeServer(
  timings: Timings = FAST,
  options: { matchRules?: MatchRules } = {},
) {
  const config = testConfig();
  const { db, pool } = openTestDb();
  const roomService = createRoomsService(db);
  const results = createResultsService(db);
  const http = createServer(createApp(config, db, { roomService }));
  const realtime = createSocketServer(http, {
    config,
    roomService,
    results,
    timings,
    matchRules: options.matchRules,
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const clients: TestClient[] = [];

  function open(token: string): Promise<TestClient> {
    const socket = connectClient(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    const client = new TestClient(socket);
    clients.push(client);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(client));
      socket.once('connect_error', (error) => reject(error));
    });
  }

  return {
    url,
    db,
    config,
    roomService,
    results,
    connectAs: (userId: string) => open(tokenFor(config, userId)),
    connectWithToken: open,
    // disconnecting leaves any matchmaking queue, so tests do not see each other's players
    closeClients: () => clients.splice(0).forEach((c) => c.close()),
    close: async () => {
      clients.forEach((c) => c.close());
      await realtime.close();
      await pool.end();
    },
  };
}

export async function waitUntil(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
