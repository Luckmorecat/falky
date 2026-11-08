import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, Room } from '../api/client';
import { discardMessage, loadOlder, markLatestRead, postMessage, retryMessage, setChatOpen } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { getState, useApp } from '../app/store';
import { atBottom, followingLatest, rememberedPlace, rememberPlace, scrollToAnchor, sliceRange, stack, type Anchor } from '../chat/place';
import { buildFeed, canPost, MESSAGE_MAX, messageLength, type FeedItem, type PendingMessage, splitLinks } from '../chat/timeline';
import { assignPalettes, paletteOf, type PaletteName, paletteStyle } from '../fx/palette';
import { t } from '../strings';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { usePeople } from './Stage';
import { useDrawerLayout } from './useDrawerLayout';

function afterPaint(fn: () => void): () => void {
  let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(fn); });
  return () => cancelAnimationFrame(frame);
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

type FeedRow = FeedItem | { kind: 'loading'; key: 'loading' };

/** Rough height until the row is measured. Close enough that prepending history does not jump. */
function estimateHeight(row: FeedRow): number {
  if (row.kind === 'loading' || row.kind === 'day') return 36;
  if (row.kind === 'new') return 33;
  const text = row.kind === 'message' ? row.message.body : row.pending.body;
  const lines = Math.max(1, Math.ceil(text.length / 36));
  const head = row.continued ? 3 : 36;
  return head + lines * 20 + (row.kind === 'pending' ? 22 : 0);
}

const leadOf = (rows: FeedRow[], index: number) => {
  const prev = rows[index - 1];
  return prev?.kind === 'day' || prev?.kind === 'new';
};

/** The message under the feed's top edge, measured from the screen so the text — not a day line — is what we keep. */
function textAnchor(el: HTMLElement): Anchor | null {
  const edge = el.getBoundingClientRect().top;
  const row = [...el.querySelectorAll<HTMLElement>('[data-row]')].find((node) => {
    const text = node.querySelector('.msg-text');
    return !!text && text.getBoundingClientRect().bottom > edge + 2;
  });
  const text = row?.querySelector<HTMLElement>('.msg-text');
  const key = row?.dataset.row;
  if (!row || !text || !key) return null;
  const rowTop = row.getBoundingClientRect().top;
  return { key, offset: rowTop - edge, pad: text.getBoundingClientRect().top - rowTop };
}

function Body({ text }: { text: string }) {
  return (
    <div className="msg-text">
      {splitLinks(text).map((p, i) => (p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a> : <span key={i}>{p.text}</span>))}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, continued, lead, palette }: { message: Message; continued: boolean; lead: boolean; palette: PaletteName }) {
  return (
    <article className={`msg${continued ? ' cont' : ''}${lead ? ' lead' : ''}`} style={paletteStyle(palette)}>
      {!continued && (
        <div className="msg-meta">
          <span className="msg-author">{message.authorName}</span>
          <time className="msg-time" dateTime={message.createdAt}>{timeOf(message.createdAt)}</time>
        </div>
      )}
      <Body text={message.body} />
    </article>
  );
});

function PendingRow({ pending, continued, lead, name, palette }: { pending: PendingMessage; continued: boolean; lead: boolean; name: string; palette: PaletteName }) {
  return (
    <article className={`msg pending${continued ? ' cont' : ''}${lead ? ' lead' : ''}`} style={paletteStyle(palette)}>
      {!continued && <div className="msg-meta"><span className="msg-author">{name}</span></div>}
      <Body text={pending.body} />
      <div className={`msg-state${pending.failed ? ' err' : ''}`}>
        {pending.failed ? (
          <>
            <span role="alert">{pending.reason}</span>
            <button onClick={() => retryMessage(pending)}>{t.retry}</button>
            <button onClick={() => discardMessage(pending)}>{t.discard}</button>
          </>
        ) : t.sending}
      </div>
    </article>
  );
}

/**
 * Always on the page, mostly past its right edge, with the start of its lines
 * showing and blurring away. A mouse anywhere over the strip it comes into, or
 * focus in it, brings it in; only then does it count as read. It has no
 * background and nothing else moves, so the page's dots stay and the interface
 * keeps out of its way for good. The strip itself stands still, so the chat
 * sliding under the mouse cannot make it flicker. On a phone there is no hover,
 * so it opens over the page by a button.
 */
export function Chat({ room }: { room: Room | null }) {
  const open = useApp((s) => s.chatOpen);
  const lang = useApp((s) => s.settings.language);
  const unread = useApp((s) => (s.viewedRoomId ? (s.chats[s.viewedRoomId]?.unread ?? 0) : 0));
  const drawer = useDrawerLayout();
  const aside = useRef<HTMLElement>(null);
  const hovering = useRef(false);
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Someone wrote while the chat is back: it shows itself for a moment. */
  const [nudged, setNudged] = useState(false);
  const lastSeen = useRef<{ roomId?: string; messageId?: string }>({});
  const chat = useApp((s) => (room ? s.chats[room.id] : undefined));
  const newAfterId = useApp((s) => s.newAfterId);
  const visitor = useApp((s) => s.visitor);
  const people = usePeople(room);
  const ownColor = useApp((s) => s.ownColor);
  const selfId = visitor?.id ?? '';
  const messages = chat?.messages;
  // The same colours as the avatars on the stage, and no two alike among those who write.
  const palettes = useMemo(
    () => assignPalettes(people.map((p) => p.id), ownColor ? { id: selfId, palette: ownColor } : undefined, [...(messages ?? []).map((m) => m.authorId), selfId]),
    [people, ownColor, selfId, messages],
  );
  const paletteFor = (id: string) => palettes.get(id) ?? paletteOf(id);
  const feed = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const scrollRef = useRef(0);
  /** Older pages wait until the saved place has been applied, so the first paint at the top does not fetch them. */
  const placed = useRef(false);
  const placedRoom = useRef<string | null>(null);
  const adjusting = useRef(false);
  const [scrollPos, setScrollPos] = useState(0);
  const [measured, setMeasured] = useState(0);
  const [frame, setFrame] = useState({ width: 0, height: 0, top: 28, bottom: 12 });
  const [atBottomNow, setAtBottomNow] = useState(() => !room || followingLatest(room.id));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = useRef<HTMLTextAreaElement>(null);
  const announced = useRef('');
  const [live, setLive] = useState('');

  const draft = room ? (drafts[room.id] ?? '') : '';
  const items = useMemo(() => (chat ? buildFeed(chat, visitor?.id, newAfterId) : []), [chat, visitor?.id, newAfterId, lang]);
  const rows = useMemo<FeedRow[]>(() => {
    const list: FeedRow[] = [];
    if (chat?.loadingOlder) list.push({ kind: 'loading', key: 'loading' });
    list.push(...items);
    return list;
  }, [chat?.loadingOlder, items]);
  const count = messageLength(draft);
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const heightsNow = rows.map((row) => heights.current.get(row.key) ?? estimateHeight(row));
  const laid = stack(heightsNow, frame.top, frame.bottom, frame.height);
  const visible = sliceRange(laid.tops, scrollPos, frame.height);
  const topGap = laid.tops[visible.start] ?? 0;
  const bottomGap = Math.max(0, laid.scrollHeight - (laid.tops[visible.end] ?? laid.scrollHeight));

  const note = (el: HTMLDivElement) => {
    if (!room) return;
    const top = el.scrollTop;
    const bottom = atBottom(top, el.scrollHeight, el.clientHeight);
    const anchor = bottom ? null : textAnchor(el);
    const was = followingLatest(room.id);
    rememberPlace(room.id, { following: bottom, anchor });
    setAtBottomNow(bottom);
    if (bottom && !was) markLatestRead(room.id);
  };

  useLayoutEffect(() => {
    const el = feed.current;
    if (!el || !room || (drawer && !open)) return;
    const measure = () => {
      if (placedRoom.current !== room.id) {
        placedRoom.current = room.id;
        placed.current = false;
      }
      const style = getComputedStyle(el);
      const top = Number.parseFloat(style.getPropertyValue('--feed-top')) || 28;
      const bottomInset = Number.parseFloat(style.getPropertyValue('--feed-bottom')) || 12;
      const height = el.clientHeight;
      const width = el.clientWidth;
      if (height !== frame.height || width !== frame.width || top !== frame.top || bottomInset !== frame.bottom) {
        setFrame({ width, height, top, bottom: bottomInset });
        return;
      }
      let changed = false;
      for (const node of el.querySelectorAll<HTMLElement>('[data-row]')) {
        const key = node.dataset.row;
        if (!key) continue;
        const heightOf = Math.round(node.getBoundingClientRect().height * 10) / 10;
        if (heightOf > 0 && heights.current.get(key) !== heightOf) {
          heights.current.set(key, heightOf);
          changed = true;
        }
      }
      if (changed) {
        setMeasured((n) => n + 1);
        return;
      }
      const place = rememberedPlace(room.id) ?? { following: true, anchor: null };
      const max = Math.max(0, laid.scrollHeight - height);
      const next = place.following ? max : place.anchor ? scrollToAnchor(keys, laid.tops, place.anchor, max) : null;
      setAtBottomNow((prev) => (prev === place.following ? prev : place.following));
      placed.current = true;
      let kept = el.scrollTop;
      if (next !== null && Math.abs(kept - next) > 1) {
        adjusting.current = true;
        el.scrollTop = next;
        adjusting.current = false;
        kept = el.scrollTop;
      }
      // The row top is back. If the text inside it gained padding, move by that so the line stays.
      const anchor = !place.following ? place.anchor : null;
      if (anchor?.pad !== undefined) {
        const row = el.querySelector<HTMLElement>(`[data-row="${anchor.key}"]`);
        const text = row?.querySelector<HTMLElement>('.msg-text');
        if (row && text) {
          const delta = text.getBoundingClientRect().top - row.getBoundingClientRect().top - anchor.pad;
          if (Math.abs(delta) > 1) {
            adjusting.current = true;
            el.scrollTop += delta;
            adjusting.current = false;
            kept = el.scrollTop;
            rememberPlace(room.id, { following: false, anchor: { key: anchor.key, offset: anchor.offset - delta, pad: anchor.pad + delta } });
          }
        }
      }
      if (Math.abs(scrollRef.current - kept) > 0.5) {
        scrollRef.current = kept;
        setScrollPos((prev) => (Math.abs(prev - kept) < 0.5 ? prev : kept));
      }
    };
    if (open) measure();
    else return afterPaint(measure);
  }, [rows, frame, measured, room?.id, open, drawer, keys, laid.scrollHeight, visible.start, visible.end]);

  useEffect(() => {
    const el = feed.current;
    if (!el || (drawer && !open)) return;
    let cancel: (() => void) | undefined;
    const measure = () => {
      const style = getComputedStyle(el);
      const top = Number.parseFloat(style.getPropertyValue('--feed-top')) || 28;
      const bottom = Number.parseFloat(style.getPropertyValue('--feed-bottom')) || 12;
      const height = el.clientHeight;
      const width = el.clientWidth;
      setFrame((prev) => (prev.width === width && prev.height === height && prev.top === top && prev.bottom === bottom ? prev : { width, height, top, bottom }));
    };
    const watch = new ResizeObserver(() => {
      cancel?.();
      if (open) measure();
      else cancel = afterPaint(measure);
    });
    watch.observe(el);
    return () => { watch.disconnect(); cancel?.(); };
  }, [room?.id, open, drawer]);

  useEffect(() => {
    if (open && drawer && matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  }, [open, room?.id, drawer]);

  const newest = chat?.messages.at(-1);
  useEffect(() => {
    const before = lastSeen.current;
    lastSeen.current = { roomId: room?.id, messageId: newest?.id };
    if (open || before.roomId !== room?.id) {
      setNudged(false);
      return;
    }
    // The first page of history is not news.
    if (!newest || !before.messageId || before.messageId === newest.id || newest.authorId === visitor?.id) return;
    setNudged(true);
    const id = setTimeout(() => setNudged(false), 4000);
    return () => clearTimeout(id);
  }, [room?.id, newest?.id, newest?.authorId, open, visitor?.id]);

  useEffect(() => () => {
    if (settling.current) clearTimeout(settling.current);
  }, []);

  /** Forward at once when wanted; back only after a moment, so a passing mouse does no harm. */
  const settle = () => {
    if (drawer) return;
    if (settling.current) clearTimeout(settling.current);
    const wanted = () => hovering.current || !!aside.current?.contains(document.activeElement);
    if (wanted()) {
      if (!getState().chatOpen) setChatOpen(true);
      return;
    }
    settling.current = setTimeout(() => {
      if (!wanted() && getState().chatOpen) setChatOpen(false);
    }, 280);
  };

  const onScroll = () => {
    const el = feed.current;
    if (!el || !room || (drawer && !open)) return;
    const top = el.scrollTop;
    if (Math.abs(scrollRef.current - top) <= 0.5) return;
    scrollRef.current = top;
    setScrollPos((prev) => (Math.abs(prev - top) < 0.5 ? prev : top));
    if (!adjusting.current) note(el);
    if (placed.current && top < 120 && chat?.hasOlder && !chat.loadingOlder) void loadOlder(room.id);
  };

  const followBottom = () => {
    if (!room) return;
    rememberPlace(room.id, { following: true, anchor: null });
    setAtBottomNow(true);
    const el = feed.current;
    if (!el) return;
    const next = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = next;
    scrollRef.current = next;
    setScrollPos(next);
    markLatestRead(room.id);
  };

  const setDraft = (value: string) => {
    if (room) setDrafts((d) => ({ ...d, [room.id]: value }));
  };

  const send = () => {
    if (!room || !canPost(draft)) return;
    rememberPlace(room.id, { following: true, anchor: null });
    postMessage(room.id, draft);
    setDraft('');
    setAtBottomNow(true);
  };

  useEffect(() => {
    announced.current = '';
    setLive('');
  }, [room?.id]);

  useEffect(() => {
    const id = newest?.id ?? '';
    if (!open || !id || id === announced.current) return;
    const first = announced.current === '';
    announced.current = id;
    if (!first && newest) setLive(`${newest.authorName}: ${newest.body}`);
  }, [open, newest, room?.id]);

  return (
    <div
      className={`chat-strip${nudged ? ' nudge' : ''}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        hovering.current = true;
        settle();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        hovering.current = false;
        settle();
      }}
    >
    <aside
      ref={aside}
      className="chat"
      aria-label={t.chat}
      {...(drawer && !open ? { inert: true } : {})}
      onFocus={settle}
      onBlur={settle}
    >
      <div className="live-msg" aria-live="polite">{live}</div>
      <div className="feed" ref={feed} onScroll={onScroll}>
        {chat?.loaded && !rows.length && (
          <div className="empty-chat"><strong>{t.emptyChatTitle}</strong>{t.emptyChatBody}</div>
        )}
        {rows.length > 0 && (
          <>
            <div className="feed-gap" style={{ height: topGap }} />
            {rows.slice(visible.start, visible.end).map((row, offset) => {
              const index = visible.start + offset;
              const lead = leadOf(rows, index);
              return (
                <div key={row.key} data-row={row.key}>
                  {row.kind === 'loading' ? <div className="day">{t.loadingOlder}</div>
                    : row.kind === 'day' ? <div className="day">{row.label}</div>
                      : row.kind === 'new' ? <div className="new-line">{t.newMessages}</div>
                        : row.kind === 'message' ? <MessageRow message={row.message} continued={row.continued} lead={lead} palette={paletteFor(row.message.authorId)} />
                          : <PendingRow pending={row.pending} continued={row.continued} lead={lead} name={visitor?.name ?? ''} palette={paletteFor(selfId)} />}
                </div>
              );
            })}
            <div className="feed-gap" style={{ height: bottomGap }} />
          </>
        )}
      </div>
      <button
        className={`to-latest${atBottomNow ? '' : ' show'}`}
        tabIndex={atBottomNow ? -1 : 0}
        aria-hidden={atBottomNow}
        onClick={followBottom}
      >
        <Icon name="down" />{t.toLatest}
      </button>
      <div className="composer">
        {count > MESSAGE_MAX - 400 && <span className={`count${count > MESSAGE_MAX ? ' over' : ''}`}>{count} / {MESSAGE_MAX}</span>}
        <div className="field" data-tip={`${t.focusChat} (${shortcuts.chat.label} · ${shortcuts.chatEnter.label})`}>
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={t.message}
            aria-label={t.message}
            disabled={!room}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.currentTarget.blur();
                if (drawer) setChatOpen(false);
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <IconButton size="small" className="send" aria-label={t.send} disabled={!canPost(draft)} onClick={send}><Icon name="send" /></IconButton>
        </div>
      </div>
    </aside>
    <div className="chat-veil" aria-hidden="true"><i /><i /><i /><i /><b /><u /></div>
    {unread > 0 && <div className="chat-hint" aria-hidden="true"><span className="badge">{unread > 99 ? '99+' : unread}</span></div>}
    </div>
  );
}
