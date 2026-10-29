// ready flags and the start countdown of waiting rooms; memory only, gone after a restart
export function createLobbyState(countdownMs: number, onElapsed: (roomId: string) => void) {
  const ready = new Map<string, Set<string>>();
  const countdowns = new Map<string, { timer: NodeJS.Timeout; endsAt: number }>();

  function cancelCountdown(roomId: string): boolean {
    const countdown = countdowns.get(roomId);
    if (!countdown) {
      return false;
    }
    clearTimeout(countdown.timer);
    countdowns.delete(roomId);
    return true;
  }

  return {
    isReady: (roomId: string, userId: string): boolean => ready.get(roomId)?.has(userId) ?? false,

    setReady(roomId: string, userId: string, value: boolean): void {
      if (value) {
        ready.set(roomId, (ready.get(roomId) ?? new Set()).add(userId));
      } else {
        ready.get(roomId)?.delete(userId);
      }
    },

    // true when a new countdown started; a running one is left alone
    startCountdown(roomId: string): boolean {
      if (countdowns.has(roomId)) {
        return false;
      }
      const timer = setTimeout(() => {
        countdowns.delete(roomId);
        onElapsed(roomId);
      }, countdownMs);
      timer.unref();
      countdowns.set(roomId, { timer, endsAt: Date.now() + countdownMs });
      return true;
    },

    // true when a countdown was running
    cancelCountdown,

    endsAt: (roomId: string): number | null => countdowns.get(roomId)?.endsAt ?? null,

    clearRoom(roomId: string): void {
      cancelCountdown(roomId);
      ready.delete(roomId);
    },

    dispose(): void {
      for (const roomId of [...countdowns.keys()]) {
        cancelCountdown(roomId);
      }
      ready.clear();
    },
  };
}

export type LobbyState = ReturnType<typeof createLobbyState>;
