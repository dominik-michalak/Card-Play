import type { GameKey, LeaderboardEntry } from '@cardplay/shared';
import { useEffect, useState } from 'react';
import { ApiError, type Api } from './api';
import { GAME_LABELS } from './labels';

const PAGE = 20;
const RANKED_GAMES: GameKey[] = ['war', 'macao'];

type Props = { api: Api; onOpenProfile: (ref: string) => void };

export function LeaderboardView({ api, onOpenProfile }: Props) {
  const [gameType, setGameType] = useState<GameKey>(RANKED_GAMES[0]!);
  const [items, setItems] = useState<LeaderboardEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setMessage(null);
    api.leaderboard(gameType, { limit: PAGE }).then(
      (page) => {
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.total);
      },
      (e: unknown) => {
        if (!cancelled)
          setMessage(e instanceof ApiError ? e.message : 'Nie udało się pobrać rankingu');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, gameType]);

  async function loadMore() {
    const page = await api.leaderboard(gameType, { limit: PAGE, offset: items.length });
    setItems((current) => [...current, ...page.items]);
    setTotal(page.total);
  }

  return (
    <div>
      <h2>Ranking</h2>
      <label>
        Gra
        <select value={gameType} onChange={(e) => setGameType(e.target.value as GameKey)}>
          {RANKED_GAMES.map((g) => (
            <option key={g} value={g}>
              {GAME_LABELS[g]}
            </option>
          ))}
        </select>
      </label>
      {message && <p role="alert">{message}</p>}
      {items.length === 0 && !message ? (
        <p>Nikt jeszcze nie ukończył gry w tej grze.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Gracz</th>
              <th>Elo</th>
              <th>Gry</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.userId}>
                <td>{row.rank}</td>
                <td>
                  <button onClick={() => onOpenProfile(row.userId)}>{row.username}</button>
                </td>
                <td>{row.elo}</td>
                <td>{row.gamesPlayed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length < total && <button onClick={() => void loadMore()}>Więcej</button>}
    </div>
  );
}
