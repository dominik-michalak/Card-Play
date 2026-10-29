import type { FriendListView } from '@cardplay/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api } from './api';

type Props = { api: Api; onOpenProfile: (ref: string) => void };

export function FriendsView({ api, onOpenProfile }: Props) {
  const [list, setList] = useState<FriendListView | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api.friends().then(setList, (e: unknown) => {
        setMessage(e instanceof ApiError ? e.message : 'Nie udało się pobrać znajomych');
      }),
    [api],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>, done?: string) {
    setMessage(null);
    try {
      await action();
      if (done) setMessage(done);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Nie udało się wykonać akcji');
    }
    await reload();
  }

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const username = String(new FormData(form).get('username')).trim();
    if (!username) return;
    void run(async () => {
      const { status } = await api.inviteFriend(username);
      setMessage(status === 'accepted' ? 'Jesteście znajomymi' : 'Zaproszenie wysłane');
      form.reset();
    });
  }

  return (
    <div>
      <h2>Znajomi</h2>
      <form onSubmit={invite}>
        <label>
          Zaproś po nazwie użytkownika
          <input name="username" required maxLength={20} autoComplete="off" />
        </label>
        <button type="submit">Zaproś</button>
      </form>
      {message && <p role="alert">{message}</p>}
      {list && (
        <>
          <h3>Zaproszenia do ciebie</h3>
          {list.incoming.length === 0 ? <p>Brak.</p> : null}
          {list.incoming.map((p) => (
            <p key={p.userId}>
              {p.username}{' '}
              <button onClick={() => void run(() => api.acceptFriend(p.userId))}>Akceptuj</button>{' '}
              <button onClick={() => void run(() => api.declineFriend(p.userId))}>Odrzuć</button>
            </p>
          ))}

          <h3>Wysłane zaproszenia</h3>
          {list.outgoing.length === 0 ? <p>Brak.</p> : null}
          {list.outgoing.map((p) => (
            <p key={p.userId}>
              {p.username}{' '}
              <button onClick={() => void run(() => api.declineFriend(p.userId))}>Anuluj</button>
            </p>
          ))}

          <h3>Lista znajomych</h3>
          {list.friends.length === 0 ? <p>Nie masz jeszcze znajomych.</p> : null}
          {list.friends.map((f) => (
            <p key={f.userId}>
              {f.online ? '● online' : '○ offline'} {f.username}{' '}
              <button onClick={() => onOpenProfile(f.userId)}>Profil</button>{' '}
              <button onClick={() => void run(() => api.removeFriend(f.userId))}>Usuń</button>
            </p>
          ))}
          <button onClick={() => void reload()}>Odśwież</button>
        </>
      )}
    </div>
  );
}
