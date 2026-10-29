import type {
  ClientMacaoState,
  ClientWarState,
  GameAction,
  GameResult,
  Room,
} from '@cardplay/shared';
import { useState } from 'react';
import { ApiError, type Api, type SessionUser } from './api';
import { useCountdown, useRoomSession } from './hooks';
import { matchModeLabel } from './matchmaking-state';
import type { RealtimeSocket } from './realtime';
import { MacaoTable } from './MacaoTable';
import { WarTable } from './WarTable';

const REASONS: Record<string, string> = {
  all_cards: 'zebrane wszystkie karty',
  round_limit: 'limit rund',
  turn_limit: 'limit tur (wygrywa najmniej kart)',
  timeout_forfeit: 'przekroczony czas ruchu',
  disconnect_forfeit: 'rozłączenie',
  double_timeout: 'obaj gracze przekroczyli czas',
  draw: 'remis',
  cancelled: 'mecz anulowany',
  completed: 'zakończony',
};

type Props = {
  api: Api;
  socket: RealtimeSocket;
  user: SessionUser;
  room: Room;
  onLeft: () => void;
};

export function RoomScreen({ api, socket, user, room, onLeft }: Props) {
  const { state, dismissError } = useRoomSession(socket, room);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const secondsToStart = useCountdown(state.startsAt);
  const me = state.players.find((p) => p.userId === user.id);
  const inGame = state.game !== null && state.finished === null;

  async function leave() {
    setLeaveError(null);
    try {
      await api.leaveRoom(room.id);
      onLeft();
    } catch (e) {
      setLeaveError(e instanceof ApiError ? e.message : 'Nie udało się wyjść');
    }
  }

  const send = (action: GameAction) => socket.emit('game:action', { roomId: room.id, action });
  const flip = () => send({ type: 'flip' });
  const nameOf = (id: string) => state.game?.players.find((p) => p.id === id)?.username ?? id;

  return (
    <div>
      <h2>Pokój ({matchModeLabel(room.mode)})</h2>
      {room.inviteCode && (
        <p>
          Kod zaproszenia: <strong>{room.inviteCode}</strong>
        </p>
      )}
      {(state.error || leaveError) && (
        <p role="alert">
          {state.error ?? leaveError}{' '}
          <button
            onClick={() => {
              dismissError();
              setLeaveError(null);
            }}
          >
            OK
          </button>
        </p>
      )}

      {state.finished ? (
        <div>
          <h3>Koniec gry</h3>
          <ResultSummary result={state.finished.result} nameOf={nameOf} />
          {state.finished.ratings.map((r) => (
            <p key={r.userId}>
              {nameOf(r.userId)}: Elo {r.eloBefore} → {r.eloBefore + r.eloChange} (
              {r.eloChange > 0 ? '+' : ''}
              {r.eloChange})
            </p>
          ))}
          <button onClick={onLeft}>Wróć do lobby</button>
        </div>
      ) : inGame && state.game?.gameKey === 'war' ? (
        <WarTable state={state.game as ClientWarState} meId={user.id} onFlip={flip} />
      ) : inGame && state.game?.gameKey === 'macao' ? (
        <MacaoTable state={state.game as ClientMacaoState} meId={user.id} onAction={send} />
      ) : (
        <div>
          <table>
            <thead>
              <tr>
                <th>Miejsce</th>
                <th>Gracz</th>
                <th>Gotowość</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: room.targetPlayers }, (_, seat) => {
                const player = state.players.find((p) => p.seatIndex === seat);
                // the bot takes the seat that no human will
                const botSeat = room.mode === 'bot' && seat === room.targetPlayers - 1;
                return (
                  <tr key={seat}>
                    <td>{seat + 1}</td>
                    <td>
                      {player ? (
                        player.username
                      ) : botSeat ? (
                        'Bot'
                      ) : room.mode !== 'private' ? (
                        ''
                      ) : (
                        <button
                          onClick={() =>
                            socket.emit('room:seat', { roomId: room.id, seatIndex: seat })
                          }
                        >
                          Zajmij miejsce
                        </button>
                      )}
                    </td>
                    <td>{player ? (player.ready ? 'gotowy' : 'nie') : botSeat ? 'gotowy' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {secondsToStart !== null && <p>Start za {secondsToStart} s</p>}
          {room.mode === 'private' ? (
            <>
              <button
                onClick={() => socket.emit('room:ready', { roomId: room.id, ready: !me?.ready })}
                disabled={!me}
              >
                {me?.ready ? 'Cofnij gotowość' : 'Gotowy'}
              </button>{' '}
            </>
          ) : (
            <p>Gra zacznie się automatycznie, gdy wszyscy będą w pokoju.</p>
          )}
          <button onClick={() => void leave()}>Wyjdź z pokoju</button>
        </div>
      )}
    </div>
  );
}

function ResultSummary({ result, nameOf }: { result: GameResult; nameOf: (id: string) => string }) {
  const winners = result.placements.filter((p) => p.rank === 1);
  const text =
    result.terminationReason === 'cancelled' || winners.length !== 1
      ? 'Bez zwycięzcy'
      : `Wygrywa ${nameOf(winners[0]!.playerId)}`;
  return (
    <p>
      {text} ({REASONS[result.terminationReason] ?? result.terminationReason})
    </p>
  );
}
