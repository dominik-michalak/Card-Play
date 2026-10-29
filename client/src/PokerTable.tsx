import type { ClientPokerState, GameAction } from '@cardplay/shared';
import { useEffect, useState } from 'react';
import { cardLabel } from './cards';
import { useCountdown } from './hooks';
import { GAME_LABELS } from './labels';
import { BackFan, Deck, PeekCard, PlayingCard } from './CardView';
import { Chips, Felt, Hud, Seat } from './TableParts';

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

  const status =
    secondsLeft === null
      ? 'Gra wstrzymana: czekamy na powrót gracza'
      : state.currentPlayerId === null
        ? ''
        : myTurn
          ? `Twój ruch, czas: ${secondsLeft} s`
          : `Ruch gracza ${names.get(state.currentPlayerId)}, czas: ${secondsLeft} s`;
  const mySeat = state.seats.find((s) => s.playerId === meId);
  // opponents in table order, starting with the one who sits after me
  const myIndex = state.seats.findIndex((s) => s.playerId === meId);
  const others = [...state.seats.slice(myIndex + 1), ...state.seats.slice(0, Math.max(myIndex, 0))];
  const flags = (seat: (typeof state.seats)[number]) => [
    seat.isButton && 'BTN',
    seat.isSmallBlind && 'SB',
    seat.isBigBlind && 'BB',
    seat.out && 'odpadł',
    !seat.out && seat.folded && 'pas',
    seat.allIn && 'all-in',
  ];

  return (
    <div>
      <Hud
        title={GAME_LABELS[state.gameKey]}
        detail={`rozdanie ${state.handNumber} (${STREETS[state.street]}), blindy ${state.smallBlind}/${state.bigBlind}`}
        secondsLeft={secondsLeft}
        status={status}
      />
      <Felt label={`Stół: ${GAME_LABELS[state.gameKey]}`}>
        <div className="felt__row">
          {others.map((seat) => (
            <Seat
              key={seat.playerId}
              name={names.get(seat.playerId) ?? ''}
              active={state.currentPlayerId === seat.playerId}
              dimmed={seat.folded || seat.out}
              badges={flags(seat)}
            >
              {!seat.out && !seat.folded && <BackFan count={2} size="xs" key={state.handNumber} />}
              <span className="seat__money">
                <Chips amount={seat.stack} label="Żetony" />
                {seat.bet > 0 && <Chips amount={seat.bet} label="Stawka" />}
              </span>
            </Seat>
          ))}
        </div>

        <div className="felt__center poker__center">
          <Deck count={52} shuffleKey={state.handNumber} size="sm" label="Talia" />
          <div className="poker__board" aria-label="Karty na stole">
            {state.board.length === 0 && <span className="poker__empty">stół jest pusty</span>}
            {state.board.map((c, i) => (
              <PlayingCard
                key={cardLabel(c)}
                card={c}
                size="lg"
                deal
                from="left"
                // the flop falls together, the turn and river come on their own
                delay={state.board.length <= 3 ? i * 110 : 0}
              />
            ))}
          </div>
          <p className="poker__pot">
            <Chips amount={state.pot} label="Pula" />
            {state.pots.length > 1 && (
              <span className="poker__sides">
                {state.pots
                  .map((p, i) => `${i === 0 ? 'główna' : `boczna ${i}`}: ${p.amount}`)
                  .join(', ')}
              </span>
            )}
          </p>
        </div>

        <div className="felt__row felt__row--me">
          {mySeat && (
            <Seat
              name="Ty"
              me
              active={myTurn}
              dimmed={mySeat.folded || mySeat.out}
              badges={flags(mySeat)}
            >
              <div className="hole" key={state.handNumber}>
                {state.hole.length === 0 ? (
                  <span className="poker__empty">Pasujesz w tym rozdaniu</span>
                ) : (
                  state.hole.map((c, i) => <PeekCard key={cardLabel(c)} card={c} delay={i * 140} />)
                )}
              </div>
              <span className="seat__money">
                <Chips amount={mySeat.stack} label="Żetony" />
                {mySeat.bet > 0 && <Chips amount={mySeat.bet} label="Stawka" />}
              </span>
            </Seat>
          )}
        </div>
      </Felt>

      {legal && (
        <div className="controls">
          <button className="btn btn--danger" onClick={() => act('fold')}>
            Pas
          </button>
          {legal.canCheck && (
            <button className="btn" onClick={() => act('check')}>
              Czekaj
            </button>
          )}
          {legal.call !== null && (
            <button className="btn" onClick={() => act('call')}>
              Wyrównaj ({legal.call})
            </button>
          )}
          {range && (
            <>
              <input
                type="number"
                aria-label="Kwota"
                min={range.min}
                max={range.max}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
              <button
                className="btn btn--primary"
                disabled={!Number.isInteger(amount) || amount < range.min || amount > range.max}
                onClick={() => onAction({ type: sizedAction, payload: { amount } })}
              >
                {sizedAction === 'bet' ? 'Postaw' : 'Podbij do'} {amount}
              </button>
            </>
          )}
          {legal.allIn !== null && (
            <button className="btn" onClick={() => act('all_in')}>
              All-in ({legal.allIn})
            </button>
          )}
        </div>
      )}

      {state.lastHand && (
        <div className="lasthand">
          <h4>Poprzednie rozdanie ({state.lastHand.handNumber})</h4>
          {state.lastHand.reveals.map((r) => (
            <div key={r.playerId} className="lasthand__row">
              <span className="lasthand__cards">
                {r.cards.map((c) => (
                  <PlayingCard key={cardLabel(c)} card={c} size="xs" />
                ))}
              </span>
              <span>
                {names.get(r.playerId)}: {r.cards.map(cardLabel).join(' ')} ({r.handName})
              </span>
            </div>
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
