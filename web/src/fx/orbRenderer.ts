import { SQUIRCLE_N } from './squircle';
import { effectsReduced, onTick } from './ticker';

/**
 * Draws every orb with one shader on one hidden WebGL context, then copies each
 * result to the orb's own canvas: browsers allow few contexts, and Falky runs
 * next to games. Someone silent is redrawn a few times a second; only a voice
 * gets every frame.
 */

/**
 * How an orb is lit; both are a flat picture painted per pixel, not a 3D model.
 * `flat` is a soft sphere fitted to the shape. `volume` adds a relief and a glow
 * while it talks, draws past the shape for that, and costs about twice as much.
 */
export type OrbLook = 'flat' | 'volume';

/** The most pixels an orb is drawn at; its shapes are soft, so more shows nothing. */
const MAX_SIZE: Record<OrbLook, number> = { flat: 512, volume: 768 };
const CANVAS_SIZE = Math.max(MAX_SIZE.flat, MAX_SIZE.volume);
const IDLE_INTERVAL = 1 / 15;

/** How much bigger than the shape a `volume` canvas is; styles.css makes it so. */
const VOLUME_PAD = 1.36;

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos, 0., 1.); }`;

/** Both looks pour the same colours over the same surface; only the light differs. */
const COMMON = `
precision highp float;
varying vec2 vUv;
uniform vec3 uBase, uBright, uDeep, uCore;
uniform float uSeed, uAngle, uFlow, uLevel, uPixel;
const float N = ${SQUIRCLE_N.toFixed(2)};

float hash(vec3 p) {
  p = fract(p * .3183099 + .1);
  p *= 17.;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3. - 2. * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) { return noise(p) * .84 + noise(p * 2.03 + 3.1) * .16; }

// 1 on the outline, 0 in the middle, more than 1 outside.
float shape(vec2 p) {
  vec2 a = abs(p);
  return pow(pow(a.x, N) + pow(a.y, N), 1. / N);
}

// Mix the coordinates before multiplying so grain cannot collapse along a row or column.
// Keep the cloud hash separate: changing it would change the flowing colour pattern.
float grainHash(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Where on the turning colours a point of the surface lies.
vec3 place(vec3 n) {
  float c = cos(uAngle), s = sin(uAngle);
  vec3 p = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  return vec3(p.x, .94 * p.y - .34 * p.z, .34 * p.y + .94 * p.z) * .95;
}

// The poured colours at a surface point; pool is the warped point, cloud how much lies there.
vec3 pour(vec3 n, out vec3 pool, out float cloud) {
  vec3 p = place(n) + uSeed;
  vec2 q = vec2(fbm(p + vec3(0., 0., uFlow)), fbm(p + vec3(5.2, 1.3, -uFlow * .8)));
  float warp = 1.7 + uLevel * 1.1;
  pool = p + vec3(q, q.x) * warp;
  cloud = fbm(pool);
  float under = fbm(p * 1.1 + vec3(q.yx, q.y) * warp + 7.7);
  vec3 col = mix(uBase, uDeep, smoothstep(.5, .74, under) * .85);
  col = mix(col, uBright, smoothstep(.4, .64, cloud));
  return mix(col, uCore, smoothstep(.54, .74, cloud) * (.82 + uLevel * .18));
}

// A soft sphere's surface, fitted to the shape: it bulges from every side alike.
vec3 fitted(vec2 uv, float d) {
  return vec3(uv / max(length(uv), 1e-4) * min(d, 1.), sqrt(max(0., 1. - d * d)));
}
`;

const FLAT = `${COMMON}
void main() {
  float d = shape(vUv);
  float alpha = smoothstep(1., 1. - uPixel * 1.6, d);
  if (alpha <= 0.) { gl_FragColor = vec4(0.); return; }

  vec3 n = fitted(vUv, d), pool;
  float cloud;
  vec3 col = pour(n, pool, cloud);

  // Light from the upper left, with a shadow in the orb's own colour, not grey.
  vec3 light = normalize(vec3(-.5, .62, .72));
  float diffuse = max(dot(n, light), 0.);
  vec3 shadow = mix(uDeep, uBase, .55) * .86;
  col = mix(col, shadow, (1. - smoothstep(.0, .72, diffuse)) * .62);
  col += pow(max(dot(n, normalize(light + vec3(0., 0., 1.))), 0.), 14.) * .07;

  col *= 1. + uLevel * .14;

  // The thin bright edge a soft sphere has, stronger while it talks.
  float edge = pow(1. - n.z, 3.2);
  col = mix(col, mix(uBright, vec3(1.), .35), edge * (.5 + uLevel * .5));

  col += (grainHash(vec3(gl_FragCoord.xy, uSeed)) - .5) * .045;
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const VOLUME = `${COMMON}
const float PAD = ${VOLUME_PAD.toFixed(2)};

void main() {
  vec2 uv = vUv * PAD;
  float d = shape(uv);
  float alpha = smoothstep(1., 1. - uPixel * 1.6, d);

  // Behind it: only the glow a voice feeds.
  float past = max(d - 1., 0.);
  float glow = exp(-past * (12. - 6.5 * uLevel)) * uLevel * .62 * smoothstep(.35, .12, past);
  vec4 behind = vec4(mix(uBase, uBright, .5) * glow, glow * .55);
  if (alpha <= 0.) { gl_FragColor = behind; return; }

  vec3 n = fitted(uv, d), pool;
  float cloud;
  vec3 col = pour(n, pool, cloud);

  // The real surface: flat in the middle and rolling away at the edges, so the
  // corners catch the light as well as the sides.
  vec2 a = abs(uv) + 1e-4;
  vec2 slope = sign(uv) * pow(a, vec2(N - 1.)) * pow(pow(a.x, N) + pow(a.y, N), 1. / N - 1.);
  vec3 surface = vec3(slope * d / sqrt(max(.004, 1. - d * d)), 1.);

  // The poured colours stand slightly proud of it, as thick paint does.
  vec3 ref = place(n);
  float rx = fbm(pool + place(n + vec3(.035, 0., 0.)) - ref) - cloud;
  float ry = fbm(pool + place(n + vec3(0., .035, 0.)) - ref) - cloud;
  surface.xy -= vec2(rx, ry) / .035 * .1;
  surface = normalize(surface);

  vec3 light = normalize(vec3(-.5, .62, .72));
  float diffuse = max(dot(surface, light), 0.);
  vec3 shadow = mix(uDeep, uBase, .32) * .6;
  col = mix(col, shadow, (1. - smoothstep(.08, .82, diffuse)) * .78);

  // Colour thrown back onto the far side, so the shadow does not go dead.
  col += uBright * pow(max(dot(surface, normalize(vec3(.55, -.72, .22))), 0.), 2.6) * .3;

  // A broad sheen and a small highlight.
  float gloss = max(dot(surface, normalize(light + vec3(0., 0., 1.))), 0.);
  col += pow(gloss, 7.) * .09 + pow(gloss, 42.) * .16;

  // Lit from within while it talks.
  col += uCore * (1. - smoothstep(0., .9, d)) * uLevel * .2;
  col *= 1. + uLevel * .14;

  float rim = pow(1. - surface.z, 3.);
  col = mix(col, mix(uBright, vec3(1.), .4), rim * (.36 + uLevel * .5));

  col += (grainHash(vec3(gl_FragCoord.xy, uSeed)) - .5) * .03;
  gl_FragColor = vec4(col * alpha, alpha) + behind * (1. - alpha);
}`;

const SOURCES: Record<OrbLook, string> = { flat: FLAT, volume: VOLUME };
const UNIFORMS = ['uBase', 'uBright', 'uDeep', 'uCore', 'uSeed', 'uAngle', 'uFlow', 'uLevel', 'uPixel'];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Whether an orb is due for drawing, given how loud it is and when it last was. */
export function isDue(level: number, sinceLast: number): boolean {
  return level > 0.03 || sinceLast >= IDLE_INTERVAL;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Painter {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  /** Built when first needed; null once a look turned out not to build here. */
  programs: Partial<Record<OrbLook, Program | null>>;
}

let painter: Painter | null = null;
let unavailable = false;
let lost = false;
let look: OrbLook = 'flat';

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function programFor(p: Painter, wanted: OrbLook): Program | null {
  const known = p.programs[wanted];
  if (known !== undefined) return known;
  const { gl } = p;
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, SOURCES[wanted]));
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  const built = gl.getProgramParameter(program, gl.LINK_STATUS)
    ? { program, uniforms: Object.fromEntries(UNIFORMS.map((u) => [u, gl.getUniformLocation(program, u)])) }
    : null;
  if (!built) console.warn(`The ${wanted} orb shader did not build`, gl.getProgramInfoLog(program));
  p.programs[wanted] = built;
  return built;
}

function setUp(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): Painter | null {
  const p: Painter = { gl, canvas, programs: {} };
  if (!programFor(p, 'flat')) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return p;
}

function getPainter(): Painter | null {
  if (painter || unavailable || lost) return painter;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CANVAS_SIZE;
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  painter = gl && setUp(canvas, gl);
  unavailable = !painter;
  if (gl) {
    // A lost context keeps the last pictures on screen until it comes back.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      lost = true;
      painter = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      lost = false;
      painter = setUp(canvas, gl);
      for (const orb of orbs) orb.stale = true;
    });
  }
  return painter;
}

/** The look this machine can show: the wanted one, unless its shader did not build here. */
function shownLook(): OrbLook {
  const p = getPainter();
  return look === 'volume' && p && !programFor(p, 'volume') ? 'flat' : look;
}

/** Changes how every orb is lit, at once; the new canvas size follows by itself. */
export function setOrbLook(next: OrbLook): void {
  if (next === look) return;
  look = next;
  const shown = shownLook();
  for (const orb of orbs) {
    orb.root.classList.toggle('volume', shown === 'volume');
    orb.stale = true;
  }
}

export interface OrbOptions {
  /** The orb's element: it gets `speaking` and `volume` and, without WebGL, `flat`. */
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  seed: number;
  colors: readonly [string, string, string, string];
  level?: () => number;
  /** Drawn once and left alone, for small marks. */
  still?: boolean;
}

interface LiveOrb extends OrbOptions {
  ctx: CanvasRenderingContext2D | null;
  rgb: [number, number, number][];
  size: number;
  lvl: number;
  drawnLvl: number;
  angle: number;
  flow: number;
  lastDraw: number;
  stale: boolean;
  speaking: boolean;
}

const orbs = new Set<LiveOrb>();
let stopTicking: (() => void) | null = null;

function draw(orb: LiveOrb, p: Painter, { uniforms: u }: Program, pad: number, time: number): void {
  const { gl } = p;
  if (!orb.ctx || !orb.size) return;
  gl.viewport(0, 0, orb.size, orb.size);
  gl.uniform3fv(u.uBase!, orb.rgb[0]!);
  gl.uniform3fv(u.uBright!, orb.rgb[1]!);
  gl.uniform3fv(u.uDeep!, orb.rgb[2]!);
  gl.uniform3fv(u.uCore!, orb.rgb[3]!);
  gl.uniform1f(u.uSeed!, (orb.seed % 997) / 13);
  gl.uniform1f(u.uAngle!, orb.angle);
  gl.uniform1f(u.uFlow!, orb.flow);
  gl.uniform1f(u.uLevel!, orb.lvl);
  gl.uniform1f(u.uPixel!, (2 * pad) / orb.size);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  orb.ctx.clearRect(0, 0, orb.size, orb.size);
  orb.ctx.drawImage(p.canvas, 0, CANVAS_SIZE - orb.size, orb.size, orb.size, 0, 0, orb.size, orb.size);
  orb.lastDraw = time;
  orb.drawnLvl = orb.lvl;
  orb.stale = false;
}

function tick(time: number, dt: number): void {
  const p = painter ?? getPainter();
  const reduced = effectsReduced();
  const shown = shownLook();
  const program = p && programFor(p, shown);
  const pad = shown === 'volume' ? VOLUME_PAD : 1;
  if (p && program) p.gl.useProgram(program.program);
  for (const orb of orbs) {
    const target = orb.level ? orb.level() : 0;
    orb.lvl += (target - orb.lvl) * (1 - Math.exp(-dt * (target > orb.lvl ? 26 : 4.5)));
    if (orb.lvl > 0.22 !== orb.speaking && (orb.lvl > 0.22 || orb.lvl < 0.12)) {
      orb.speaking = orb.lvl > 0.22;
      orb.root.classList.toggle('speaking', orb.speaking);
    }
    if (orb.level || orb.speaking) {
      const wobble = reduced ? 0 : Math.sin(time * 5.1 + orb.seed) * 0.02 * orb.lvl;
      const scale = `scale(${(1 + orb.lvl * 0.09 + wobble).toFixed(3)},${(1 + orb.lvl * 0.09 - wobble).toFixed(3)})`;
      // A camera's picture lies on the orb and swells with it.
      for (const el of orb.root.children) (el as HTMLElement).style.transform = scale;
    }
    if (orb.still) {
      if (orb.stale && p && program) draw(orb, p, program, pad, time);
      continue;
    }
    if (!reduced) {
      orb.angle += dt * (0.07 + orb.lvl * 0.9);
      orb.flow += dt * (0.09 + orb.lvl * 1.5);
    }
    if (!p || !program) continue;
    const due = reduced ? Math.abs(orb.lvl - orb.drawnLvl) > 0.03 : isDue(orb.lvl, time - orb.lastDraw);
    if (orb.stale || due) draw(orb, p, program, pad, time);
  }
}

/** Starts drawing an orb; answers how to stop. */
export function addOrb(options: OrbOptions): () => void {
  const orb: LiveOrb = {
    ...options,
    ctx: options.canvas.getContext('2d'),
    rgb: options.colors.map(hexToRgb),
    size: 0,
    lvl: 0,
    drawnLvl: 0,
    // Apart from the start, so that no two orbs turn and stir in step.
    angle: (options.seed % 628) / 100,
    flow: ((options.seed >>> 10) % 100) / 10,
    lastDraw: 0,
    stale: true,
    speaking: false,
  };
  options.root.classList.toggle('flat', !getPainter());
  options.root.classList.toggle('volume', !!getPainter() && shownLook() === 'volume');
  const resized = new ResizeObserver(([entry]) => {
    const size = Math.min(MAX_SIZE[shownLook()], Math.round((entry?.contentRect.width ?? 0) * devicePixelRatio));
    if (size === orb.size) return;
    orb.size = options.canvas.width = options.canvas.height = size;
    orb.stale = true;
  });
  resized.observe(options.canvas);
  orbs.add(orb);
  stopTicking ??= onTick(tick);
  return () => {
    resized.disconnect();
    orbs.delete(orb);
    if (!orbs.size) {
      stopTicking?.();
      stopTicking = null;
    }
  };
}
