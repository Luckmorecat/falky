import { useEffect, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { createRoom, renameRoom, viewRoom } from '../app/controller';
import { shortcuts } from '../app/shortcuts';
import { setState, useApp } from '../app/store';
import { roomPalette } from '../fx/palette';
import { t } from '../strings';
import { Icon } from './Icon';
import { Orb } from './Orb';

/**
 * A room's name being typed in place of its tile: a new room, or another name
 * for an existing one. Enter saves, Escape or leaving it empty puts the tile back.
 */
function RoomNameForm({ room, index, onDone }: { room: Room | null; index: number; onDone(): void }) {
  const [name, setName] = useState(room?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Focusing would scroll the whole screen, which hides its overflow; only the list moves.
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    const tile = form.current;
    const list = tile?.parentElement;
    if (!tile || !list) return;
    const left = tile.offsetLeft - list.scrollLeft;
    if (left < 0 || left + tile.offsetWidth > list.clientWidth) list.scrollTo({ left: tile.offsetLeft - (list.clientWidth - tile.offsetWidth) / 2 });
  }, []);

  const save = async () => {
    const n = name.trim();
    if (!n || n === room?.name) return onDone();
    setBusy(true);
    const problem = room ? await renameRoom(room.id, n) : await createRoom(n);
    setBusy(false);
    if (problem) {
      setError(problem);
      // The field stayed focusable while saving, so the name is ready to fix.
      input.current?.select();
    } else onDone();
  };

  return (
    <form
      ref={form}
      className="room room-edit"
      onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Escape here only stops typing; the list stays open.
        e.stopPropagation();
        onDone();
      }}
    >
      <span className="chip">{room ? <Orb seed={`room-${room.id}`} palette={roomPalette(index)} still /> : <span className="chip-add"><Icon name="plus" /></span>}</span>
      <span className="room-text">
        <input
          ref={input}
          type="text"
          maxLength={32}
          autoComplete="off"
          enterKeyHint="done"
          aria-label={room ? t.renameRoom(room.name) : t.roomName}
          aria-invalid={error ? true : undefined}
          placeholder={t.roomName}
          value={name}
          readOnly={busy}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          onBlur={() => { if (!busy && !error && !name.trim()) onDone(); }}
        />
        {error ? <span className="room-err" role="alert">{error}</span> : <span className="people">{room ? t.renameHint : t.newRoomHint}</span>}
      </span>
    </form>
  );
}

/**
 * The room's name at the top, which unfolds into all the rooms in place: on
 * hover with a mouse, on a press with anything. Nothing opens over the page;
 * the stage steps back to make room. The list ends with a way to make another.
 */
export function Rooms({ room, status }: { room: Room | null; status: React.ReactNode }) {
  const rooms = useApp((s) => s.rooms);
  const open = useApp((s) => s.roomsOpen);
  const editing = useApp((s) => s.roomEdit);
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
  // Typing a name keeps the list open until it is saved or abandoned.
  useEffect(() => {
    if (!open) setState({ roomEdit: null });
  }, [open]);
  const unreadElsewhere = rooms.some((r) => r.id !== viewed && chats[r.id]?.unread);
  const done = () => setState({ roomEdit: null });

  return (
    <header
      className="rooms"
      onPointerEnter={(e) => {
        hold();
        if (e.pointerType === 'mouse') setState({ roomsOpen: true });
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') closing.current = setTimeout(() => { if (!document.querySelector('.room-edit')) setState({ roomsOpen: false }); }, 220);
      }}
    >
      <h1>
        <button className="room-now" aria-expanded={open} aria-controls="room-list" aria-label={room ? `${t.rooms}: ${room.name}` : t.rooms} title={`${t.rooms} (${shortcuts.previousRoom.label} / ${shortcuts.nextRoom.label} · ${shortcuts.closeRooms.label})`} onClick={() => setState({ roomsOpen: !open })}>
          <span className="room-now-name">{room?.name ?? t.noRoomsTitle}</span>
          <Icon name="chevron" className="room-chevron" />
          {unreadElsewhere && <span className="room-new" title={t.newMessages} />}
        </button>
      </h1>
      <div className="clock">{status}</div>
      <nav id="room-list" className="room-list" aria-label={t.rooms} {...(open ? {} : { inert: true })}>
        {rooms.map((r, i) => {
          if (editing === r.id) return <RoomNameForm key={r.id} room={r} index={i} onDone={done} />;
          const n = r.occupancy.length;
          return (
            <div key={r.id} className={`room-item${r.id === viewed ? ' on' : ''}`}>
              <button className={`room${r.id === viewed ? ' on' : ''}`} aria-current={r.id === viewed ? 'true' : undefined} onClick={() => viewRoom(r.id)}>
                <span className={`chip${n ? '' : ' empty'}`}><Orb seed={`room-${r.id}`} palette={roomPalette(i)} still /></span>
                <span className="room-text">
                  <span className="room-name">
                    <span>{r.name}</span>
                    {r.id === voiceRoomId && <span className="room-here" title={t.mic}><Icon name="mic" /></span>}
                    {!!chats[r.id]?.unread && <span className="room-new" title={t.newMessages} />}
                  </span>
                  <span className="people" aria-label={t.inVoiceCount(n)}>
                    {n ? r.occupancy.map((p, k) => (
                      <span key={p.connectionId} className={r.id === voiceRoomId && speakers.includes(p.visitorId) ? 'talk' : ''}>
                        {p.name}{k < n - 1 ? ', ' : ''}
                      </span>
                    )) : t.nobodyInVoice}
                  </span>
                </span>
              </button>
              <button type="button" className="room-rename" aria-label={t.renameRoom(r.name)} title={t.renameRoom(r.name)} onClick={() => setState({ roomEdit: r.id })}>
                <Icon name="pencil" />
              </button>
            </div>
          );
        })}
        {editing === 'new' ? <RoomNameForm room={null} index={rooms.length} onDone={done} /> : (
          <button className="room room-add" onClick={() => setState({ roomEdit: 'new' })}>
            <span className="chip"><span className="chip-add"><Icon name="plus" /></span></span>
            <span className="room-text"><span className="room-name"><span>{t.newRoom}</span></span></span>
          </button>
        )}
      </nav>
    </header>
  );
}
