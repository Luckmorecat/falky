import { useEffect, useMemo, useRef, useState } from 'react';
import { createBackground } from '../../src/fx/backgroundRenderer';
import { createThemeWave } from '../../src/fx/themeWave';
import { createUnreadBeacon } from '../../src/fx/unreadBeacon';
import { Icon } from '../../src/ui/Icon';
import { effectsReduced, onTick } from '../../src/fx/ticker';
import type { PaletteName } from '../../src/fx/palette';
import { Orb } from '../../src/ui/Orb';
import { simulatedSpeech } from './simulatedSpeech';
import './liveBackgroundPreview.css';

export interface LiveBackgroundPreviewProps {
  speed: number;
  reducedMotion: boolean;
  speakers: 'none' | 'one' | 'two';
  strength: number;
  spread: number;
  enabled: boolean;
  unread?: boolean;
}

const PEOPLE: { name: string; palette: PaletteName }[] = [
  { name: 'Alex', palette: 'sky' },
  { name: 'Sam', palette: 'rose' },
];

/** Inspect the production renderer with optional simulated voices and no app state. */
export function LiveBackgroundPreview({ speed, reducedMotion, speakers, strength, spread, enabled, unread = false }: LiveBackgroundPreviewProps) {
  const notification = useRef<HTMLButtonElement>(null);
  const beacon = useRef(createUnreadBeacon());
  const [unreadOn, setUnreadOn] = useState(true);
  const [message, setMessage] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const participants = useRef<HTMLDivElement>(null);
  const speechTime = useRef(0);
  const wave = useRef(createThemeWave(false));
  const [light, setLight] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speechOn, setSpeechOn] = useState(true);
  const [backgroundOn, setBackgroundOn] = useState(true);
  const showBackground = enabled && backgroundOn;
  const [renderer, setRenderer] = useState('');
  const options = useRef({ light, paused, speed, reducedMotion, speechOn, strength, spread, showBackground, unread: unread && unreadOn, message });
  options.current = { light, paused, speed, reducedMotion, speechOn, strength, spread, showBackground, unread: unread && unreadOn, message };
  const people = useMemo(() => PEOPLE.slice(0, speakers === 'two' ? 2 : speakers === 'one' ? 1 : 0), [speakers]);
  const levels = useMemo(() => PEOPLE.map((_, i) => () => options.current.speechOn ? simulatedSpeech(speechTime.current, i) : 0), []);

  useEffect(() => {
    const elements = [...(participants.current?.querySelectorAll<HTMLElement>('.orb') ?? [])];
    const sources = people.map((person, i) => ({ element: elements[i]!, palette: person.palette, level: levels[i]! }));
    const painter = createBackground(canvas.current!, sources);
    setRenderer(painter?.renderer ?? 'WebGL unavailable — showing static dots');
    let time = 0;
    const stop = onTick((_now, dt) => {
      const { light, paused, speed, reducedMotion, strength, spread, showBackground, unread, message } = options.current;
      const step = paused ? 0 : dt * speed;
      const voiceStep = paused ? 0 : dt;
      time += voiceStep;
      speechTime.current += voiceStep;
      const reduced = reducedMotion || effectsReduced();
      const theme = wave.current.frame(light, step, reduced || !showBackground);
      if (!showBackground) { painter?.clear(); return; }
      const frame = beacon.current.frame(unread ? `message-${message}` : null, voiceStep, reduced);
      painter?.draw(time, sources.length ? strength : 0, spread, reduced, theme,
        unread && notification.current ? { element: notification.current, frame } : undefined);
    });
    return () => { stop(); painter?.dispose(); };
  }, [people, levels]);

  return (
    <div className="live-background-preview" data-theme={light ? 'light' : 'dark'}>
      <canvas ref={canvas} className="live-background-field" aria-hidden="true" hidden={!showBackground} />
      <header>
        <span>{unread ? 'One unread message' : 'Voice + theme transitions'}</span>
        <h1>{unread ? 'Unread message Beacon' : 'Live background'}</h1>
        <p>{unread ? 'Two ripples point to the mobile chat button or desktop counter. Replay a message, leave it unread for a quieter reminder, or mark it read. Reduced motion keeps a still accent.' : people.length ? 'Simulated speech stirs the dots while two theme currents collide. Toggle the theme during speech, or silence the voices to compare.' : 'Two currents spread from opposite corners. Dots surge with the edges, curl together in the centre, and settle into the new theme.'}</p>
      </header>
      {people.length > 0 && <div ref={participants} className="live-background-people">
        {people.map((person, i) => <div key={person.name} className="live-background-person">
          <Orb seed={`live-background-${person.name}`} palette={person.palette} level={levels[i]} />
          <div className="live-background-caption">
            <span>{person.name}</span>
            <small><i />Simulated voice</small>
          </div>
        </div>)}
      </div>}
      {unread && <button ref={notification} className="live-background-unread" aria-label={unreadOn ? 'Chat: 1' : 'Chat'} onClick={() => setUnreadOn(false)}>
        <Icon name="chat" />{unreadOn && <span className="badge">1</span>}
      </button>}
      <footer>
        {unread && <>
          <button type="button" onClick={() => { setUnreadOn(true); setMessage((n) => n + 1); }}>Replay message</button>
          <button type="button" onClick={() => setUnreadOn(!unreadOn)}>{unreadOn ? 'Mark read' : 'Restore unread'}</button>
        </>}
        <button type="button" onClick={() => setLight(!light)}>Switch to {light ? 'dark' : 'light'}</button>
        <button type="button" onClick={() => { wave.current = createThemeWave(!light); }}>Replay transition</button>
        <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        {people.length > 0 && <button type="button" aria-pressed={!speechOn} onClick={() => setSpeechOn(!speechOn)}>{speechOn ? 'Silence voices' : 'Resume voices'}</button>}
        <button type="button" aria-pressed={showBackground} disabled={!enabled} onClick={() => setBackgroundOn(!backgroundOn)}>{showBackground ? 'Live background on' : 'Static background'}</button>
        <span>{speed === 1 ? '600 ms' : `${(600 / speed).toLocaleString('en-US')} ms`} · {reducedMotion ? 'Reduced motion' : 'Toggle mid-wave to reverse'}</span>
      </footer>
      <details><summary>Renderer</summary><p>{renderer}</p></details>
    </div>
  );
}
