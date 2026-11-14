import { useEffect, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { setChatOpen } from '../app/controller';
import { useApp } from '../app/store';
import { type PaletteName, paletteStyle } from '../fx/palette';
import { t } from '../strings';
import { Orb } from './Orb';
import './ChatTicker.css';

const SHOWN_FOR = 6000;
const MOST = 3;

type Line = { id: string; authorId: string; author: string; text: string; palette?: PaletteName; until: number };

/**
 * While the chat is put away, what others write rises over the dock for a few
 * seconds and fades, so nothing has to be opened to keep up. A line opens the chat.
 */
export function ChatTicker({ room }: { room: Room }) {
  const open = useApp((s) => s.chatOpen);
  const messages = useApp((s) => s.chats[room.id]?.messages);
  const selfId = useApp((s) => s.visitor?.id);
  const colours = useApp((s) => s.colours);
  const [lines, setLines] = useState<Line[]>([]);
  const seen = useRef<{ roomId: string; id?: string }>({ roomId: room.id });

  useEffect(() => {
    const newest = messages?.at(-1);
    const before = seen.current;
    seen.current = { roomId: room.id, id: newest?.id };
    // The first page of history, or another room's, is not news.
    if (!messages || !newest || before.roomId !== room.id || !before.id || before.id === newest.id || open) return;
    const from = messages.findIndex((m) => m.id === before.id);
    const fresh = messages.slice(from === -1 ? -1 : from + 1).filter((m) => m.authorId !== selfId);
    if (!fresh.length) return;
    setLines((now) => [...now, ...fresh.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      author: m.authorName,
      text: m.body.trim() ? m.body : t.imagesSummary(m.attachments.length),
      palette: colours[m.authorId]?.palette,
      until: Date.now() + SHOWN_FOR,
    }))].slice(-MOST));
  }, [messages, room.id, open, selfId, colours]);

  useEffect(() => { if (open) setLines([]); }, [open]);
  useEffect(() => { setLines([]); }, [room.id]);

  useEffect(() => {
    if (!lines.length) return;
    const id = setTimeout(() => setLines((now) => now.filter((line) => line.until > Date.now())), Math.max(0, lines[0]!.until - Date.now()));
    return () => clearTimeout(id);
  }, [lines]);

  return (
    <div className="ticker" aria-hidden="true">
      {lines.map((line, i) => (
        <button key={line.id} className="ticker-line" tabIndex={-1} style={paletteStyle(line.palette)} onClick={() => setChatOpen(true)}>
          {lines[i - 1]?.authorId !== line.authorId && <><span className="ticker-avatar"><Orb seed={line.authorId} palette={line.palette} still /></span><b>{line.author}</b></>}
          <span>{line.text}</span>
        </button>
      ))}
    </div>
  );
}
