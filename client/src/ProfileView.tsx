import type { HistoryEntry, ProfileView as ProfileData } from '@cardplay/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api, type SessionUser } from './api';
import { ACHIEVEMENT_LABELS, GAME_LABELS, RESULT_LABELS, formatDate, signed } from './labels';
import { matchModeLabel } from './matchmaking-state';

const PAGE = 20;

type Props = {
  api: Api;
  user: SessionUser;
  // a user id, a user name or "me"
  userRef: string;
  onOpenProfile: (ref: string) => void;
};

export function ProfileView({ api, user, userRef, onOpenProfile }: Props) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setHistory([]);
    setMessage(null);
    Promise.all([api.profile(userRef), api.history(userRef, { limit: PAGE })]).then(
      ([loaded, games]) => {
        if (cancelled) return;
        setProfile(loaded);
        setHistory(games.items);
        setTotal(games.total);
      },
      (e: unknown) => {
        if (!cancelled)
          setMessage(e instanceof ApiError ? e.message : 'Nie udało się pobrać profilu');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, userRef]);

  async function loadMore() {
    const next = await api.history(userRef, { limit: PAGE, offset: history.length });
    setHistory((current) => [...current, ...next.items]);
    setTotal(next.total);
  }

  async function addFriend() {
    if (!profile) return;
    try {
      const { status } = await api.inviteFriend(profile.username);
      setMessage(status === 'accepted' ? 'Jesteście znajomymi' : 'Zaproszenie wysłane');
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Nie udało się wysłać zaproszenia');
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    if (name) onOpenProfile(name);
  }

  return (
    <div>
      <h2>Profil</h2>
      <form onSubmit={search}>
        <label>
          Szukaj gracza po nazwie
          <input name="name" maxLength={20} autoComplete="off" />
        </label>
        <button type="submit">Pokaż profil</button>
      </form>
      {message && <p role="alert">{message}</p>}
      {profile && (
        <>
          <h3>
            {profile.username}{' '}
            {profile.id !== user.id && (
              <button onClick={() => void addFriend()}>Dodaj do znajomych</button>
            )}
          </h3>
          <p>Konto od: {formatDate(profile.createdAt)}</p>
          <p>
            Razem: {profile.totals.played} gier, {profile.totals.wins} wygranych,{' '}
            {profile.totals.losses} porażek, {profile.totals.draws} remisów (
            {profile.totals.winRate}%)
          </p>
          {profile.games.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Gra</th>
                  <th>Elo</th>
                  <th>Gry</th>
                  <th>W</th>
                  <th>P</th>
                  <th>R</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {profile.games.map((g) => (
                  <tr key={g.gameType}>
                    <td>{GAME_LABELS[g.gameType]}</td>
                    <td>{g.elo ?? '—'}</td>
                    <td>{g.played}</td>
                    <td>{g.wins}</td>
                    <td>{g.losses}</td>
                    <td>{g.draws}</td>
                    <td>{g.winRate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Osiągnięcia</h3>
          {profile.achievements.length === 0 ? (
            <p>Brak osiągnięć.</p>
          ) : (
            <ul>
              {profile.achievements.map((a) => (
                <li key={a.id}>
                  <strong>{ACHIEVEMENT_LABELS[a.id].name}</strong>:{' '}
                  {ACHIEVEMENT_LABELS[a.id].description} ({formatDate(a.unlockedAt)})
                </li>
              ))}
            </ul>
          )}

          <h3>Historia gier</h3>
          {history.length === 0 ? (
            <p>Brak zakończonych gier.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Gra</th>
                  <th>Tryb</th>
                  <th>Wynik</th>
                  <th>Przeciwnicy</th>
                  <th>Elo</th>
                </tr>
              </thead>
              <tbody>
                {history.map((g) => (
                  <tr key={g.recordId}>
                    <td>{formatDate(g.finishedAt)}</td>
                    <td>{GAME_LABELS[g.gameType]}</td>
                    <td>{matchModeLabel(g.mode)}</td>
                    <td>{RESULT_LABELS[g.result]}</td>
                    <td>
                      {g.opponents.map((o, i) => (
                        <span key={`${o.userId}-${i}`}>
                          {i > 0 && ', '}
                          {o.userId ? (
                            <button onClick={() => onOpenProfile(o.userId!)}>{o.username}</button>
                          ) : (
                            o.username
                          )}
                        </span>
                      ))}
                    </td>
                    <td>{g.eloChange === null ? '' : signed(g.eloChange)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {history.length < total && <button onClick={() => void loadMore()}>Więcej</button>}
        </>
      )}
    </div>
  );
}
