import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Room } from '../api/client';
import { voice } from '../app/controller';
import { getState, useApp } from '../app/store';
import { fitBlocks } from '../fx/layout';
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
import './Stage.css';

interface Person {
  id: string;
  visitorId: string;
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
  return useMemo(() => {
    if (!room) return [];
    const names = new Map(room.occupancy.map((p) => [p.visitorId, p.name]));
    if (voiceState.roomId === room.id && voiceState.status !== 'idle' && voiceState.people.length) {
      return voiceState.people.map((p) => ({ ...p, name: names.get(p.visitorId) ?? p.name, live: true, isSelf: p.local }));
    }
    return room.occupancy
      .map((p) => ({ id: p.connectionId, visitorId: p.visitorId, name: p.name, live: false, isSelf: false, muted: false, deafened: false, sharing: false, cameraTrackId: '' }));
  }, [room, voiceState]);
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

export function Stage({ room, background }: { room: Room; background?: RefObject<LiveBackgroundHandle | null> }) {
  const people = usePeople(room);
  const { w, h } = useWindowSize();
  const narrow = useDrawerLayout();
  const shares = people.filter((p) => p.live && p.sharing);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = shares.find((p) => p.id === picked) ?? shares[0] ?? null;

  const width = narrow ? w - 24 : w - 48;
  const height = h - (narrow ? 96 : 112) - (narrow ? 104 : 128) - 16;
  const gap = people.length > 4 ? 12 : 16;
  const miniSize = narrow ? 76 : 104;
  const fit = fitBlocks(people.length, width, height, gap, 460);
  const size = shown ? miniSize : fit.size;
  const gridWidth = shown ? undefined : fit.columns * size + (fit.columns - 1) * gap;
  const shareWidth = Math.min(width, (height - miniSize - 18) * (16 / 9));
  const colours = useApp((s) => s.colours);

  const grid = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<string, DOMRect>());
  const roomsOpen = useApp((s) => s.roomsOpen);
  const sourcesKey = people.filter((p) => p.live).map((p) => `${p.id}:${colours[p.visitorId]?.palette}`).join();

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
      return element && colours[p.visitorId] ? [{ element, palette: colours[p.visitorId]!.palette, level: () => {
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
            visitorId={p.visitorId}
            name={p.name}
            palette={colours[p.visitorId]?.palette}
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
/** One function per connection, so a block's animation is not rebuilt on each render. */
function levelOf(id: string): () => number {
  let fn = levelFns.get(id);
  if (!fn) {
    fn = () => voice.level(id);
    levelFns.set(id, fn);
  }
  return fn;
}

interface NativeFullscreenVideo extends HTMLVideoElement {
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  webkitEnterFullScreen?(): void;
  webkitExitFullScreen?(): void;
}

const canFullscreenFrame = (frame: HTMLElement) => document.fullscreenEnabled !== false
  && typeof frame.requestFullscreen === 'function' && typeof document.exitFullscreen === 'function';
const nativeEnterFullscreen = (player: NativeFullscreenVideo) => player.webkitEnterFullscreen ?? player.webkitEnterFullScreen;
const nativeExitFullscreen = (player: NativeFullscreenVideo) => player.webkitExitFullscreen ?? player.webkitExitFullScreen;

export function ShareView({ width, person, others, onPick }: { width: number; person: Person; others: Person[]; onPick(id: string): void }) {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<NativeFullscreenVideo>(null);
  const trackId = useApp((s) => s.voice.people.find((p) => p.id === person.id)?.shareTrackId ?? '');
  // Esc and other browser exits never pass through the button, so the label follows the element.
  const [fullscreen, setFullscreen] = useState<'frame' | 'video' | null>(null);
  const [canFullscreen, setCanFullscreen] = useState(false);

  useEffect(() => {
    const el = frame.current;
    const player = video.current;
    if (!el || !player) return;
    setCanFullscreen(canFullscreenFrame(el) || typeof nativeEnterFullscreen(player) === 'function');
    const sync = () => setFullscreen((mode) => document.fullscreenElement === el ? 'frame' : mode === 'video' ? 'video' : null);
    const begin = () => setFullscreen('video');
    const end = () => setFullscreen(null);
    sync();
    document.addEventListener('fullscreenchange', sync);
    player.addEventListener('webkitbeginfullscreen', begin);
    player.addEventListener('webkitendfullscreen', end);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      player.removeEventListener('webkitbeginfullscreen', begin);
      player.removeEventListener('webkitendfullscreen', end);
    };
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

  const toggleFullscreen = async () => {
    const el = frame.current;
    const player = video.current;
    if (!el || !player) return;
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen?.();
      else if (fullscreen === 'video') nativeExitFullscreen(player)?.call(player);
      else if (canFullscreenFrame(el)) {
        try { await el.requestFullscreen(); }
        catch { if (video.current === player) nativeEnterFullscreen(player)?.call(player); }
      } else nativeEnterFullscreen(player)?.call(player);
    } catch {
      // The player stays inline if the browser refuses fullscreen.
    }
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
        {canFullscreen && <IconButton size="small" className="ghost" aria-label={fullscreen ? t.exitFullscreen : t.fullscreen} aria-pressed={!!fullscreen} onClick={() => void toggleFullscreen()}>
          <Icon name={fullscreen ? 'collapse' : 'expand'} />
        </IconButton>}
      </div>
    </div>
  );
}

export const roomOf = (id: string | null) => getState().rooms.find((r) => r.id === id);
