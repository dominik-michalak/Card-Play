import type { ClientWarState } from '@cardplay/shared';
import { cardLabel } from './cards';
import { useCountdown } from './hooks';

type Props = { state: ClientWarState; meId: string; onFlip: () => void };

export function WarTable({ state, meId, onFlip }: Props) {
  const secondsLeft = useCountdown(state.turnDeadlineAt);
  const iFlipped = state.flippedPlayerIds.includes(meId);
  const names = new Map(state.players.map((p) => [p.id, p.username]));

  return (
    <div>
      <h3>Wojna, runda {state.round + 1}</h3>
      <p>
        {secondsLeft === null
          ? 'Gra wstrzymana: czekamy na powrót gracza'
          : `Czas na ruch: ${secondsLeft} s`}
      </p>
      <table>
        <thead>
          <tr>
            <th>Gracz</th>
            <th>Karty w stosie</th>
            <th>Gotowy do rundy</th>
          </tr>
        </thead>
        <tbody>
          {state.players.map((p) => (
            <tr key={p.id}>
              <td>{p.username}</td>
              <td>{state.stackSizes[p.id]}</td>
              <td>{state.flippedPlayerIds.includes(p.id) ? 'tak' : 'nie'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={onFlip} disabled={iFlipped || secondsLeft === null}>
        {iFlipped ? 'Czekasz na przeciwnika' : 'Odkryj kartę'}
      </button>
      {state.lastRound && (
        <div>
          <h4>Poprzednia runda</h4>
          {state.lastRound.comparisons.map((pair, i) => (
            <p key={i}>
              {pair.map(cardLabel).join(' : ')}
              {i < state.lastRound!.comparisons.length - 1 && ' (wojna)'}
            </p>
          ))}
          <p>
            {state.lastRound.winnerId
              ? `Zabiera ${names.get(state.lastRound.winnerId)} (pula: ${state.lastRound.poolSize})`
              : 'Brak kart do dokończenia wojny'}
          </p>
        </div>
      )}
    </div>
  );
}
