import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { updateSettings } from '../app/controller';
import type { Theme } from '../app/prefs';
import { type Bindable, isDefault, rebind, resetShortcut, shortcuts, shortcutsRevision, subscribeShortcuts } from '../app/shortcuts';
import { useApp } from '../app/store';
import { createBackground } from '../fx/backgroundRenderer';
import type { PaletteName } from '../fx/palette';
import { createThemeWave } from '../fx/themeWave';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import { playSound, startCamera } from '@falky/browser';
import type { Sound } from '../voice/sounds';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { Orb } from './Orb';

/** A titled card of rows with one sentence under it. */
export function SettingsGroup({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-group">
      <h3>{title}</h3>
      <div className="set-card">{children}</div>
      {note && <p className="set-foot">{note}</p>}
    </section>
  );
}

const THEMES: readonly (readonly [Theme, () => string])[] = [['dark', () => t.themeDark], ['light', () => t.themeLight], ['system', () => t.themeSystem]];

const FRIEND: { seed: string; palette: PaletteName } = { seed: 'falky-theme-friend', palette: 'apricot' };

/** The room screen drawn small: its name, two avatars and the dock, in one theme's colours. */
function MiniRoom({ look }: { look: 'dark' | 'light' }) {
  const seed = useApp((s) => s.visitor?.id ?? '');
  const palette = useOwnPalette();
  const friend = palette === FRIEND.palette ? { ...FRIEND, palette: 'violet' as const } : FRIEND;
  return (
    <span className={`mini-room ${look}`}>
      <span className="mini-people">
        <Orb seed={seed} palette={palette} still />
        <Orb seed={friend.seed} palette={friend.palette} still />
      </span>
      <span className="mini-dock">
        <span className="mini-join"><Icon name="mic" /><span className="tx">{t.join}</span></span>
        <span className="mini-key"><Icon name="sliders" /></span>
        <span className="mini-key"><Icon name="chat" /></span>
      </span>
    </span>
  );
}

/** Each theme as a still picture of the room it gives; the system one is half of each. */
export function ThemePicker() {
  const theme = useApp((s) => s.settings.theme);
  return (
    <div className="setrow">
      <span>{t.theme}</span>
      <div className="theme-picker" role="group" aria-label={t.theme}>
        {THEMES.map(([value, label]) => (
          <button key={value} type="button" className="theme-option" aria-pressed={theme === value} onClick={() => updateSettings({ theme: value })}>
            <span className={`theme-thumb ${value}`} aria-hidden="true">
              {value !== 'light' && <MiniRoom look="dark" />}
              {value !== 'dark' && <MiniRoom look="light" />}
            </span>
            {label()}
          </button>
        ))}
      </div>
    </div>
  );
}

const useOwnPalette = (): PaletteName => useApp((s) => (s.visitor ? s.colours[s.visitor.id]?.palette : undefined) ?? 'sky');
/** Phrases of a few seconds with syllables in them, then a breath. */
const talking = (time: number) => {
  const phrase = time % 5.5;
  if (phrase > 4) return 0;
  const envelope = Math.min(1, phrase / 0.25, (4 - phrase) / 0.4);
  return envelope * (0.45 + 0.5 * Math.pow(0.5 + 0.5 * Math.sin(time * 12), 2));
};

/** A level that talks on its own, for previews; read by the avatar and the background alike. */
function useTalking(): { level: () => number; fill: React.RefObject<HTMLDivElement | null> } {
  const now = useRef(0);
  const fill = useRef<HTMLDivElement>(null);
  useEffect(() => onTick((time) => {
    now.current = talking(time);
    if (fill.current) fill.current.style.transform = `scaleY(${now.current.toFixed(3)})`;
  }), []);
  const level = useCallback(() => now.current, []);
  return { level, fill };
}

/** Two avatars in the chosen look on the room's dots: the person's own, talking, and a quiet one beside it. */
export function AvatarStage() {
  const seed = useApp((s) => s.visitor?.id ?? '');
  const palette = useOwnPalette();
  const { level } = useTalking();
  const friend = palette === FRIEND.palette ? { ...FRIEND, palette: 'violet' as const } : FRIEND;
  return (
    <div className="look-stage" aria-hidden="true">
      <Orb seed={seed} palette={palette} level={level} />
      <Orb seed={friend.seed} palette={friend.palette} />
    </div>
  );
}

/**
 * A corner of a room with the person talking, drawn by the real background renderer:
 * live dots ripple from the avatar; with fewer effects both hold still.
 */
export function MotionStage({ active }: { active: boolean }) {
  const { liveBackground, fewerEffects } = useApp((s) => s.settings);
  const seed = useApp((s) => s.visitor?.id ?? '');
  const palette = useOwnPalette();
  const { level, fill } = useTalking();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = liveBackground && !fewerEffects;
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (!active || !live) { setDrawn(false); return; }
    const orb = stage.current!.querySelector<HTMLElement>('.orb')!;
    const painter = createBackground(canvas.current!, [{ element: orb, palette, level }]);
    if (!painter) return;
    setDrawn(true);
    const isLight = () => document.documentElement.dataset.theme === 'light';
    const wave = createThemeWave(isLight());
    let time = 0;
    const stop = onTick((_now, dt) => {
      time += dt;
      // The window opens with a zoom and its panel scrolls; the stage is small enough to measure every frame.
      painter.invalidateLayout();
      painter.draw(time, 3, 260, false, wave.frame(isLight(), dt, false));
    });
    return () => { stop(); painter.dispose(); };
  }, [active, live, palette, level]);
  return (
    <div ref={stage} className={drawn ? 'motion-stage drawn' : 'motion-stage'} aria-hidden="true">
      <canvas ref={canvas} />
      <Orb seed={seed} palette={palette} level={level} still={fewerEffects} />
      <div className="set-preview-meter"><div ref={fill} /></div>
    </div>
  );
}

/** Plays one sound the switch beside it turns on or off. */
export function PlaySample({ sound, label }: { sound: Sound; label: string }) {
  const speakerId = useApp((s) => s.settings.speakerId);
  return <IconButton className="set-play" data-cue="none" aria-label={`${t.playSample}: ${label}`} onClick={() => playSound(sound, speakerId)}><Icon name="play" /></IconButton>;
}

/** What the chosen camera sees, as the person will see themselves; stopped when not shown. */
export function CameraPreview({ active }: { active: boolean }) {
  const { cameraId, cameraResolution, cameraMirror } = useApp((s) => s.settings);
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | undefined;
    let cancelled = false;
    setFailed(false);
    const height = Number(cameraResolution);
    startCamera({ deviceId: cameraId || undefined, width: Math.round((height * 16) / 9), height }).then(
      (started) => {
        if (cancelled) { started.getTracks().forEach((track) => track.stop()); return; }
        stream = started;
        if (video.current) video.current.srcObject = started;
      },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [active, cameraId, cameraResolution]);
  return (
    <div className="set-camera">
      <video ref={video} className={cameraMirror ? 'mirror' : undefined} autoPlay muted playsInline aria-label={t.camera} />
      {failed && <p className="set-camera-error" role="alert">{t.cameraPreviewFailed}</p>}
    </div>
  );
}

const useBindings = () => useSyncExternalStore(subscribeShortcuts, shortcutsRevision);

/** One movable shortcut: press the key cap, then the new key; Escape keeps the old one. */
export function KeyBinding({ name, label, names }: { name: Bindable; label: string; names: Record<Bindable, string> }) {
  useBindings();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { setListening(false); return; }
    const result = rebind(name, e.nativeEvent);
    if (result.ok) { setListening(false); setError(''); }
    else setError(result.reason === 'taken' ? t.keyTaken(names[result.by]) : t.keyReserved);
  };
  return (
    <div className="key-row">
      <span>{label}</span>
      <span className="key-edit">
        {!isDefault(name) && <IconButton aria-label={`${t.keyReset}: ${label}`} onClick={() => { resetShortcut(name); setError(''); }}><Icon name="retry" /></IconButton>}
        <button
          type="button"
          className="key-cap"
          aria-pressed={listening}
          aria-label={`${label}: ${shortcuts[name].label}`}
          onClick={() => { setListening(!listening); setError(''); }}
          onKeyDown={onKey}
          onBlur={() => setListening(false)}
        >
          <kbd>{listening ? t.keyPress : shortcuts[name].label}</kbd>
        </button>
      </span>
      {error && <span className="field-err" role="alert">{error}</span>}
    </div>
  );
}
