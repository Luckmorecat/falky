import { describe, expect, it } from 'vitest';
import type { Message } from '../api/client';
import { buildFeed, canPost, countUnread, dayLabel, mergeMessages, splitLinks } from './timeline';

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  roomId: 'r',
  authorId: 'a',
  authorName: 'Bob',
  body: 'hi',
  createdAt: '2026-11-05T12:00:00.000Z',
  ...over,
});
const now = new Date('2026-11-05T15:00:00.000Z');

describe('mergeMessages', () => {
  it('keeps one message per ID, in order, when a live event repeats a catch-up', () => {
    const merged = mergeMessages([msg('02'), msg('04')], [msg('03'), msg('04'), msg('01')]);
    expect(merged.map((m) => m.id)).toEqual(['01', '02', '03', '04']);
  });
});

describe('countUnread', () => {
  it('counts only later messages from others', () => {
    const list = [msg('01', { authorId: 'b' }), msg('02', { authorId: 'b' }), msg('03', { authorId: 'me' }), msg('04', { authorId: 'b' })];
    expect(countUnread(list, '01', 'me')).toBe(2);
    expect(countUnread(list, null, 'me')).toBe(3);
  });
});

describe('dayLabel', () => {
  it('names today and yesterday', () => {
    expect(dayLabel(new Date(2026, 10, 5, 1).toISOString(), new Date(2026, 10, 5, 22))).toBe('Сьогодні');
    expect(dayLabel('2026-11-04T12:00:00.000Z', now)).toBe('Вчора');
    expect(dayLabel('2026-10-01T12:00:00.000Z', now)).toContain('жовтня');
  });
});

describe('buildFeed', () => {
  const kinds = (items: ReturnType<typeof buildFeed>) => items.map((i) => i.kind);

  it('groups an author until someone else or a new name interrupts', () => {
    const items = buildFeed({
      messages: [msg('01'), msg('02'), msg('03', { authorId: 'b', authorName: 'Ann' }), msg('04'), msg('05', { authorName: 'Bobby' })],
      pending: [],
    }, 'me', null, now).filter((i) => i.kind === 'message');
    expect(items.map((i) => i.kind === 'message' && i.continued)).toEqual([false, true, false, false, false]);
  });

  it('starts a new group after a long pause', () => {
    const items = buildFeed({ messages: [msg('01'), msg('02', { createdAt: '2026-11-05T12:06:00.000Z' })], pending: [] }, 'me', null, now);
    expect(items.filter((i) => i.kind === 'message').map((i) => i.kind === 'message' && i.continued)).toEqual([false, false]);
  });

  it('puts the new-messages line once, before the first unread', () => {
    const items = buildFeed({ messages: [msg('01'), msg('02'), msg('03')], pending: [] }, 'me', '01', now);
    expect(kinds(items)).toEqual(['day', 'message', 'new', 'message', 'message']);
  });

  it('separates days and shows pending messages last', () => {
    const items = buildFeed({
      messages: [msg('01', { createdAt: '2026-11-04T12:00:00.000Z' }), msg('02')],
      pending: [{ requestKey: 'k', roomId: 'r', body: 'x', failed: false, reason: '' }],
    }, 'a', null, now);
    expect(kinds(items)).toEqual(['day', 'message', 'day', 'message', 'pending']);
  });
});

describe('splitLinks', () => {
  it('links http and https only, leaving closing punctuation out', () => {
    expect(splitLinks('see https://a.example/x, then')).toEqual([
      { text: 'see ' },
      { text: 'https://a.example/x', href: 'https://a.example/x' },
      { text: ', then' },
    ]);
    expect(splitLinks('javascript:alert(1) ftp://x')).toEqual([{ text: 'javascript:alert(1) ftp://x' }]);
  });

  it('keeps a bracket the link itself opened', () => {
    const url = 'https://en.wikipedia.org/wiki/Falco_(genus)';
    expect(splitLinks(url)).toEqual([{ text: url, href: url }]);
    expect(splitLinks('(https://a.example)')).toEqual([{ text: '(' }, { text: 'https://a.example', href: 'https://a.example' }, { text: ')' }]);
  });

  it('loses no text', () => {
    const text = 'a https://x.example b https://y.example. c';
    expect(splitLinks(text).map((p) => p.text).join('')).toBe(text);
  });
});

describe('canPost', () => {
  it('follows the server rules: no blank body, at most 4000 characters', () => {
    expect(canPost('  \n ')).toBe(false);
    expect(canPost('x')).toBe(true);
    expect(canPost('😀'.repeat(4000))).toBe(true);
    expect(canPost('x'.repeat(4001))).toBe(false);
  });
});
