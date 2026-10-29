import type { GameKey, MatchmakingMode, Room, ServerToClientEvents } from '@cardplay/shared';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { Api } from './api';
import { initialMatchmakingState, matchmakingReducer } from './matchmaking-state';
import type { RealtimeSocket } from './realtime';
import { initialRoomState, roomReducer } from './room-state';

type Payload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

// whole seconds left until an ISO time, null when there is no deadline
export function useCountdown(until: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? null : Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
}

// keeps one room in sync with the server and joins it again after every (re)connect
export function useRoomSession(socket: RealtimeSocket, room: Room) {
  const [state, dispatch] = useReducer(roomReducer, room, initialRoomState);

  useEffect(() => {
    const join = () => socket.emit('room:join', { roomId: room.id });
    const onPlayers = (p: Payload<'room:players'>) => dispatch({ type: 'players', ...p });
    const onCountdown = (p: Payload<'room:countdown'>) => dispatch({ type: 'countdown', ...p });
    const onState = (p: Payload<'game:state_update'>) => dispatch({ type: 'state', ...p });
    const onFinished = (p: Payload<'game:finished'>) => dispatch({ type: 'finished', ...p });
    const onChat = (line: Payload<'room:chat'>) => dispatch({ type: 'chat', line });
    const onError = (e: Payload<'error'>) => dispatch({ type: 'error', message: e.message });

    socket.on('connect', join);
    socket.on('room:chat', onChat);
    socket.on('room:players', onPlayers);
    socket.on('room:countdown', onCountdown);
    socket.on('game:state_update', onState);
    socket.on('game:finished', onFinished);
    socket.on('error', onError);
    if (socket.connected) join();
    return () => {
      socket.off('connect', join);
      socket.off('room:chat', onChat);
      socket.off('room:players', onPlayers);
      socket.off('room:countdown', onCountdown);
      socket.off('game:state_update', onState);
      socket.off('game:finished', onFinished);
      socket.off('error', onError);
    };
  }, [socket, room.id]);

  return { state, dismissError: () => dispatch({ type: 'dismiss_error' }) };
}

// the matchmaking queue of the lobby; a found match is fetched and handed to `onFound`
export function useMatchmaking(socket: RealtimeSocket, api: Api, onFound: (room: Room) => void) {
  const [state, dispatch] = useReducer(matchmakingReducer, initialMatchmakingState);
  const foundRef = useRef(onFound);
  foundRef.current = onFound;

  useEffect(() => {
    const onStatus = (status: Payload<'matchmaking:status'>) =>
      dispatch({ type: 'status', status });
    const onMatch = () => {
      dispatch({ type: 'found' });
      api.currentRoom().then(
        (room) => room && foundRef.current(room),
        () => dispatch({ type: 'error', message: 'Nie udało się pobrać pokoju meczu' }),
      );
    };
    const onError = (e: Payload<'error'>) => dispatch({ type: 'error', message: e.message });

    socket.on('matchmaking:status', onStatus);
    socket.on('matchmaking:found', onMatch);
    socket.on('error', onError);
    return () => {
      socket.off('matchmaking:status', onStatus);
      socket.off('matchmaking:found', onMatch);
      socket.off('error', onError);
      // leaving the lobby ends the search, so a room opened meanwhile cannot break a match
      socket.emit('matchmaking:leave');
    };
  }, [socket, api]);

  return {
    state,
    join: (gameType: GameKey, mode: MatchmakingMode) =>
      socket.emit('matchmaking:join', { gameType, mode }),
    leave: () => socket.emit('matchmaking:leave'),
    dismiss: () => dispatch({ type: 'dismiss' }),
  };
}
