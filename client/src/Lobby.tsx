import { GAME_PLAYER_LIMITS, type GameKey, type Room } from '@cardplay/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, type Api } from './api';

// games that have a server module; the others cannot be started yet
export const PLAYABLE_GAMES: { key: GameKey; label: string }[] = [
  { key: 'war', label: 'Wojna' },
  { key: 'macao', label: 'Makao' },
];

type Props = { api: Api; onEnter: (room: Room) => void };

export function Lobby({ api, onEnter }: Props) {
  const [gameType, setGameType] = useState<GameKey>(PLAYABLE_GAMES[0]!.key);
  const limits = GAME_PLAYER_LIMITS[gameType];
  const [targetPlayers, setTargetPlayers] = useState(limits.min);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<Room>) {
    setError(null);
    try {
      onEnter(await action());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się połączyć z serwerem');
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void run(() => api.createRoom({ gameType, targetPlayers }));
  }

  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code'));
    void run(() => api.joinRoom(code));
  }

  return (
    <div>
      <h2>Lobby</h2>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={create}>
        <h3>Nowy pokój prywatny</h3>
        <label>
          Gra
          <select
            value={gameType}
            onChange={(e) => {
              const next = e.target.value as GameKey;
              setGameType(next);
              setTargetPlayers(GAME_PLAYER_LIMITS[next].min);
            }}
          >
            {PLAYABLE_GAMES.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        {limits.min !== limits.max && (
          <label>
            Liczba graczy
            <input
              type="number"
              min={limits.min}
              max={limits.max}
              value={targetPlayers}
              onChange={(e) => setTargetPlayers(Number(e.target.value))}
            />
          </label>
        )}
        <button type="submit">Utwórz pokój</button>
      </form>
      <form onSubmit={join}>
        <h3>Dołącz kodem</h3>
        <label>
          Kod zaproszenia
          <input name="code" required maxLength={8} autoComplete="off" />
        </label>
        <button type="submit">Dołącz</button>
      </form>
    </div>
  );
}
