import type { Room, ServerToClientEvents } from '@cardplay/shared';
import { useEffect, useReducer, useState } from 'react';
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
    const onError = (e: Payload<'error'>) => dispatch({ type: 'error', message: e.message });

    socket.on('connect', join);
    socket.on('room:players', onPlayers);
    socket.on('room:countdown', onCountdown);
    socket.on('game:state_update', onState);
    socket.on('game:finished', onFinished);
    socket.on('error', onError);
    if (socket.connected) join();
    return () => {
      socket.off('connect', join);
      socket.off('room:players', onPlayers);
      socket.off('room:countdown', onCountdown);
      socket.off('game:state_update', onState);
      socket.off('game:finished', onFinished);
      socket.off('error', onError);
    };
  }, [socket, room.id]);

  return { state, dismissError: () => dispatch({ type: 'dismiss_error' }) };
}
