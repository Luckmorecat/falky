import { useEffect, useRef, useState } from 'react';
import { answerKnock, dismissKnock, dismissNotice, voice } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Chat } from './Chat';
import { ChatTicker } from './ChatTicker';
import { Dock } from './Dock';
import { Icon } from './Icon';
import { NameConflict } from './Screens';
import { Rooms } from './Rooms';
import { Stage } from './Stage';
import { useShortcuts } from './useShortcuts';
import { useTalk } from './useTalk';
import { LiveBackground, type LiveBackgroundHandle } from './LiveBackground';
import './Notices.css';
import './Main.css';

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
  useShortcuts();
  const holdToTalk = useTalk();
  const background = useRef<LiveBackgroundHandle>(null);
  const unreadCounter = useRef<HTMLSpanElement>(null);
  const room = useApp((s) => s.rooms.find((r) => r.id === s.viewedRoomId) ?? null);
  const voiceState = useApp((s) => s.voice);
  const voiceRoomName = useApp((s) => s.rooms.find((r) => r.id === s.voice.roomId)?.name);
  const chatOpen = useApp((s) => s.chatOpen);
  const roomsOpen = useApp((s) => s.roomsOpen);
  const live = useApp((s) => s.live);
  const notice = useApp((s) => s.notice);
  const knockCall = useApp((s) => s.knock);
  const rooms = useApp((s) => s.rooms);
  const nameTaken = useApp((s) => s.visitor?.nameTaken);

  useEffect(() => {
    document.body.classList.toggle('chat-open', chatOpen);
    document.body.classList.toggle('rooms-open', roomsOpen);
  }, [chatOpen, roomsOpen]);

  const inThisRoom = !!room && voiceState.roomId === room.id && voiceState.status !== 'idle';
  const inVoiceElsewhere = !!voiceRoomName && voiceState.status !== 'idle' && !inThisRoom;
  const banner = live === 'reconnecting' ? t.reconnecting : voiceState.status === 'reconnecting' ? t.voiceReconnecting : null;

  return (
    <div className="screen room-screen">
      <span className="build-version">{import.meta.env.VITE_BUILD_VERSION}</span>
      <LiveBackground ref={background} unreadTarget={unreadCounter} />

      <div className="main">
        <Rooms
          room={room}
          status={!room ? <span>{t.noRoomsBody}</span>
            : inThisRoom && voiceState.joinedAt ? <Clock joinedAt={voiceState.joinedAt} />
              : inVoiceElsewhere ? <span>{t.inOtherRoom(voiceRoomName)}</span>
                : <span>{room.occupancy.length ? t.notInVoice : t.nobodyInVoice}</span>}
        />
        {room ? <Stage room={room} background={background} /> : <div className="stage" />}
        <div className="dock-space" />
        <Dock room={room} unreadRef={unreadCounter} holdToTalk={holdToTalk} />
      </div>

      <Chat room={room} />
      {room && <ChatTicker room={room} />}

      <div className="float-top" aria-live="polite">
        {banner && <div className="banner"><span className="pulse" />{banner}</div>}
        {voiceState.audioBlocked && voiceState.roomId && voiceState.status !== 'reconnecting' && (
          <div className="toast audio-blocked">
            <strong>{t.audioPlaybackBlocked}</strong>
            <Button data-enable-voice-audio data-cue="none" onClick={() => voice.retryAudio()}>{t.enableAudio}</Button>
          </div>
        )}
        {notice && (
          <div className="toast" key={notice.id} role="status">
            <div>
              <strong>{notice.title}</strong>
              {notice.body && <p>{notice.body}</p>}
            </div>
            <IconButton size="small" aria-label={t.close} onClick={dismissNotice}><Icon name="x" /></IconButton>
          </div>
        )}
        {knockCall && (
          <div className="toast knock-toast" key={`knock-${knockCall.id}`} role="alert">
            <div>
              <strong>{t.knockFrom(knockCall.fromName, rooms.find((r) => r.id === knockCall.roomId)?.name ?? '')}</strong>
            </div>
            <div className="knock-actions">
              <Button variant="join" data-cue="none" onClick={answerKnock}><Icon name="mic" /><span className="tx">{t.join}</span></Button>
              <IconButton size="small" aria-label={t.close} onClick={dismissKnock}><Icon name="x" /></IconButton>
            </div>
          </div>
        )}
        {nameTaken && <NameConflict />}
      </div>
    </div>
  );
}
