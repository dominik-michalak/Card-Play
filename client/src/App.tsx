import type { Room } from '@cardplay/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, createApi, type Api, type SessionUser } from './api';
import { AuthForm } from './AuthForm';
import { Lobby } from './Lobby';
import { connectRealtime, type RealtimeSocket } from './realtime';
import { RoomScreen } from './RoomScreen';

export function App() {
  const api = useMemo(() => createApi(), []);
  // undefined while the refresh cookie is being tried, null when nobody is signed in
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void api.restoreSession().then((restored) => {
      if (!cancelled) setUser(restored);
    });
    const stopListening = api.onSessionLost(() => setUser(null));
    return () => {
      cancelled = true;
      stopListening();
    };
  }, [api]);

  async function logout() {
    await api.logout();
    setUser(null);
  }

  return (
    <main>
      <header>
        <h1>CardPlay</h1>
        {user && (
          <p>
            {user.username} <button onClick={() => void logout()}>Wyloguj</button>
          </p>
        )}
      </header>
      {user === undefined ? (
        <p>Ładowanie…</p>
      ) : user === null ? (
        <AuthForm api={api} onSignedIn={setUser} />
      ) : (
        <Home api={api} user={user} />
      )}
    </main>
  );
}

function Home({ api, user }: { api: Api; user: SessionUser }) {
  const [socket, setSocket] = useState<RealtimeSocket | null>(null);
  // undefined while the current room is being looked up (also after a page reload)
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const connection = connectRealtime(api, { autoConnect: false });
    setSocket(connection);
    // Connecting on the next tick skips the throwaway mount of React StrictMode. A connection
    // that is opened and closed at once can still reach the server after the real one, and the
    // server would then treat the dead one as the newest and drop the live one.
    const timer = setTimeout(() => connection.connect(), 0);
    return () => {
      clearTimeout(timer);
      connection.disconnect();
    };
  }, [api]);

  useEffect(() => {
    api.currentRoom().then(setRoom, (e: unknown) => {
      setError(e instanceof ApiError ? e.message : 'Nie udało się pobrać pokoju');
      setRoom(null);
    });
  }, [api]);

  if (!socket || room === undefined) return <p>Ładowanie…</p>;
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {room ? (
        <RoomScreen
          key={room.id}
          api={api}
          socket={socket}
          user={user}
          room={room}
          onLeft={() => setRoom(null)}
        />
      ) : (
        <Lobby api={api} socket={socket} onEnter={setRoom} />
      )}
    </>
  );
}
