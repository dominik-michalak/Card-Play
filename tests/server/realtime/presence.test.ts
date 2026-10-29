import { describe, expect, it } from 'vitest';
import { createPresence } from '../../../server/src/realtime/presence';

describe('presence', () => {
  it('is online while at least one connection is open', () => {
    const presence = createPresence();
    expect(presence.isOnline('a')).toBe(false);

    presence.markOnline('a');
    presence.markOnline('a');
    presence.markOffline('a');
    expect(presence.isOnline('a')).toBe(true);

    presence.markOffline('a');
    expect(presence.isOnline('a')).toBe(false);
  });

  it('never goes below zero', () => {
    const presence = createPresence();
    presence.markOffline('ghost');
    presence.markOnline('ghost');
    expect(presence.isOnline('ghost')).toBe(true);
  });
});
