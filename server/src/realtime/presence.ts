// who has a live socket right now; counts connections, so a replaced one does not flicker
export function createPresence() {
  const connections = new Map<string, number>();
  return {
    markOnline(userId: string): void {
      connections.set(userId, (connections.get(userId) ?? 0) + 1);
    },
    markOffline(userId: string): void {
      const left = (connections.get(userId) ?? 0) - 1;
      if (left > 0) connections.set(userId, left);
      else connections.delete(userId);
    },
    isOnline: (userId: string): boolean => connections.has(userId),
  };
}

export type Presence = ReturnType<typeof createPresence>;
