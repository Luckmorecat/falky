import { useEffect, useRef } from 'react';
import type { Room } from '../api/client';
import { viewRoom } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { setState, useApp } from '../app/store';
import { roomPalette } from '../fx/palette';
import { t } from '../strings';
import { Icon } from './Icon';
import { Orb } from './Orb';

/**
 * The room's name at the top, which unfolds into all the rooms in place: on
 * hover with a mouse, on a press with anything. Nothing opens over the page;
 * the stage steps back to make room.
 */
export function Rooms({ room, status }: { room: Room | null; status: React.ReactNode }) {
  const rooms = useApp((s) => s.rooms);
  const open = useApp((s) => s.roomsOpen);
  const chats = useApp((s) => s.chats);
  const viewed = useApp((s) => s.viewedRoomId);
  const voiceRoomId = useApp((s) => (s.voice.status === 'idle' ? null : s.voice.roomId));
  const speakers = useApp((s) => s.voice.speakers);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };
  useEffect(() => hold, []);
  const unreadElsewhere = rooms.some((r) => r.id !== viewed && chats[r.id]?.unread);
  const canUnfold = rooms.length > 0;

  return (
    <header
      className="rooms"
      onPointerEnter={(e) => {
        hold();
        if (e.pointerType === 'mouse' && canUnfold) setState({ roomsOpen: true });
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') closing.current = setTimeout(() => setState({ roomsOpen: false }), 220);
      }}
    >
      <h1>
        <button className="room-now" disabled={!canUnfold} aria-expanded={open} aria-controls="room-list" aria-label={room ? `${t.rooms}: ${room.name}` : t.rooms} title={canUnfold ? `${t.rooms} (${shortcuts.previousRoom.label} / ${shortcuts.nextRoom.label} · ${shortcuts.closeRooms.label})` : undefined} onClick={() => setState({ roomsOpen: !open })}>
          <span className="room-now-name">{room?.name ?? t.noRoomsTitle}</span>
          {canUnfold && <Icon name="chevron" className="room-chevron" />}
          {unreadElsewhere && <span className="room-new" title={t.newMessages} />}
        </button>
      </h1>
      <div className="clock">{status}</div>
      <nav id="room-list" className="room-list" aria-label={t.rooms} {...(open ? {} : { inert: true })}>
        {rooms.map((r, i) => {
          const n = r.occupancy.length;
          return (
            <button key={r.id} className={`room${r.id === viewed ? ' on' : ''}`} aria-current={r.id === viewed ? 'true' : undefined} onClick={() => viewRoom(r.id)}>
              <span className={`chip${n ? '' : ' empty'}`}><Orb seed={`room-${r.id}`} palette={roomPalette(i)} still /></span>
              <span className="room-text">
                <span className="room-name">
                  <span>{r.name}</span>
                  {r.id === voiceRoomId && <span className="room-here" title={t.mic}><Icon name="mic" /></span>}
                  {!!chats[r.id]?.unread && <span className="room-new" title={t.newMessages} />}
                </span>
                <span className="people" aria-label={t.inVoiceCount(n)}>
                  {n ? r.occupancy.map((p, k) => (
                    <span key={p.connectionId} className={r.id === voiceRoomId && speakers.includes(p.connectionId) ? 'talk' : ''}>
                      {p.name}{k < n - 1 ? ', ' : ''}
                    </span>
                  )) : t.nobodyInVoice}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
    </header>
  );
}
