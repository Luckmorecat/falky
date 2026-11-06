import { useEffect, useMemo, useRef, useState } from 'react';
import { Orb } from '../../src/ui/Orb';
import { effectsReduced, onTick } from '../../src/fx/ticker';
import type { PaletteName } from '../../src/fx/palette';
import { createVoiceBackground } from '../../src/fx/voiceBackgroundRenderer';
import './voiceBackgroundPrototype.css';

// Storybook-only prototype: does a field of dots carry a voice beyond its orb?
// Compare silence, a single voice, and overlapping voices using the story controls.
export interface VoiceBackgroundPrototypeProps {
  scenario: 'idle' | 'one-speaker' | 'overlapping';
  strength: number;
  spread: number;
  paused: boolean;
  enabled: boolean;
}

function speech(time: number, index: number): number {
  const phrase = (time + index * 1.8) % 7.5;
  if (phrase > 4.9) return 0;
  const envelope = Math.min(1, phrase / .25, (4.9 - phrase) / .45);
  const syllables = .22 + .55 * Math.pow(.5 + .5 * Math.sin(time * 12 + index * 3), 2);
  return envelope * syllables * (.75 + .25 * Math.sin(time * 2.7 + index));
}

const PEOPLE: { name: string; palette: PaletteName }[] = [
  { name: 'Alex', palette: 'sky' },
  { name: 'Sam', palette: 'rose' },
  { name: 'Jamie', palette: 'lagoon' },
];
const LABELS = { idle: 'Quiet room', 'one-speaker': 'One voice', overlapping: 'Two voices' };

export function VoiceBackgroundPrototype({ scenario, strength, spread, paused, enabled }: VoiceBackgroundPrototypeProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const time = useRef(0);
  const [playing, setPlaying] = useState(true);
  const [shaderOn, setShaderOn] = useState(true);
  const [renderer, setRenderer] = useState('');
  const run = playing && !paused;
  const showShader = enabled && shaderOn;
  const options = useRef({ run, showShader, strength, spread });
  options.current = { run, showShader, strength, spread };
  const levels = useMemo(() => PEOPLE.map((_, i) => () => {
    const active = scenario === 'overlapping' ? i < 2 : scenario === 'one-speaker' && i === 0;
    return active ? speech(time.current, i) : 0;
  }), [scenario]);

  useEffect(() => {
    const elements = [...stage.current!.querySelectorAll<HTMLElement>('.voice-bg-person .orb')];
    const painter = createVoiceBackground(canvas.current!, PEOPLE.map((person, i) => ({ element: elements[i]!, palette: person.palette, level: levels[i]! })));
    setRenderer(painter?.renderer ?? 'WebGL unavailable — showing static CSS dots');
    time.current = 0;
    const stop = onTick((_now, dt) => {
      const { run, showShader, strength, spread } = options.current;
      if (document.hidden) return;
      if (run) time.current += dt;
      if (!showShader) { painter?.clear(); return; }
      painter?.draw(time.current, strength, spread, effectsReduced());
    });
    return () => { stop(); painter?.dispose(); };
  }, [levels]);

  return (
    <div ref={stage} className="voice-bg-prototype" data-scenario={scenario}>
      <canvas ref={canvas} className="voice-bg-field" aria-hidden="true" hidden={!showShader} />
      <header className="voice-bg-heading">
        <span className="voice-bg-eyebrow">Background experiment</span>
        <h1>Give every voice a little space.</h1>
        <p>Each voice stirs the dots at its orb, drifting outward and fading into the room.</p>
      </header>
      <div className="voice-bg-people">
        {PEOPLE.map((person, i) => <div key={person.name} className="voice-bg-person">
          <Orb seed={`voice-background-${person.name}`} palette={person.palette} level={levels[i]} />
          <span className="voice-bg-name">{person.name}</span>
          <span className="voice-bg-meter" aria-hidden="true" />
        </div>)}
      </div>
      <footer className="voice-bg-toolbar">
        <div><strong>{LABELS[scenario]}</strong><span>Simulated speech · no microphone</span></div>
        <button type="button" aria-pressed={!run} onClick={() => setPlaying(!playing)} disabled={paused}>{run ? 'Pause speech' : 'Resume speech'}</button>
        <button type="button" aria-pressed={showShader} onClick={() => setShaderOn(!shaderOn)} disabled={!enabled}>{showShader ? 'Shader on' : 'Original dots'}</button>
      </footer>
      <details className="voice-bg-renderer"><summary>Renderer</summary><p>{renderer}</p></details>
    </div>
  );
}
