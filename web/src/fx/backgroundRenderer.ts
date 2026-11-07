/** Two passes on one canvas: a theme surface and a shared field of voice-reactive dots. */
import { hexToRgb } from './orbRenderer';
import { PALETTES } from './palette';
import { THEME_WAVE_GLSL, type ThemeFrame } from './themeWave';
import { createVoiceField, HISTORY, SAMPLE_INTERVAL, type VoiceSource } from './voiceField';

function vertexSource(count: number): string {
  return `
precision highp float;
attribute vec2 aPoint;
uniform vec2 uSize;
uniform float uTime, uDpr, uStrength, uSpread, uHistoryPhase;
${THEME_WAVE_GLSL}
uniform float uActive[${count}];
uniform vec4 uVoices[${count}];
uniform vec3 uColorsDark[${count}], uColorsLight[${count}];
uniform vec4 uHistory[${count * (HISTORY / 4)}];
varying vec4 vColor;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(cell), hash(cell + vec2(1., 0.)), f.x),
             mix(hash(cell + vec2(0., 1.)), hash(cell + vec2(1., 1.)), f.x), f.y);
}
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
  vec3 color = vec3(0.);
  float energy = 0.;
  for (int i = 0; i < ${count}; i++) {
    if (uActive[i] < .5) continue;
    vec4 voice = uVoices[i];
    vec2 delta = p - voice.xy;
    float distance = length(delta);
    vec2 outward = delta / max(distance, 1.);
    // Source strength is anchored at the orb's edge, never at a wandering noise patch.
    float fromEdge = max(0., distance - voice.w);
    float seed = float(i) * 17.31 + 3.7;
    float delay = fromEdge / 220.;
    float level = arrivingLevel(i, delay);
    if (level < .001) continue;
    float t = (uTime - delay) * .38 + seed;
    vec2 q = delta / 125. + seed;
    // Bend the noise domain so the moving patches never form concentric fronts.
    vec2 warp = vec2(noise(q * .57 + vec2(t * .29, -t * .21)),
                     noise(q * .57 + vec2(-t * .24, t * .33) + 19.7));
    q += (warp - .5) * 3.8 + vec2(t * .22, -t * .17);
    // Analytic curl avoids four extra noise samples per point and voice.
    float x = q.x * 1.3 + t * .3, y = q.y * .9 - t * .4;
    float diagonal = q.x * .7 + q.y * 1.6 - t * .6;
    float crosswise = q.x * 1.9 - q.y * .6 + t * .2;
    float dx = 1.3 * cos(x) * cos(y) + .35 * cos(diagonal) - .665 * sin(crosswise);
    float dy = -.9 * sin(x) * sin(y) + .8 * cos(diagonal) + .21 * sin(crosswise);
    float falloff = exp(-fromEdge / uSpread * 3.2);
    float patches = smoothstep(.18, .8, noise(q * .73 + 8.3));
    float force = level * uStrength * falloff * (.32 + patches * .9);
    // A small outward push makes the speaker readable through the stronger eddies.
    offset += (vec2(dy, -dx) * .78 + outward * .42) * force * 70.;
    color += mix(uColorsDark[i], uColorsLight[i], light) * force;
    energy += force;
  }
  p += offset + themeOffset;
  float glow = clamp(energy, 0., 1.);
  vec3 ink = mix(mix(vec3(1.), vec3(0.), light), themeTint, activity * .75);
  float opacity = .09 + .03 * light + activity * .48;
  vColor = vec4(mix(ink, color / max(energy, .001), min(1., glow * 2.)), mix(opacity, .8, glow));
  gl_Position = vec4(p.x / uSize.x * 2. - 1., 1. - p.y / uSize.y * 2., 0., 1.);
  gl_PointSize = (2.1 + glow * 2.8 + activity * 1.6) * uDpr;
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

export function createBackground(canvas: HTMLCanvasElement, sources: VoiceSource[]) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl) return null; // The CSS dots remain visible when WebGL isn't available.
  // Keep the theme wave available even when a room exceeds the voice uniform budget.
  if (Math.max(1, sources.length) * 12 + 16 > gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS)) sources = [];
  const count = Math.max(1, sources.length);
  const shaders: WebGLShader[] = [];
  const programs: WebGLProgram[] = [];
  const build = (vertex: string, fragment: string) => {
    const program = gl.createProgram();
    if (!program) return null;
    programs.push(program);
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) return null;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
  };
  const releasePrograms = () => {
    shaders.forEach((shader) => gl.deleteShader(shader));
    programs.forEach((program) => gl.deleteProgram(program));
  };
  const program = build(vertexSource(count), fragment);
  const surface = build(surfaceVertex, surfaceFragment);
  if (!program || !surface) { releasePrograms(); return null; }
  gl.useProgram(program);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = Object.fromEntries(['uSize', 'uTime', 'uDpr', 'uStrength', 'uSpread', 'uTheme', 'uThemeDirection', 'uThemeFromLight', 'uHistoryPhase', 'uActive[0]', 'uVoices[0]', 'uColorsDark[0]', 'uColorsLight[0]', 'uHistory[0]'].map((name) => [name, uniform(name)]));
  const surfaceUniforms = Object.fromEntries(['uSize', 'uDpr', 'uTheme', 'uThemeFromLight'].map((name) => [name, gl.getUniformLocation(surface, name)]));
  const surfaceAttribute = gl.getAttribLocation(surface, 'aPoint');
  const surfaceBuffer = gl.createBuffer();
  const buffer = gl.createBuffer();
  if (!buffer || !surfaceBuffer) {
    gl.deleteBuffer(buffer);
    gl.deleteBuffer(surfaceBuffer);
    releasePrograms();
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, surfaceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const attribute = gl.getAttribLocation(program, 'aPoint');
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  const field = createVoiceField(count);
  const { voices, history, active } = field;
  const colorsDark = new Float32Array(count * 3);
  const colorsLight = new Float32Array(count * 3);
  const sourceColors = sources.slice(0, count).map(({ palette }) => ({ dark: hexToRgb(PALETTES[palette][1]), light: hexToRgb(PALETTES[palette][0]) }));
  let width = 0;
  let height = 0;
  let points = 0;
  let geometryDirty = true;
  let measuredDpr = 0;
  sourceColors.forEach((color, i) => { colorsDark.set(color.dark, i * 3); colorsLight.set(color.light, i * 3); });
  let drawn: { time: number; strength: number; spread: number; reduced: boolean; moving: boolean; theme: ThemeFrame } | undefined;
  const invalidate = () => { geometryDirty = true; };
  const resized = new ResizeObserver(invalidate);
  resized.observe(canvas);
  for (const source of sources) resized.observe(source.element);
  window.addEventListener('resize', invalidate);
  document.fonts.addEventListener('loadingdone', invalidate);
  const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debugRenderer ? debugRenderer.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  canvas.dataset.ready = 'true';

  return {
    renderer,
    invalidateLayout: invalidate,
    draw(time: number, strength: number, spread: number, reduced: boolean, theme: ThemeFrame) {
      if (gl.isContextLost()) { delete canvas.dataset.ready; return; }
      // Tiny soft points don't benefit from a full 2x/3x screen-sized buffer.
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      const layoutChanged = geometryDirty || measuredDpr !== dpr;
      if (layoutChanged) {
        const bounds = canvas.getBoundingClientRect();
        geometryDirty = false;
        measuredDpr = dpr;
        width = bounds.width;
        height = bounds.height;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const positions: number[] = [];
        for (let y = 10; y < height; y += 20) for (let x = 10; x < width; x += 20) positions.push(x, y);
        points = positions.length / 2;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
        gl.viewport(0, 0, canvas.width, canvas.height);
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
      const moving = !reduced && strength > 0 && voice.moving;
      // Keep the last frame while paused or silent, rather than clearing a
      // screen-sized buffer every frame just to draw the identical dot grid.
      if (!layoutChanged && !themeChanged && drawn && drawn.strength === strength && drawn.spread === spread && drawn.reduced === reduced && drawn.moving === moving && (!moving || drawn.time === time)) return;
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
      drawn = { time, strength, spread, reduced, moving, theme };
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
      releasePrograms();
      canvas.width = canvas.height = 1;
    },
  };
}
