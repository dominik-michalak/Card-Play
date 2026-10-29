import type { Room, ServerToClientEvents, UnlockedAchievement } from '@cardplay/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, createApi, type Api, type SessionUser } from './api';
import { AuthForm } from './AuthForm';
import { FriendsView } from './FriendsView';
import { LeaderboardView } from './LeaderboardView';
import { ACHIEVEMENT_LABELS } from './labels';
import { Lobby } from './Lobby';
import { ProfileView } from './ProfileView';
import { TicketsView } from './TicketsView';
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

type View =
  | { name: 'lobby' }
  | { name: 'profile'; ref: string }
  | { name: 'ranking' }
  | { name: 'friends' }
  | { name: 'tickets' };
type Invitation = Parameters<ServerToClientEvents['friend:invited']>[0];

function Home({ api, user }: { api: Api; user: SessionUser }) {
  const [socket, setSocket] = useState<RealtimeSocket | null>(null);
  // undefined while the current room is being looked up (also after a page reload)
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [view, setView] = useState<View>({ name: 'lobby' });
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [unlocked, setUnlocked] = useState<UnlockedAchievement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const connection = connectRealtime(api, { autoConnect: false });
    setSocket(connection);
    connection.on('friend:invited', setInvitation);
    connection.on('achievement:unlocked', setUnlocked);
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

  const enter = (next: Room) => {
    setInvitation(null);
    setRoom(next);
  };

  async function acceptInvitation() {
    if (!invitation) return;
    try {
      enter(await api.joinRoom(invitation.inviteCode));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się dołączyć do pokoju');
      setInvitation(null);
    }
  }

  if (!socket || room === undefined) return <p>Ładowanie…</p>;
  const banner = unlocked && (
    <p role="status">
      Nowe osiągnięcie: <strong>{ACHIEVEMENT_LABELS[unlocked.id].name}</strong>{' '}
      <button onClick={() => setUnlocked(null)}>OK</button>
    </p>
  );
  if (room) {
    return (
      <>
        {banner}
        {error && <p role="alert">{error}</p>}
        <RoomScreen
          key={room.id}
          api={api}
          socket={socket}
          user={user}
          room={room}
          onLeft={() => setRoom(null)}
        />
      </>
    );
  }
  return (
    <>
      <nav>
        <button onClick={() => setView({ name: 'lobby' })}>Lobby</button>{' '}
        <button onClick={() => setView({ name: 'profile', ref: 'me' })}>Mój profil</button>{' '}
        <button onClick={() => setView({ name: 'ranking' })}>Ranking</button>{' '}
        <button onClick={() => setView({ name: 'friends' })}>Znajomi</button>{' '}
        <button onClick={() => setView({ name: 'tickets' })}>Zgłoszenia</button>
      </nav>
      {banner}
      {error && <p role="alert">{error}</p>}
      {invitation && (
        <p role="alert">
          {invitation.fromUsername} zaprasza do gry ({invitation.gameType}){' '}
          <button onClick={() => void acceptInvitation()}>Dołącz</button>{' '}
          <button onClick={() => setInvitation(null)}>Ignoruj</button>
        </p>
      )}
      {view.name === 'lobby' && <Lobby api={api} socket={socket} onEnter={enter} />}
      {view.name === 'profile' && (
        <ProfileView
          api={api}
          user={user}
          userRef={view.ref}
          onOpenProfile={(ref) => setView({ name: 'profile', ref })}
        />
      )}
      {view.name === 'ranking' && (
        <LeaderboardView api={api} onOpenProfile={(ref) => setView({ name: 'profile', ref })} />
      )}
      {view.name === 'tickets' && <TicketsView api={api} />}
      {view.name === 'friends' && (
        <FriendsView api={api} onOpenProfile={(ref) => setView({ name: 'profile', ref })} />
      )}
    </>
  );
}
