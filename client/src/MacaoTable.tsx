import {
  MACAO_REQUESTABLE_RANKS,
  SUITS,
  type Card,
  type ClientMacaoState,
  type GameAction,
  type MacaoRequest,
  type Suit,
} from '@cardplay/shared';
import { useState, type CSSProperties } from 'react';
import { cardLabel, cardSpoken } from './cards';
import { useCountdown } from './hooks';
import { BackFan, Deck, PlayingCard } from './CardView';
import { Felt, Hud, Seat, Tag } from './TableParts';

const SUIT_NAMES: Record<Suit, string> = {
  clubs: 'trefl ♣',
  diamonds: 'karo ♦',
  hearts: 'kier ♥',
  spades: 'pik ♠',
};

type Props = {
  state: ClientMacaoState;
  meId: string;
  onAction: (action: GameAction) => void;
};

const sameCard = (a: Card, b: Card) => a.rank === b.rank && a.suit === b.suit;

function describeRequest(request: ClientMacaoState['request']): string | null {
  if (!request) return null;
  return 'rank' in request ? `Żądanie: ${request.rank}` : `Żądanie: ${SUIT_NAMES[request.suit]}`;
}

export function MacaoTable({ state, meId, onAction }: Props) {
  const secondsLeft = useCountdown(state.turnDeadlineAt);
  // a Jack or an Ace waits here until the player picks what to request
  const [choosing, setChoosing] = useState<Card | null>(null);
  const names = new Map(state.players.map((p) => [p.id, p.username]));
  const myTurn = state.currentPlayerId === meId;
  const eliminated = state.eliminatedIds.includes(meId);
  const penaltyText = state.penalty
    ? state.penalty.kind === 'draw'
      ? `Kara: dobierz ${state.penalty.amount}`
      : `Kara: pominięcie tur (${state.penalty.amount})`
    : null;

  // with two cards in hand, the one played leaves a single card: declare Macao
  const play = (card: Card, request?: MacaoRequest) => {
    setChoosing(null);
    onAction({
      type: 'play',
      payload: { card, request, declaredMacao: state.hand.length === 2 },
    });
  };

  const clickCard = (card: Card) => {
    if (card.rank === 'J' || card.rank === 'A') setChoosing(card);
    else play(card);
  };

  const status =
    secondsLeft === null
      ? 'Gra wstrzymana: czekamy na powrót gracza'
      : state.currentPlayerId === null
        ? ''
        : myTurn
          ? `Twój ruch, czas: ${secondsLeft} s`
          : `Ruch gracza ${names.get(state.currentPlayerId)}, czas: ${secondsLeft} s`;
  const others = state.players.filter((p) => p.id !== meId);
  const request = describeRequest(state.request);
  // a slightly different tilt per card, so the discard pile looks thrown, not stacked
  const tilt = (card: Card) => ((card.rank.charCodeAt(0) + card.suit.charCodeAt(0)) % 11) - 5;

  return (
    <div>
      <Hud title="Makao" secondsLeft={secondsLeft} status={status} />
      {eliminated && <p role="status">Odpadasz z gry (przekroczony czas lub rozłączenie).</p>}
      <Felt label="Stół do Makao">
        <div className="felt__row">
          {others.map((p) => (
            <Seat
              key={p.id}
              name={p.username}
              active={state.currentPlayerId === p.id}
              dimmed={state.eliminatedIds.includes(p.id)}
              badges={[
                state.eliminatedIds.includes(p.id) && 'odpadł',
                state.reportablePlayerId === p.id && 'nie zgłosił Makao',
              ]}
            >
              <BackFan count={state.handSizes[p.id] ?? 0} />
            </Seat>
          ))}
        </div>

        <div className="felt__center macao__center">
          <Deck count={state.drawPileCount} shuffleKey="start" label="Stos dobierania" />
          <div className="macao__discard">
            <PlayingCard
              key={cardLabel(state.topCard)}
              card={state.topCard}
              size="lg"
              deal
              from="bottom"
              rotate={tilt(state.topCard)}
            />
            <span className="macao__count">odrzucone: {state.discardCount}</span>
          </div>
          <div className="macao__tags">
            {penaltyText && <Tag>{penaltyText}</Tag>}
            {request && <Tag>{request}</Tag>}
            {state.drawnCard && <Tag>Dobrana karta: {cardLabel(state.drawnCard)}</Tag>}
          </div>
        </div>

        <div className="felt__row felt__row--me">
          <Seat name="Ty" me active={myTurn} dimmed={eliminated}>
            <div className="hand" role="group" aria-label="Twoja ręka">
              {state.hand.map((card, i) => {
                const playable = state.playable.some((p) => sameCard(p, card));
                return (
                  <button
                    key={`${card.rank}${card.suit}`}
                    className={`hand__card${playable ? ' is-playable' : ''}`}
                    aria-label={cardSpoken(card)}
                    onClick={() => clickCard(card)}
                    disabled={!playable}
                    style={{ '--i': i, '--n': state.hand.length } as CSSProperties}
                  >
                    <PlayingCard
                      card={card}
                      size="lg"
                      deal
                      from="top"
                      delay={Math.min(i, 6) * 40}
                    />
                  </button>
                );
              })}
            </div>
          </Seat>
        </div>
      </Felt>

      {choosing && (
        <div className="controls controls--choose">
          <p>
            {cardLabel(choosing)}: {choosing.rank === 'J' ? 'żądaj rangi' : 'żądaj koloru'}
          </p>
          {choosing.rank === 'J'
            ? MACAO_REQUESTABLE_RANKS.map((rank) => (
                <button className="btn" key={rank} onClick={() => play(choosing, { rank })}>
                  {rank}
                </button>
              ))
            : SUITS.map((suit) => (
                <button className="btn" key={suit} onClick={() => play(choosing, { suit })}>
                  {SUIT_NAMES[suit]}
                </button>
              ))}
          <button className="btn btn--ghost" onClick={() => setChoosing(null)}>
            Anuluj
          </button>
        </div>
      )}

      <div className="controls">
        {state.canDraw && (
          <button className="btn" onClick={() => onAction({ type: 'draw' })}>
            {state.penalty?.kind === 'draw' ? `Dobierz karę (${state.penalty.amount})` : 'Dobierz'}
          </button>
        )}
        {state.canPass && (
          <button className="btn" onClick={() => onAction({ type: 'pass' })}>
            {state.penalty?.kind === 'skip' ? 'Przyjmij pominięcie' : 'Zakończ turę'}
          </button>
        )}
        {state.reportablePlayerId && state.reportablePlayerId !== meId && !eliminated && (
          <button className="btn btn--danger" onClick={() => onAction({ type: 'report_macao' })}>
            Zgłoś brak Makao ({names.get(state.reportablePlayerId)})
          </button>
        )}
      </div>
    </div>
  );
}
