export const CHAT_MAX_LENGTH = 300;
export const CHAT_HISTORY_SIZE = 50;

// Characters that can only hide or reorder text: control characters, zero-width characters and
// the bidirectional overrides that make text read backwards.
const isInvisible = (codePoint: number): boolean =>
  codePoint < 0x20 ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2060 && codePoint <= 0x2064) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069) ||
  codePoint === 0xfeff;

// Plain text for a chat line: normalised, one line, no invisible characters, at most
// CHAT_MAX_LENGTH characters. Markup is left alone on purpose: the client shows text as text,
// so escaping it here as well would only show up as "&lt;" to the reader.
export function sanitizeChatMessage(raw: string): string {
  const flat = raw.normalize('NFC').replace(/[\n\r\t\v\f]/g, ' ');
  const visible = Array.from(flat)
    .filter((char) => !isInvisible(char.codePointAt(0)!))
    .join('');
  const tidy = visible.replace(/\s+/g, ' ').trim();
  return Array.from(tidy).slice(0, CHAT_MAX_LENGTH).join('').trim();
}

// at most `limit` messages per user in `windowMs`
export function createChatLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const sent = new Map<string, number[]>();
  return {
    // false when the user is writing too fast
    allow(userId: string): boolean {
      const recent = (sent.get(userId) ?? []).filter((t) => now() - t < windowMs);
      if (recent.length >= limit) {
        sent.set(userId, recent);
        return false;
      }
      sent.set(userId, [...recent, now()]);
      return true;
    },
    forget: (userId: string): void => {
      sent.delete(userId);
    },
  };
}
