import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, Room } from '../api/client';
import { discardMessage, loadOlder, postMessage, retryMessage } from '../app/controller';
import { useApp } from '../app/store';
import { buildFeed, canPost, MESSAGE_MAX, messageLength, type PendingMessage, splitLinks } from '../chat/timeline';
import { paletteOf, paletteStyle } from '../fx/palette';
import { t } from '../strings';
import { Icon } from './Icon';

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

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

export function Chat({ room, peopleInVoice }: { room: Room | null; peopleInVoice: number }) {
  const open = useApp((s) => s.chatOpen);
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
  const items = useMemo(() => (chat ? buildFeed(chat, visitor?.id, newAfterId) : []), [chat, visitor?.id, newAfterId]);
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
    if (open && matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  }, [open, room?.id]);

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
    <aside className="chat" aria-label={t.chat} {...(open ? {} : { inert: true })}>
      <div className="chat-head">
        <h2>{room?.name ?? t.chat}</h2>
        <p>{peopleInVoice ? t.inVoiceCount(peopleInVoice) : t.nobodyInVoice}</p>
      </div>
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
        <div className="field">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={t.message}
            aria-label={t.message}
            disabled={!room}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="ib sm send" aria-label={t.send} disabled={!canPost(draft)} onClick={send}><Icon name="send" /></button>
        </div>
      </div>
    </aside>
  );
}
