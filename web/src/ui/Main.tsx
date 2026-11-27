import { useEffect, useMemo, useRef, useState } from 'react';
import { answerKnock, dismissKnock, voice } from '../app/controller';
import { type AppState, useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
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
import { Toast, TopNoticeSlot } from './Toast';
import './Main.css';

type MainVoice = Pick<AppState['voice'], 'roomId' | 'status' | 'joinedAt' | 'audioBlocked'>;

function createVoiceSelector() {
  let previous: MainVoice | undefined;
  return ({ voice }: AppState): MainVoice => {
    const { roomId, status, joinedAt, audioBlocked } = voice;
    if (previous && previous.roomId === roomId && previous.status === status
      && previous.joinedAt === joinedAt && previous.audioBlocked === audioBlocked) return previous;
    previous = { roomId, status, joinedAt, audioBlocked };
    return previous;
  };
}

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
  const selectVoice = useMemo(createVoiceSelector, []);
  const { roomId: voiceRoomId, status: voiceStatus, joinedAt, audioBlocked } = useApp(selectVoice);
  const chatOpen = useApp((s) => s.chatOpen);
  const roomsOpen = useApp((s) => s.roomsOpen);
  const live = useApp((s) => s.live);
  const knockCall = useApp((s) => s.knock);
  const rooms = useApp((s) => s.rooms);
  const nameTaken = useApp((s) => s.visitor?.nameTaken);

  useEffect(() => {
    document.body.classList.toggle('chat-open', chatOpen);
    document.body.classList.toggle('rooms-open', roomsOpen);
  }, [chatOpen, roomsOpen]);

  const voiceRoomName = rooms.find((r) => r.id === voiceRoomId)?.name;
  const inThisRoom = !!room && voiceRoomId === room.id && voiceStatus !== 'idle';
  const inVoiceElsewhere = !!voiceRoomName && voiceStatus !== 'idle' && !inThisRoom;
  const joining = voiceStatus === 'joining' && voiceRoomId === null;
  const banner = joining ? t.joining
    : live === 'reconnecting' ? t.reconnecting
    : voiceStatus === 'reconnecting' ? t.voiceReconnecting : null;

  return (
    <div className="screen room-screen">
      <span className="build-version">{import.meta.env.VITE_BUILD_VERSION}</span>
      <LiveBackground ref={background} unreadTarget={unreadCounter} />

      <div className="main">
        <Rooms
          room={room}
          status={!room ? <span>{t.noRoomsBody}</span>
            : inThisRoom && joinedAt ? <Clock joinedAt={joinedAt} />
              : inVoiceElsewhere ? <span>{t.inOtherRoom(voiceRoomName)}</span>
                : <span>{room.occupancy.length ? t.notInVoice : t.nobodyInVoice}</span>}
        />
        {room ? <Stage room={room} background={background} /> : <div className="stage" />}
        <div className="dock-space" />
        <Dock room={room} unreadRef={unreadCounter} holdToTalk={holdToTalk} />
      </div>

      <Chat room={room} />
      {room && <ChatTicker room={room} />}

      <TopNoticeSlot position="banner">
        {banner && <div className="banner"><span className="pulse" />{banner}</div>}
      </TopNoticeSlot>
      <Toast
        open={audioBlocked && !!voiceRoomId && voiceStatus !== 'reconnecting'}
        position="before"
        className="audio-blocked"
        title={t.audioPlaybackBlocked}
        action={<Button data-enable-voice-audio data-cue="none" onClick={() => voice.retryAudio()}>{t.enableAudio}</Button>}
      />
      {knockCall && (
        <Toast
          key={knockCall.id}
          open
          role="alert"
          className="knock-toast"
          title={t.knockFrom(knockCall.fromName, rooms.find((r) => r.id === knockCall.roomId)?.name ?? '')}
          action={<Button variant="join" data-cue="none" onClick={() => answerKnock(knockCall.id)}><Icon name="mic" /><span className="tx">{t.join}</span></Button>}
          onDismiss={() => dismissKnock(knockCall.id)}
        />
      )}
      <TopNoticeSlot position="form">
        {nameTaken && <NameConflict />}
      </TopNoticeSlot>
    </div>
  );
}
