import {
  MACAO_REQUESTABLE_RANKS,
  SUITS,
  type Card,
  type ClientMacaoState,
  type GameAction,
  type MacaoRequest,
  type Suit,
} from '@cardplay/shared';
import { useState } from 'react';
import { cardLabel, cardSpoken } from './cards';
import { useCountdown } from './hooks';

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

  return (
    <div>
      <h3>Makao</h3>
      <p>
        {secondsLeft === null
          ? 'Gra wstrzymana: czekamy na powrót gracza'
          : state.currentPlayerId === null
            ? ''
            : myTurn
              ? `Twój ruch, czas: ${secondsLeft} s`
              : `Ruch gracza ${names.get(state.currentPlayerId)}, czas: ${secondsLeft} s`}
      </p>
      {eliminated && <p>Odpadasz z gry (przekroczony czas lub rozłączenie).</p>}
      <table>
        <thead>
          <tr>
            <th>Gracz</th>
            <th>Karty</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {state.players.map((p) => (
            <tr key={p.id}>
              <td>{p.username}</td>
              <td>{state.handSizes[p.id]}</td>
              <td>
                {state.eliminatedIds.includes(p.id)
                  ? 'odpadł'
                  : state.currentPlayerId === p.id
                    ? 'ruch'
                    : ''}
                {state.reportablePlayerId === p.id && ' (nie zgłosił Makao)'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Wierzch stosu: <strong>{cardLabel(state.topCard)}</strong> (stos dobierania:{' '}
        {state.drawPileCount}, odrzucone: {state.discardCount})
      </p>
      {penaltyText && <p>{penaltyText}</p>}
      {describeRequest(state.request) && <p>{describeRequest(state.request)}</p>}
      {state.drawnCard && <p>Dobrana karta: {cardLabel(state.drawnCard)}</p>}

      <h4>Twoja ręka</h4>
      <p>
        {state.hand.map((card) => (
          <button
            key={`${card.rank}${card.suit}`}
            aria-label={cardSpoken(card)}
            onClick={() => clickCard(card)}
            disabled={!state.playable.some((p) => sameCard(p, card))}
          >
            {cardLabel(card)}
          </button>
        ))}
      </p>

      {choosing && (
        <div>
          <p>
            {cardLabel(choosing)}: {choosing.rank === 'J' ? 'żądaj rangi' : 'żądaj koloru'}
          </p>
          {choosing.rank === 'J'
            ? MACAO_REQUESTABLE_RANKS.map((rank) => (
                <button key={rank} onClick={() => play(choosing, { rank })}>
                  {rank}
                </button>
              ))
            : SUITS.map((suit) => (
                <button key={suit} onClick={() => play(choosing, { suit })}>
                  {SUIT_NAMES[suit]}
                </button>
              ))}{' '}
          <button onClick={() => setChoosing(null)}>Anuluj</button>
        </div>
      )}

      <p>
        {state.canDraw && (
          <button onClick={() => onAction({ type: 'draw' })}>
            {state.penalty?.kind === 'draw' ? `Dobierz karę (${state.penalty.amount})` : 'Dobierz'}
          </button>
        )}{' '}
        {state.canPass && (
          <button onClick={() => onAction({ type: 'pass' })}>
            {state.penalty?.kind === 'skip' ? 'Przyjmij pominięcie' : 'Zakończ turę'}
          </button>
        )}{' '}
        {state.reportablePlayerId && state.reportablePlayerId !== meId && !eliminated && (
          <button onClick={() => onAction({ type: 'report_macao' })}>
            Zgłoś brak Makao ({names.get(state.reportablePlayerId)})
          </button>
        )}
      </p>
    </div>
  );
}
