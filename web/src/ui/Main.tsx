import { useEffect, useState } from 'react';
import { dismissNotice, setChatOpen, stepRoom, voice } from '../app/controller';
import { getState, setState, useApp } from '../app/store';
import { t } from '../strings';
import { IconButton } from './IconButton';
import { Chat } from './Chat';
import { Dock } from './Dock';
import { Icon } from './Icon';
import { NameConflict } from './Screens';
import { Rooms } from './Rooms';
import { Stage } from './Stage';

function Clock({ joinedAt }: { joinedAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - joinedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  const text = hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  return <span>{t.inVoiceFor(text)}</span>;
}

export function Main() {
  const room = useApp((s) => s.rooms.find((r) => r.id === s.viewedRoomId) ?? null);
  const voiceState = useApp((s) => s.voice);
  const voiceRoomName = useApp((s) => s.rooms.find((r) => r.id === s.voice.roomId)?.name);
  const chatOpen = useApp((s) => s.chatOpen);
  const roomsOpen = useApp((s) => s.roomsOpen);
  const unread = useApp((s) => (s.viewedRoomId ? (s.chats[s.viewedRoomId]?.unread ?? 0) : 0));
  const live = useApp((s) => s.live);
  const notice = useApp((s) => s.notice);
  const nameTaken = useApp((s) => s.visitor?.nameTaken);

  useEffect(() => {
    document.body.classList.toggle('chat-open', chatOpen);
    document.body.classList.toggle('rooms-open', roomsOpen);
  }, [chatOpen, roomsOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setState({ roomsOpen: false });
        return;
      }
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      // By physical key, so a Ukrainian layout works the same.
      // Straight to writing, as in most chats; a focused button keeps its own Enter.
      if (e.code === 'Slash' || e.key === '/' || (e.code === 'Enter' && !target?.closest('button, a'))) {
        e.preventDefault();
        setChatOpen(true);
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
        return;
      }
      if (e.code === 'KeyM' && getState().voice.status === 'connected') void voice.toggleMute();
      else if (e.code === 'KeyD' && getState().voice.status === 'connected') void voice.toggleDeafen();
      else if (e.key === 'ArrowLeft') stepRoom(-1);
      else if (e.key === 'ArrowRight') stepRoom(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const inThisRoom = !!room && voiceState.roomId === room.id && voiceState.status !== 'idle';
  const inVoiceElsewhere = !!voiceRoomName && voiceState.status !== 'idle' && !inThisRoom;
  const banner = live === 'reconnecting' ? t.reconnecting : voiceState.status === 'reconnecting' ? t.voiceReconnecting : null;

  return (
    <div className="screen room-screen">
      <div className="topbar"><span className="mark">falky</span></div>

      <div className="main">
        <Rooms
          room={room}
          status={!room ? <span>{t.noRoomsBody}</span>
            : inThisRoom && voiceState.joinedAt ? <Clock joinedAt={voiceState.joinedAt} />
              : inVoiceElsewhere ? <span>{t.inOtherRoom(voiceRoomName)}</span>
                : <span>{room.occupancy.length ? t.notInVoice : t.nobodyInVoice}</span>}
        />
        {room ? <Stage room={room} /> : <div className="stage" />}
        <div className="dock-space" />
        <Dock room={room} />
      </div>

      <IconButton
        className="chat-btn"
        aria-label={chatOpen ? t.closeChat : unread ? `${t.chat}: ${unread}` : t.chat}
        aria-expanded={chatOpen}
        onClick={() => setChatOpen(!chatOpen)}
      >
        <span className="swap"><Icon name="chat" className="a" /><Icon name="x" className="b" /></span>
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </IconButton>
      <Chat room={room} />

      <div className="float-top" aria-live="polite">
        {banner && <div className="banner"><span className="pulse" />{banner}</div>}
        {notice && (
          <div className="toast" key={notice.id} role="status">
            <div>
              <strong>{notice.title}</strong>
              {notice.body && <p>{notice.body}</p>}
            </div>
            <IconButton size="small" aria-label={t.close} onClick={dismissNotice}><Icon name="x" /></IconButton>
          </div>
        )}
        {nameTaken && <NameConflict />}
      </div>
    </div>
  );
}
