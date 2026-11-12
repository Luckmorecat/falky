/** Two passes on one canvas: a theme surface and a shared field of voice-reactive dots. */
import { hexToRgb } from './orbRenderer';
import { PALETTES } from './palette';
import { UNREAD_BEACON_GLSL, type BeaconFrame } from './unreadBeacon';
import { THEME_WAVE_GLSL, type ThemeFrame } from './themeWave';
import { createVoiceField, HISTORY, SAMPLE_INTERVAL, type VoiceSource } from './voiceField';

function vertexSource(count: number): string {
  return `
precision highp float;
attribute vec2 aPoint;
uniform vec2 uSize;
uniform float uTime, uDpr, uStrength, uSpread, uHistoryPhase;
${THEME_WAVE_GLSL}
${UNREAD_BEACON_GLSL}
uniform float uActive[${count}];
uniform vec4 uVoices[${count}];
uniform vec3 uColorsDark[${count}], uColorsLight[${count}];
uniform vec4 uHistory[${count * (HISTORY / 4)}];
varying vec4 vColor;

float historyLevel(int voice, int index) {
  vec4 samples = uHistory[voice * ${HISTORY / 4} + index / 4];
  float channel = mod(float(index), 4.);
  return channel < .5 ? samples.x : channel < 1.5 ? samples.y : channel < 2.5 ? samples.z : samples.w;
}
float arrivingLevel(int voice, float delay) {
  // History contains fixed-time samples. Slide between them every frame;
  // shifting the buffer without this phase makes distant dots jump at 10 Hz.
  float sample = clamp((delay - uHistoryPhase) / ${SAMPLE_INTERVAL}, 0., ${HISTORY - 1}.);
  int a = int(floor(sample));
  int b = int(min(floor(sample) + 1., ${HISTORY - 1}.));
  float level = mix(historyLevel(voice, a), historyLevel(voice, b), fract(sample));
  if (delay < uHistoryPhase) {
    level = mix(uVoices[voice].z, historyLevel(voice, 0), delay / max(uHistoryPhase, .0001));
  }
  return level * (1. - smoothstep(2.5, 3.1, delay));
}

void main() {
  vec2 p = aPoint;
  float light, activity;
  vec2 themeOffset;
  vec3 themeTint;
  themeDot(aPoint, light, themeOffset, themeTint, activity);
  vec2 offset = vec2(0.);
  vec3 voiceColor = vec3(0.);
  vec3 restColor = vec3(0.);
  float voiceEnergy = 0.;
  float restEnergy = 0.;
  // Neutral on both themes. Silence settles here instead of fading the field out.
  vec3 gray = mix(vec3(.76, .76, .74), vec3(.40, .40, .38), light);
  for (int i = 0; i < ${count}; i++) {
    vec4 voice = uVoices[i];
    // uActive is 0 while silent. step() keeps that uniform, and the gray field still draws.
    if (step(1., voice.w) * step(0., uActive[i]) < .5) continue;
    vec2 delta = p - voice.xy;
    float distance = length(delta);
    vec2 outward = delta / max(distance, 1.);
    float fromEdge = max(0., distance - voice.w);
    float seed = float(i) * 17.31 + 3.7;
    float level = arrivingLevel(i, fromEdge / 220.);
    float reach = exp(-fromEdge / max(uSpread, 1.) * 1.05);
    // A bright band walks outward. The gap between bands is the quiet part of the wave.
    float band = abs(fract(fromEdge / 168. - uTime * .9 + seed) - .32);
    float crest = 1. - smoothstep(.02, .2, band);
    float speak = smoothstep(.03, .2, level);
    float amp = crest * level * uStrength * reach;
    float rest = exp(-pow(fromEdge / max(voice.w * 1.15, 72.), 2.));
    vec2 vel = outward * amp * 100.;
    float wall = 0.;
    float returning = 0.;
    for (int j = 0; j < ${count}; j++) {
      if (j == i) continue;
      vec4 other = uVoices[j];
      if (step(1., other.w) * step(0., uActive[j]) < .5) continue;
      vec2 otherDelta = p - other.xy;
      float otherDistance = length(otherDelta);
      vec2 otherOut = otherDelta / max(otherDistance, 1.);
      float otherEdge = max(0., otherDistance - other.w);
      float otherLevel = arrivingLevel(j, otherEdge / 220.);
      vec2 apart = other.xy - voice.xy;
      float gap = max(length(apart), 1.);
      float along = dot(delta, apart / gap);
      float contact = voice.w + (gap - voice.w - other.w) * .5;
      float oppose = max(0., -dot(outward, otherOut));
      float otherThere = smoothstep(.05, .22, otherLevel);
      // The outgoing crest stops on the line between two voices and walks back.
      wall = max(wall, smoothstep(-16., 42., along - contact) * oppose * otherThere);
      float backDist = max(0., contact - along);
      float backBand = abs(fract(backDist / 168. - uTime * .9 + seed + .2) - .32);
      float facing = oppose * otherThere * smoothstep(8., 36., backDist);
      returning = max(returning, (1. - smoothstep(.02, .2, backBand)) * facing);
      float otherReach = exp(-otherEdge / max(uSpread, 1.) * 1.05);
      float otherBand = abs(fract(otherEdge / 168. - uTime * .9 + float(j) * 17.31 + 3.7) - .32);
      float otherCrest = 1. - smoothstep(.02, .2, otherBand);
      float otherAmp = otherCrest * otherLevel * uStrength * otherReach;
      float clash = oppose * smoothstep(.04, .25, amp) * smoothstep(.04, .25, otherAmp);
      vel = mix(vel, vel - 2. * dot(vel, otherOut) * otherOut, clash);
    }
    crest *= 1. - wall;
    vel *= 1. - wall;
    vel += -outward * returning * level * uStrength * 90.;
    offset += vel;
    float restWeight = rest * (1. - smoothstep(0., .12, level));
    // A dying voice goes gray before it disappears. A live crest keeps its colour.
    float grayBody = reach * smoothstep(0., .14, level) * (1. - speak);
    float colorBody = max(crest, returning) * speak * mix(.55, 1., reach);
    restColor += gray * (restWeight + grayBody);
    restEnergy += restWeight + grayBody;
    voiceColor += mix(uColorsDark[i], uColorsLight[i], light) * colorBody;
    voiceEnergy += colorBody;
  }
  vec2 beaconOffset;
  float beaconGlow;
  unreadBeacon(aPoint, beaconOffset, beaconGlow);
  p += offset + themeOffset + beaconOffset;
  float glow = clamp(voiceEnergy, 0., 1.);
  float settled = clamp(restEnergy, 0., 1.);
  vec3 field = (voiceColor + restColor) / max(voiceEnergy + restEnergy, .001);
  vec3 ink = mix(mix(vec3(1.), vec3(0.), light), themeTint, activity * .75);
  float opacity = .09 + .03 * light + activity * .48;
  opacity = mix(opacity, .62, settled);
  vColor = vec4(mix(ink, field, min(1., glow + settled)), mix(opacity, .92, glow));
  vec3 beaconInk = mix(vec3(.675, .906, .812), vec3(.094, .408, .337), light);
  vColor.rgb = mix(vColor.rgb, beaconInk, min(1., beaconGlow * 2.));
  vColor.a = max(vColor.a, beaconGlow * .85);
  gl_Position = vec4(p.x / uSize.x * 2. - 1., 1. - p.y / uSize.y * 2., 0., 1.);
  gl_PointSize = (2.1 + glow * 6.2 + activity * 1.6 + min(1., beaconGlow) * 2.8) * uDpr;
}`;
}
const fragment = `
precision mediump float;
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - .5) * 2.;
  float alpha = (1. - smoothstep(.5, 1., d)) * vColor.a;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}`;

const surfaceVertex = `
attribute vec2 aPoint;
void main() { gl_Position = vec4(aPoint, 0., 1.); }
`;
const surfaceFragment = `
precision highp float;
uniform vec2 uSize;
uniform float uDpr;
${THEME_WAVE_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x / uDpr, uSize.y - gl_FragCoord.y / uDpr);
  // Match --bg in styles.css; stay opaque while CSS changes underneath.
  vec3 color = mix(vec3(22., 22., 21.) / 255., vec3(1.), themeAt(p));
  gl_FragColor = vec4(color, 1.);
}`;

export function createBackground(canvas: HTMLCanvasElement, initialSources: VoiceSource[]) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl) return null; // The CSS dots remain visible when WebGL isn't available.
  const maxVoices = Math.floor(((gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) as number) - 17) / 12);
  const build = (vertex: string, fragment: string) => {
    const program = gl.createProgram();
    if (!program) return null;
    const shaders: WebGLShader[] = [];
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) {
        shaders.forEach((entry) => gl.deleteShader(entry));
        gl.deleteProgram(program);
        return null;
      }
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    shaders.forEach((shader) => { gl.detachShader(program, shader); gl.deleteShader(shader); });
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    gl.deleteProgram(program);
    return null;
  };
  const surface = build(surfaceVertex, surfaceFragment);
  if (!surface) return null;
  let program: WebGLProgram | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let attribute = 0;
  let count = 0;
  let sources: VoiceSource[] = [];
  let field = createVoiceField(1);
  let colorsDark = new Float32Array(3);
  let colorsLight = new Float32Array(3);
  const surfaceUniforms = Object.fromEntries(['uSize', 'uDpr', 'uTheme', 'uThemeFromLight'].map((name) => [name, gl.getUniformLocation(surface, name)]));
  const surfaceAttribute = gl.getAttribLocation(surface, 'aPoint');
  const surfaceBuffer = gl.createBuffer();
  const buffer = gl.createBuffer();
  if (!buffer || !surfaceBuffer) {
    gl.deleteBuffer(buffer);
    gl.deleteBuffer(surfaceBuffer);
    gl.deleteProgram(surface);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, surfaceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  let width = 0;
  let height = 0;
  let points = 0;
  let geometryDirty = true;
  let measuredDpr = 0;
  let beaconTarget: HTMLElement | undefined;
  let beaconX = 0, beaconY = 0;
  let drawn: { beaconPhase: number; beaconStrength: number; time: number; strength: number; spread: number; reduced: boolean; moving: boolean; theme: ThemeFrame } | undefined;
  const invalidate = () => { geometryDirty = true; };
  const resized = new ResizeObserver(invalidate);
  resized.observe(canvas);
  const setSources = (next: VoiceSource[]): boolean => {
    // Keep the theme wave when a room exceeds the voice uniform budget.
    if (next.length > maxVoices) next = [];
    const nextCount = Math.max(1, next.length);
    const changed = count !== nextCount || next.length !== sources.length
      || next.some((source, i) => source.element !== sources[i]?.element || source.palette !== sources[i]?.palette);
    if (count !== nextCount) {
      const nextProgram = build(vertexSource(nextCount), fragment);
      if (!nextProgram) return false;
      gl.deleteProgram(program);
      program = nextProgram;
      count = nextCount;
      attribute = gl.getAttribLocation(program, 'aPoint');
      uniforms = Object.fromEntries(['uBeacon', 'uSize', 'uTime', 'uDpr', 'uStrength', 'uSpread', 'uTheme', 'uThemeDirection', 'uThemeFromLight', 'uHistoryPhase', 'uActive[0]', 'uVoices[0]', 'uColorsDark[0]', 'uColorsLight[0]', 'uHistory[0]'].map((name) => [name, gl.getUniformLocation(nextProgram, name)]));
      field = createVoiceField(count);
      colorsDark = new Float32Array(count * 3);
      colorsLight = new Float32Array(count * 3);
    }
    if (changed) {
      for (const source of sources) resized.unobserve(source.element);
      for (let i = 0; i < next.length; i++) {
        const source = next[i]!;
        resized.observe(source.element);
        colorsDark.set(hexToRgb(PALETTES[source.palette][1]), i * 3);
        colorsLight.set(hexToRgb(PALETTES[source.palette][0]), i * 3);
      }
      field.clear();
      geometryDirty = true;
      drawn = undefined;
    }
    sources = next;
    return true;
  };
  if (!setSources(initialSources)) {
    resized.disconnect();
    gl.deleteBuffer(buffer);
    gl.deleteBuffer(surfaceBuffer);
    gl.deleteProgram(surface);
    return null;
  }
  window.addEventListener('resize', invalidate);
  document.fonts.addEventListener('loadingdone', invalidate);
  const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debugRenderer ? debugRenderer.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  canvas.dataset.ready = 'true';

  return {
    renderer,
    setSources,
    invalidateLayout: invalidate,
    draw(time: number, strength: number, spread: number, reduced: boolean, theme: ThemeFrame,
      beacon?: { element: HTMLElement; frame: BeaconFrame }) {
      if (gl.isContextLost()) { delete canvas.dataset.ready; return; }
      if (beaconTarget !== beacon?.element) {
        if (beaconTarget) resized.unobserve(beaconTarget);
        beaconTarget = beacon?.element;
        if (beaconTarget) resized.observe(beaconTarget);
        geometryDirty = true;
      }
      const { voices, history, active } = field;
      // Tiny soft points don't benefit from a full 2x/3x screen-sized buffer.
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      const layoutChanged = geometryDirty || measuredDpr !== dpr;
      if (layoutChanged) {
        const bounds = canvas.getBoundingClientRect();
        geometryDirty = false;
        const sizeChanged = width !== bounds.width || height !== bounds.height || measuredDpr !== dpr;
        measuredDpr = dpr;
        width = bounds.width;
        height = bounds.height;
        if (sizeChanged) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
          const positions: number[] = [];
          for (let y = 10; y < height; y += 20) for (let x = 10; x < width; x += 20) positions.push(x, y);
          points = positions.length / 2;
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
          gl.viewport(0, 0, canvas.width, canvas.height);
        }
        if (beaconTarget) {
          const rect = beaconTarget.getBoundingClientRect();
          beaconX = rect.left + rect.width / 2 - bounds.left;
          beaconY = rect.top + rect.height / 2 - bounds.top;
        }
        for (let i = 0; i < Math.min(sources.length, count); i++) {
          const rect = sources[i]!.element.getBoundingClientRect();
          voices[i * 4] = rect.left + rect.width / 2 - bounds.left;
          voices[i * 4 + 1] = rect.top + rect.height / 2 - bounds.top;
          voices[i * 4 + 3] = Math.min(rect.width, rect.height) * .5;
        }
      }
      if (!width || !height) return;
      const voice = field.update(time, sources);
      const themeChanged = drawn?.theme.progress !== theme.progress || drawn?.theme.direction !== theme.direction || drawn?.theme.fromLight !== theme.fromLight;
      const beaconPhase = beacon?.frame.phase ?? 0;
      const beaconStrength = beacon?.frame.strength ?? 0;
      const beaconChanged = drawn?.beaconStrength !== beaconStrength || (beaconStrength > 0 && drawn?.beaconPhase !== beaconPhase);
      const moving = !reduced && ((strength > 0 && voice.moving) || beaconStrength > 0);
      // Keep the last frame while paused or silent, rather than clearing a
      // screen-sized buffer every frame just to draw the identical dot grid.
      if (!layoutChanged && !themeChanged && !beaconChanged && drawn && drawn.strength === strength && drawn.spread === spread && drawn.reduced === reduced && drawn.moving === moving && (!moving || drawn.time === time)) return;
      gl.useProgram(surface);
      gl.bindBuffer(gl.ARRAY_BUFFER, surfaceBuffer);
      gl.enableVertexAttribArray(surfaceAttribute);
      gl.vertexAttribPointer(surfaceAttribute, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(surfaceUniforms.uSize!, width, height);
      gl.uniform1f(surfaceUniforms.uDpr!, dpr);
      gl.uniform1f(surfaceUniforms.uTheme!, theme.progress);
      gl.uniform1f(surfaceUniforms.uThemeFromLight!, theme.fromLight ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(uniforms.uBeacon!, beaconX, beaconY, beaconPhase, beaconStrength);
      gl.uniform2f(uniforms.uSize!, width, height);
      gl.uniform1f(uniforms.uTime!, time);
      gl.uniform1f(uniforms.uDpr!, dpr);
      gl.uniform1f(uniforms.uStrength!, reduced ? 0 : strength);
      gl.uniform1f(uniforms.uSpread!, spread);
      gl.uniform1f(uniforms.uTheme!, theme.progress);
      gl.uniform1f(uniforms.uThemeDirection!, reduced ? 0 : theme.direction);
      gl.uniform1f(uniforms.uThemeFromLight!, theme.fromLight ? 1 : 0);
      gl.uniform1f(uniforms.uHistoryPhase!, voice.phase);
      gl.uniform1fv(uniforms['uActive[0]']!, active);
      gl.uniform4fv(uniforms['uVoices[0]']!, voices);
      gl.uniform3fv(uniforms['uColorsDark[0]']!, colorsDark);
      gl.uniform3fv(uniforms['uColorsLight[0]']!, colorsLight);
      gl.uniform4fv(uniforms['uHistory[0]']!, history);
      gl.drawArrays(gl.POINTS, 0, points);
      drawn = { beaconPhase, beaconStrength, time, strength, spread, reduced, moving, theme };
    },
    clear() {
      field.clear();
      drawn = undefined;
    },
    dispose() {
      delete canvas.dataset.ready;
      resized.disconnect();
      window.removeEventListener('resize', invalidate);
      document.fonts.removeEventListener('loadingdone', invalidate);
      gl.deleteBuffer(buffer);
      gl.deleteBuffer(surfaceBuffer);
      gl.deleteProgram(program);
      gl.deleteProgram(surface);
      canvas.width = canvas.height = 1;
    },
  };
}
