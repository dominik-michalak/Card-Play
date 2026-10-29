import type { ClientPokerState, GameAction } from '@cardplay/shared';
import { useEffect, useState } from 'react';
import { cardLabel } from './cards';
import { useCountdown } from './hooks';

const STREETS = { preflop: 'przed flopem', flop: 'flop', turn: 'turn', river: 'river' } as const;

type Props = { state: ClientPokerState; meId: string; onAction: (action: GameAction) => void };

export function PokerTable({ state, meId, onAction }: Props) {
  const secondsLeft = useCountdown(state.turnDeadlineAt);
  const names = new Map(state.players.map((p) => [p.id, p.username]));
  const myTurn = state.currentPlayerId === meId;
  const legal = state.legal;
  const range = legal?.bet ?? legal?.raise ?? null;
  const [amount, setAmount] = useState(range?.min ?? 0);

  // a new decision starts from the smallest allowed bet or raise
  useEffect(() => {
    if (range) setAmount(range.min);
  }, [range?.min, range?.max, state.street, state.handNumber]);

  const act = (type: 'fold' | 'check' | 'call' | 'all_in') => onAction({ type });
  const sizedAction = legal?.bet ? 'bet' : 'raise';

  return (
    <div>
      <h3>
        Poker, rozdanie {state.handNumber} ({STREETS[state.street]}), blindy {state.smallBlind}/
        {state.bigBlind}
      </h3>
      <p>
        {secondsLeft === null
          ? 'Gra wstrzymana: czekamy na powrót gracza'
          : state.currentPlayerId === null
            ? ''
            : myTurn
              ? `Twój ruch, czas: ${secondsLeft} s`
              : `Ruch gracza ${names.get(state.currentPlayerId)}, czas: ${secondsLeft} s`}
      </p>

      <p>
        Stół:{' '}
        {state.board.length === 0
          ? '—'
          : state.board.map((c) => <strong key={cardLabel(c)}>{cardLabel(c)} </strong>)}
      </p>
      <p>
        Pula: {state.pot}
        {state.pots.length > 1 &&
          ` (${state.pots.map((p, i) => `${i === 0 ? 'główna' : `boczna ${i}`}: ${p.amount}`).join(', ')})`}
      </p>

      <table>
        <thead>
          <tr>
            <th>Gracz</th>
            <th>Żetony</th>
            <th>Stawka</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {state.seats.map((seat) => (
            <tr key={seat.playerId}>
              <td>{names.get(seat.playerId)}</td>
              <td>{seat.stack}</td>
              <td>{seat.bet || ''}</td>
              <td>
                {[
                  seat.isButton && 'BTN',
                  seat.isSmallBlind && 'SB',
                  seat.isBigBlind && 'BB',
                  seat.out && 'odpadł',
                  !seat.out && seat.folded && 'pas',
                  seat.allIn && 'all-in',
                  state.currentPlayerId === seat.playerId && 'ruch',
                ]
                  .filter(Boolean)
                  .join(' ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Twoje karty</h4>
      <p>
        {state.hole.length === 0
          ? 'Pasujesz w tym rozdaniu'
          : state.hole.map((c) => <strong key={cardLabel(c)}>{cardLabel(c)} </strong>)}
      </p>

      {legal && (
        <p>
          <button onClick={() => act('fold')}>Pas</button>{' '}
          {legal.canCheck && <button onClick={() => act('check')}>Czekaj</button>}{' '}
          {legal.call !== null && (
            <button onClick={() => act('call')}>Wyrównaj ({legal.call})</button>
          )}{' '}
          {range && (
            <>
              <input
                type="number"
                aria-label="Kwota"
                min={range.min}
                max={range.max}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />{' '}
              <button
                disabled={!Number.isInteger(amount) || amount < range.min || amount > range.max}
                onClick={() => onAction({ type: sizedAction, payload: { amount } })}
              >
                {sizedAction === 'bet' ? 'Postaw' : 'Podbij do'} {amount}
              </button>{' '}
            </>
          )}
          {legal.allIn !== null && (
            <button onClick={() => act('all_in')}>All-in ({legal.allIn})</button>
          )}
        </p>
      )}

      {state.lastHand && (
        <div>
          <h4>Poprzednie rozdanie ({state.lastHand.handNumber})</h4>
          {state.lastHand.reveals.map((r) => (
            <p key={r.playerId}>
              {names.get(r.playerId)}: {r.cards.map(cardLabel).join(' ')} ({r.handName})
            </p>
          ))}
          <p>
            Wypłaty:{' '}
            {state.lastHand.payouts.map((p) => `${names.get(p.playerId)} +${p.amount}`).join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}
