import type {
  ErrorCode,
  FriendListView,
  GameKey,
  HistoryEntry,
  LeaderboardEntry,
  Paged,
  ProfileView,
  Room,
  UserRole,
} from '@cardplay/shared';

export type SessionUser = { id: string; username: string; email: string; role: UserRole };
type Session = { accessToken: string; user: SessionUser };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiOptions = {
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

export type CreateRoomRequest = {
  gameType: GameKey;
  targetPlayers?: number;
  // a private room unless the player wants the bot as the opponent
  mode?: 'private' | 'bot';
};
function pageQuery(page: { limit?: number; offset?: number }): Record<string, string> {
  const query: Record<string, string> = {};
  if (page.limit !== undefined) query.limit = String(page.limit);
  if (page.offset !== undefined) query.offset = String(page.offset);
  return query;
}

export type LeaveResult = { roomId: string; roomClosed: boolean; newHostId: string | null };

// The access token lives only in this closure (never in storage); the refresh token is an
// HttpOnly cookie that the browser sends by itself.
export function createApi(options: ApiOptions = {}) {
  const baseUrl = options.baseUrl ?? '';
  const fetchFn: typeof fetch = options.fetchFn ?? ((input, init) => fetch(input, init));
  let accessToken: string | null = null;
  let refreshInFlight: Promise<SessionUser | null> | null = null;
  const lostListeners = new Set<() => void>();

  function send(path: string, method: string, body: unknown, token: string | null) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    return fetchFn(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const error = (data as { error?: { code: ErrorCode; message: string } } | undefined)?.error;
      throw new ApiError(
        res.status,
        error?.code ?? 'INTERNAL_ERROR',
        error?.message ?? res.statusText,
      );
    }
    return data as T;
  }

  function takeSession(session: Session): SessionUser {
    accessToken = session.accessToken;
    return session.user;
  }

  // one refresh at a time: parallel 401s share it, which the server's token rotation requires
  function refreshSession(): Promise<SessionUser | null> {
    refreshInFlight ??= send('/api/v1/auth/refresh', 'POST', undefined, null)
      .then(async (res) => (res.ok ? takeSession(await parse<Session>(res)) : null))
      .catch(() => null)
      .then((user) => {
        if (!user) accessToken = null;
        return user;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  function dropSession(): void {
    accessToken = null;
    lostListeners.forEach((listener) => listener());
  }

  // a 401 means the access token expired: refresh once and repeat the request
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let res = await send(path, method, body, accessToken);
    if (res.status === 401) {
      if (await refreshSession()) {
        res = await send(path, method, body, accessToken);
      } else {
        dropSession();
      }
    }
    return parse<T>(res);
  }

  return {
    getAccessToken: (): string | null => accessToken,
    setAccessToken: (token: string | null): void => {
      accessToken = token;
    },
    refreshSession,
    dropSession,
    onSessionLost(listener: () => void): () => void {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },

    // null when there is no valid refresh cookie
    restoreSession: refreshSession,
    async register(input: { username: string; email: string; password: string }) {
      return takeSession(
        await parse<Session>(await send('/api/v1/auth/register', 'POST', input, null)),
      );
    },
    async login(input: { email: string; password: string }) {
      return takeSession(
        await parse<Session>(await send('/api/v1/auth/login', 'POST', input, null)),
      );
    },
    async logout(): Promise<void> {
      await send('/api/v1/auth/logout', 'POST', undefined, null);
      accessToken = null;
    },

    createRoom: (input: CreateRoomRequest) => request<Room>('/api/v1/lobbies', 'POST', input),
    joinRoom: (code: string) => request<Room>('/api/v1/lobbies/join', 'POST', { code }),
    leaveRoom: (roomId: string) => request<LeaveResult>(`/api/v1/lobbies/${roomId}/leave`, 'POST'),
    // `ref` is a user id, a user name or "me"
    profile: (ref: string) =>
      request<ProfileView>(`/api/v1/users/${encodeURIComponent(ref)}/profile`),
    history: (ref: string, page: { limit?: number; offset?: number } = {}) =>
      request<Paged<HistoryEntry>>(
        `/api/v1/users/${encodeURIComponent(ref)}/games?${new URLSearchParams(pageQuery(page))}`,
      ),
    leaderboard: (gameType: GameKey, page: { limit?: number; offset?: number } = {}) =>
      request<Paged<LeaderboardEntry>>(
        `/api/v1/leaderboard/${gameType}?${new URLSearchParams(pageQuery(page))}`,
      ),

    friends: () => request<FriendListView>('/api/v1/users/me/friends'),
    inviteFriend: (username: string) =>
      request<{ status: 'pending' | 'accepted'; user: { id: string; username: string } }>(
        '/api/v1/users/me/friends',
        'POST',
        { username },
      ),
    acceptFriend: (userId: string) =>
      request<{ status: 'accepted' }>(`/api/v1/users/me/friends/${userId}/accept`, 'POST'),
    declineFriend: (userId: string) =>
      request<void>(`/api/v1/users/me/friends/${userId}/decline`, 'POST'),
    removeFriend: (userId: string) => request<void>(`/api/v1/users/me/friends/${userId}`, 'DELETE'),

    async currentRoom(): Promise<Room | null> {
      try {
        return await request<Room>('/api/v1/lobbies/current');
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

export type Api = ReturnType<typeof createApi>;
