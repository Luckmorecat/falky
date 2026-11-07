import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, Room } from '../api/client';
import { discardMessage, loadOlder, postMessage, retryMessage, setChatOpen } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { getState, useApp } from '../app/store';
import { buildFeed, canPost, MESSAGE_MAX, messageLength, type PendingMessage, splitLinks } from '../chat/timeline';
import { paletteOf, paletteStyle } from '../fx/palette';
import { t } from '../strings';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { useDrawerLayout } from './useDrawerLayout';

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

function Body({ text }: { text: string }) {
  return (
    <div className="msg-text">
      {splitLinks(text).map((p, i) => (p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a> : <span key={i}>{p.text}</span>))}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message, continued }: { message: Message; continued: boolean }) {
  return (
    <article className={`msg${continued ? ' cont' : ''}`} style={paletteStyle(paletteOf(message.authorId))}>
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

function PendingRow({ pending, continued, name, selfId }: { pending: PendingMessage; continued: boolean; name: string; selfId: string }) {
  return (
    <article className={`msg pending${continued ? ' cont' : ''}`} style={paletteStyle(paletteOf(selfId))}>
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
  const feed = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  /** Height before older messages arrive, to keep what is on screen in place. */
  const heightBefore = useRef<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = useRef<HTMLTextAreaElement>(null);

  const draft = room ? (drafts[room.id] ?? '') : '';
  const items = useMemo(() => (chat ? buildFeed(chat, visitor?.id, newAfterId) : []), [chat, visitor?.id, newAfterId, lang]);
  const count = messageLength(draft);

  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (heightBefore.current !== null) {
      el.scrollTop += el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  // Each room and each opening starts at the newest message.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [room?.id, open]);

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
    if (!el || !room) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop < 120 && chat?.hasOlder && !chat.loadingOlder) {
      heightBefore.current = el.scrollHeight;
      void loadOlder(room.id);
    }
  };

  const setDraft = (value: string) => {
    if (room) setDrafts((d) => ({ ...d, [room.id]: value }));
  };

  const send = () => {
    if (!room || !canPost(draft)) return;
    postMessage(room.id, draft);
    setDraft('');
    stick.current = true;
  };

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
      <div className="feed" ref={feed} onScroll={onScroll} aria-live="polite">
        {chat?.loadingOlder && <div className="day">{t.loadingOlder}</div>}
        {chat?.loaded && !items.length && (
          <div className="empty-chat"><strong>{t.emptyChatTitle}</strong>{t.emptyChatBody}</div>
        )}
        {items.map((item) => {
          if (item.kind === 'day') return <div key={item.key} className="day">{item.label}</div>;
          if (item.kind === 'new') return <div key={item.key} className="new-line">{t.newMessages}</div>;
          if (item.kind === 'message') return <MessageRow key={item.key} message={item.message} continued={item.continued} />;
          return <PendingRow key={item.key} pending={item.pending} continued={item.continued} name={visitor?.name ?? ''} selfId={visitor?.id ?? ''} />;
        })}
      </div>
      <button
        className={`to-latest${atBottom ? '' : ' show'}`}
        tabIndex={atBottom ? -1 : 0}
        aria-hidden={atBottom}
        onClick={() => {
          const el = feed.current;
          if (el) el.scrollTop = el.scrollHeight;
        }}
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
