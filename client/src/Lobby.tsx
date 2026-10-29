import {
  BOT_GAMES,
  GAME_PLAYER_LIMITS,
  MATCHMAKING_GAMES,
  type GameKey,
  type MatchmakingMode,
  type Room,
} from '@cardplay/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, type Api } from './api';
import { useMatchmaking } from './hooks';
import { matchModeLabel } from './matchmaking-state';
import type { RealtimeSocket } from './realtime';

// games that have a server module; the others cannot be started yet
export const PLAYABLE_GAMES: { key: GameKey; label: string }[] = [
  { key: 'war', label: 'Wojna' },
  { key: 'macao', label: 'Makao' },
  { key: 'poker', label: 'Poker' },
  { key: 'texas_clinch', label: 'Texas Clinch' },
];

const gameLabel = (key: GameKey) => PLAYABLE_GAMES.find((g) => g.key === key)?.label ?? key;
const gamesWith = (supported: readonly GameKey[]) =>
  PLAYABLE_GAMES.filter((g) => supported.includes(g.key));

type Props = { api: Api; socket: RealtimeSocket; onEnter: (room: Room) => void };

export function Lobby({ api, socket, onEnter }: Props) {
  const [gameType, setGameType] = useState<GameKey>(PLAYABLE_GAMES[0]!.key);
  const limits = GAME_PLAYER_LIMITS[gameType];
  const [targetPlayers, setTargetPlayers] = useState(limits.min);
  const [botGame, setBotGame] = useState<GameKey>(gamesWith(BOT_GAMES)[0]!.key);
  const [queueGame, setQueueGame] = useState<GameKey>(gamesWith(MATCHMAKING_GAMES)[0]!.key);
  const [queueMode, setQueueMode] = useState<MatchmakingMode>('competitive');
  const [error, setError] = useState<string | null>(null);
  const matchmaking = useMatchmaking(socket, api, onEnter);

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

  const queued = matchmaking.state.queued;
  const message = error ?? matchmaking.state.message;

  return (
    <div>
      <h2>Lobby</h2>
      {message && <p role="alert">{message}</p>}

      <section>
        <h3>Szukaj przeciwnika</h3>
        {queued ? (
          <p>
            Szukamy przeciwnika: {gameLabel(queued.gameType)}, {matchModeLabel(queued.mode)}…{' '}
            <button onClick={matchmaking.leave}>Anuluj</button>
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              matchmaking.join(queueGame, queueMode);
            }}
          >
            <label>
              Gra
              <select value={queueGame} onChange={(e) => setQueueGame(e.target.value as GameKey)}>
                {gamesWith(MATCHMAKING_GAMES).map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tryb
              <select
                value={queueMode}
                onChange={(e) => setQueueMode(e.target.value as MatchmakingMode)}
              >
                <option value="competitive">Rankingowy (zmienia Elo)</option>
                <option value="unrated">Towarzyski</option>
              </select>
            </label>
            <button type="submit">Szukaj</button>
          </form>
        )}
      </section>

      <section>
        <h3>Gra z botem</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.createRoom({ gameType: botGame, mode: 'bot' }));
          }}
        >
          <label>
            Gra
            <select value={botGame} onChange={(e) => setBotGame(e.target.value as GameKey)}>
              {gamesWith(BOT_GAMES).map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Zagraj z botem</button>
        </form>
      </section>

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
