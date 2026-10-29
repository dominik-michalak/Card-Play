// The moderation service says that a user was banned; the socket layer closes their sockets.
// Neither knows the other, so they meet here (one instance, made by the composition root).
export function createBanEvents() {
  const listeners: ((userId: string) => void)[] = [];
  return {
    banned(userId: string): void {
      for (const listener of listeners) listener(userId);
    },
    onBanned(listener: (userId: string) => void): void {
      listeners.push(listener);
    },
  };
}

export type BanEvents = ReturnType<typeof createBanEvents>;
