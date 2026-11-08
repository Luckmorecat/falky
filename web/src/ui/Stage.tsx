import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { voice } from '../app/controller';
import { getState, useApp } from '../app/store';
import { fitBlocks } from '../fx/layout';
import { assignPalettes } from '../fx/palette';
import { effectsReduced } from '../fx/ticker';
import type { VoiceSource } from '../fx/voiceField';
import type { LiveBackgroundHandle } from './LiveBackground';
import { t } from '../strings';
import { shareStatsEnabled } from '../voice/shareStats';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { ShareStats } from './ShareStatsOverlay';
import { Tile } from './Tile';
import { useDrawerLayout } from './useDrawerLayout';

interface Person {
  id: string;
  name: string;
  live: boolean;
  isSelf: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  cameraTrackId: string;
}

/** Who to show: inside the room's voice, LiveKit knows best and tells more. */
export function usePeople(room: Room | null): Person[] {
  const voiceState = useApp((s) => s.voice);
  const selfId = useApp((s) => s.visitor?.id);
  return useMemo(() => {
    if (!room) return [];
    const names = new Map(room.occupancy.map((p) => [p.visitorId, p.name]));
    if (voiceState.roomId === room.id && voiceState.status !== 'idle' && voiceState.people.length) {
      return voiceState.people.map((p) => ({ ...p, name: names.get(p.id) ?? p.name, live: true, isSelf: p.local }));
    }
    return room.occupancy
      .filter((p) => voiceState.roomId !== null || voiceState.status === 'idle' || p.visitorId !== selfId)
      .map((p) => ({ id: p.visitorId, name: p.name, live: false, isSelf: p.visitorId === selfId, muted: false, deafened: false, sharing: false, cameraTrackId: '' }));
  }, [room, voiceState, selfId]);
}

function useWindowSize(): { w: number; h: number } {
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: innerWidth, h: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return size;
}

/** The width of --chat in styles.css. */
const CHAT_WIDTH = 340;

export function Stage({ room, background }: { room: Room; background?: RefObject<LiveBackgroundHandle | null> }) {
  const people = usePeople(room);
  const { w, h } = useWindowSize();
  const narrow = useDrawerLayout();
  const shares = people.filter((p) => p.live && p.sharing);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = shares.find((p) => p.id === picked) ?? shares[0] ?? null;

  // The chat comes in over a page that does not move, so nothing may stand where
  // it lands: blocks stay centred with its width kept free on both sides, and a
  // shared screen, which wants all the room it can get, stands left of it.
  const width = narrow ? w - 24 : w - 2 * (CHAT_WIDTH + 24);
  const shareRoom = narrow ? w - 24 : w - CHAT_WIDTH - 48;
  const height = h - (narrow ? 96 : 112) - (narrow ? 104 : 128) - 16;
  const gap = people.length > 4 ? 12 : 16;
  const miniSize = narrow ? 76 : 104;
  const fit = fitBlocks(people.length, width, height, gap, 460);
  const size = shown ? miniSize : fit.size;
  const gridWidth = shown ? undefined : fit.columns * size + (fit.columns - 1) * gap;
  const shareWidth = Math.min(shareRoom, (height - miniSize - 18) * (16 / 9));
  const selfId = useApp((s) => s.visitor?.id);
  const ownColor = useApp((s) => s.ownColor);
  const palettes = useMemo(() => assignPalettes(people.map((p) => p.id), selfId && ownColor ? { id: selfId, palette: ownColor } : undefined), [people, selfId, ownColor]);

  const grid = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<string, DOMRect>());
  const roomsOpen = useApp((s) => s.roomsOpen);
  const sourcesKey = people.filter((p) => p.live).map((p) => `${p.id}:${palettes.get(p.id)}`).join();

  useLayoutEffect(() => {
    background?.current?.invalidateLayout();
  }, [background, sourcesKey, size, w, h, narrow, room.id, roomsOpen, shown?.id]);

  useEffect(() => {
    const field = background?.current;
    if (!field) return;
    if (!grid.current) { field.setSources([]); return; }
    const tiles = new Map([...grid.current.querySelectorAll<HTMLElement>('[data-tile]')].map((el) => [el.dataset.tile, el]));
    const sources: VoiceSource[] = people.filter((p) => p.live).flatMap((p) => {
      const element = tiles.get(p.id)?.querySelector<HTMLElement>('.orb');
      return element ? [{ element, palette: palettes.get(p.id)!, level: () => {
        const person = getState().voice.people.find((person) => person.id === p.id);
        return person && !person.muted && !person.deafened ? levelOf(p.id)() : 0;
      } }] : [];
    });
    field.setSources(sources);
    // Voice snapshots change with loudness; only membership/palettes rebuild the field.
  }, [background, sourcesKey, room.id]);

  useEffect(() => () => background?.current?.setSources([]), [background]);

  // Blocks glide from where they were when someone joins or leaves.
  useLayoutEffect(() => {
    const blocks = [...(grid.current?.querySelectorAll<HTMLElement>('[data-tile]') ?? [])];
    for (const el of blocks) el.getAnimations().forEach((a) => a.cancel());
    const next = new Map(blocks.map((el) => [el.dataset.tile!, el.getBoundingClientRect()]));
    if (!effectsReduced()) {
      const follow = (animation: Animation) => {
        void animation.finished.then(() => background?.current?.invalidateLayout(), () => {});
      };
      for (const el of blocks) {
        const was = rects.current.get(el.dataset.tile!);
        const now = next.get(el.dataset.tile!)!;
        if (!was) {
          if (rects.current.size) follow(el.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.23,1,.32,1)' }));
          continue;
        }
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        const s = now.width ? was.width / now.width : 1;
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(s - 1) > 0.5) {
          follow(el.animate([{ transform: `translate(${dx}px,${dy}px) scale(${s})` }, { transform: 'none' }], { duration: 440, easing: 'cubic-bezier(.32,.72,0,1)' }));
        }
      }
    }
    rects.current = next;
    // Only membership and size move blocks; a new room starts with none to glide from.
  }, [people.length, size, room.id, people.map((p) => p.id).join()]);

  const inThisRoom = useApp((s) => s.voice.roomId === room.id && s.voice.status !== 'idle');

  if (!people.length) {
    return (
      <div className="stage">
        <div className="stage-empty">
          <h2>{t.stageEmptyTitle}</h2>
          <p>{t.stageEmptyBody}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`stage${shown ? ' with-share' : ''}`} onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && event.propertyName === 'transform') background?.current?.invalidateLayout();
    }}>
      {shown && (
        <ShareView
          width={shareWidth}
          person={shown}
          others={shares}
          onPick={setPicked}
        />
      )}
      <div ref={grid} className="grid" style={{ '--t': `${size}px`, '--gap': `${gap}px`, width: gridWidth } as React.CSSProperties}>
        {people.map((p) => (
          <Tile
            key={p.id}
            id={p.id}
            name={p.name}
            palette={palettes.get(p.id)!}
            isSelf={p.isSelf}
            muted={p.muted}
            deafened={p.deafened}
            mini={!!shown}
            adjustable={inThisRoom && p.live && !p.isSelf}
            level={p.live ? levelOf(p.id) : undefined}
            cameraTrackId={p.cameraTrackId}
          />
        ))}
      </div>
    </div>
  );
}

const levelFns = new Map<string, () => number>();
/** One function per person, so a block's animation is not rebuilt on each render. */
function levelOf(id: string): () => number {
  let fn = levelFns.get(id);
  if (!fn) {
    fn = () => voice.level(id);
    levelFns.set(id, fn);
  }
  return fn;
}

export function ShareView({ width, person, others, onPick }: { width: number; person: Person; others: Person[]; onPick(id: string): void }) {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const trackId = useApp((s) => s.voice.people.find((p) => p.id === person.id)?.shareTrackId ?? '');
  // Esc and other browser exits never pass through the button, so the label follows the element.
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === frame.current);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    const el = video.current;
    const track = voice.shareTrack(person.id);
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [person.id, trackId]);

  const toggleFullscreen = () => {
    const el = frame.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  return (
    <div ref={frame} className="share" style={{ width }}>
      <video ref={video} autoPlay playsInline muted aria-label={person.isSelf ? t.yourScreen : t.screenOf(person.name)} />
      {shareStatsEnabled(import.meta.env.VITE_DEV_STATS) && (
        <ShareStats key={`${person.id}:${trackId}`} track={voice.shareTrack(person.id)} direction={person.isSelf ? 'send' : 'receive'} />
      )}
      <div className="share-bar">
        <div className="share-tabs">
          {others.map((p) => (
            <button key={p.id} className={`share-label${p.id === person.id ? ' on' : ''}`} aria-pressed={p.id === person.id} onClick={() => onPick(p.id)}>
              {p.isSelf ? t.yourScreen : t.screenOf(p.name)}
            </button>
          ))}
        </div>
        <IconButton size="small" className="ghost" aria-label={fullscreen ? t.exitFullscreen : t.fullscreen} aria-pressed={fullscreen} onClick={toggleFullscreen}>
          <Icon name={fullscreen ? 'collapse' : 'expand'} />
        </IconButton>
      </div>
    </div>
  );
}

export const roomOf = (id: string | null) => getState().rooms.find((r) => r.id === id);
