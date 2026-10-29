import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_LENGTH,
  createChatLimiter,
  sanitizeChatMessage,
} from '../../../server/src/realtime/chat';

describe('sanitizeChatMessage', () => {
  it('leaves an ordinary line alone', () => {
    expect(sanitizeChatMessage('Dobra gra, Zażółć gęślą jaźń! 👍')).toBe(
      'Dobra gra, Zażółć gęślą jaźń! 👍',
    );
  });

  it('puts the text on one line and collapses spaces', () => {
    expect(sanitizeChatMessage('  one\n\ntwo\tthree   four \r\n')).toBe('one two three four');
  });

  it.each([
    ['control characters', 'a\u0000b\u0007c\u001bd\u007fe'],
    ['zero-width characters', 'a​b‌c‍d﻿e'],
    ['bidirectional overrides', 'a‮b‪c⁦d⁩e'],
  ])('removes %s', (_name, raw) => {
    expect(sanitizeChatMessage(raw)).toBe('abcde');
  });

  it('keeps markup as plain text for the client to show, not to run', () => {
    expect(sanitizeChatMessage('<img src=x onerror=alert(1)> & "x"')).toBe(
      '<img src=x onerror=alert(1)> & "x"',
    );
  });

  it('normalises composed and decomposed characters to one form', () => {
    expect(sanitizeChatMessage('é')).toBe('é');
  });

  it('cuts a long message at 300 characters, not in the middle of an emoji', () => {
    const long = '😀'.repeat(400);
    const cut = sanitizeChatMessage(long);
    expect(Array.from(cut)).toHaveLength(CHAT_MAX_LENGTH);
    expect(cut).toBe('😀'.repeat(CHAT_MAX_LENGTH));
  });

  it('answers an empty string when nothing visible is left', () => {
    expect(sanitizeChatMessage('   ​\n‮  ')).toBe('');
  });
});

describe('createChatLimiter', () => {
  it('allows a burst up to the limit, then refuses until the window moves on', () => {
    let time = 0;
    const limiter = createChatLimiter(3, 10_000, () => time);
    expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
    expect(limiter.allow('b')).toBe(true);
    time = 10_001;
    expect(limiter.allow('a')).toBe(true);
  });
});
