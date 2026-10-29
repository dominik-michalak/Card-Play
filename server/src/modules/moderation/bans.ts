import type { BanState } from '@cardplay/shared';

type BanFields = { isBanned: boolean; bannedUntil: Date | null };

// A permanent ban is a flag; a temporary one ends by itself when `bannedUntil` has passed.
export function banState(user: BanFields, now = new Date()): BanState {
  const temporary = user.bannedUntil !== null && user.bannedUntil.getTime() > now.getTime();
  return {
    active: user.isBanned || temporary,
    permanent: user.isBanned,
    until: !user.isBanned && temporary ? user.bannedUntil!.toISOString() : null,
  };
}

export const isBanned = (user: BanFields, now = new Date()): boolean => banState(user, now).active;
