import type { ClientToServerEvents, ServerToClientEvents } from '@cardplay/shared';
import { io, type Socket } from 'socket.io-client';
import type { Api } from './api';

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Connects with the current access token. The server closes a socket when its token expires and
// does not retry by itself after refusing a connection, so both cases get a fresh token here.
export function connectRealtime(
  api: Api,
  options: { url?: string; autoConnect?: boolean } = {},
): RealtimeSocket {
  const socketOptions = {
    auth: (callback: (data: object) => void) => callback({ token: api.getAccessToken() }),
    transports: ['websocket'],
    autoConnect: options.autoConnect ?? true,
  };
  const socket: RealtimeSocket = options.url ? io(options.url, socketOptions) : io(socketOptions);

  let retriedWithFreshToken = false;
  // the server closes the older of two connections of one user; reconnecting would only make
  // the two tabs replace each other forever
  let replacedByAnotherConnection = false;
  const reconnectWithFreshToken = async () => {
    if (await api.refreshSession()) {
      socket.connect();
    } else {
      api.dropSession();
    }
  };

  socket.on('connect', () => {
    retriedWithFreshToken = false;
    replacedByAnotherConnection = false;
  });
  socket.on('error', (error) => {
    if (error.code === 'FORBIDDEN') replacedByAnotherConnection = true;
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && !replacedByAnotherConnection) {
      void reconnectWithFreshToken();
    }
  });
  socket.on('connect_error', (error) => {
    if (error.message === 'UNAUTHORIZED' && !retriedWithFreshToken) {
      retriedWithFreshToken = true;
      void reconnectWithFreshToken();
    }
  });
  return socket;
}
