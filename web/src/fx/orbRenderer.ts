import { effectsReduced, onTick } from './ticker';

/**
 * Draws every orb with one shader on one hidden WebGL context, then copies each
 * result to the orb's own canvas: browsers allow few contexts, and Falky runs
 * next to games. Someone silent is redrawn a few times a second; only a voice
 * gets every frame.
 */

/** The most pixels an orb is drawn at; its shapes are soft, so more shows nothing. */
const MAX_SIZE = 512;
const IDLE_INTERVAL = 1 / 15;

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos, 0., 1.); }`;

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform vec3 uBase, uBright, uDeep, uCore;
uniform float uSeed, uAngle, uFlow, uLevel, uPixel;

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

void main() {
  float r = length(vUv);
  float alpha = smoothstep(1., 1. - uPixel * 1.6, r);
  if (alpha <= 0.) { gl_FragColor = vec4(0.); return; }

  // The sphere's surface at this pixel, turned so that the colours lie on it.
  vec3 n = vec3(vUv, sqrt(max(0., 1. - r * r)));
  float c = cos(uAngle), s = sin(uAngle);
  vec3 p = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  p = vec3(p.x, .94 * p.y - .34 * p.z, .34 * p.y + .94 * p.z) * .95 + uSeed;

  vec2 q = vec2(fbm(p + vec3(0., 0., uFlow)), fbm(p + vec3(5.2, 1.3, -uFlow * .8)));
  float warp = 1.7 + uLevel * 1.1;
  float cloud = fbm(p + vec3(q, q.x) * warp);
  float under = fbm(p * 1.1 + vec3(q.yx, q.y) * warp + 7.7);

  vec3 col = mix(uBase, uDeep, smoothstep(.5, .74, under) * .85);
  col = mix(col, uBright, smoothstep(.4, .64, cloud));
  col = mix(col, uCore, smoothstep(.54, .74, cloud) * (.82 + uLevel * .18));

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

  col += (hash(vec3(gl_FragCoord.xy, uSeed)) - .5) * .045;
  gl_FragColor = vec4(col * alpha, alpha);
}`;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Whether an orb is due for drawing, given how loud it is and when it last was. */
export function isDue(level: number, sinceLast: number): boolean {
  return level > 0.03 || sinceLast >= IDLE_INTERVAL;
}

interface Painter {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

let painter: Painter | null = null;
let unavailable = false;
let lost = false;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function setUp(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): Painter | null {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(['uBase', 'uBright', 'uDeep', 'uCore', 'uSeed', 'uAngle', 'uFlow', 'uLevel', 'uPixel'].map((u) => [u, gl.getUniformLocation(program, u)]));
  return { gl, canvas, uniforms };
}

function getPainter(): Painter | null {
  if (painter || unavailable || lost) return painter;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MAX_SIZE;
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

export interface OrbOptions {
  /** The orb's element: it gets `speaking` and, without WebGL, `flat`. */
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

function draw(orb: LiveOrb, p: Painter, time: number): void {
  const { gl, uniforms: u } = p;
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
  gl.uniform1f(u.uPixel!, 2 / orb.size);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  orb.ctx.clearRect(0, 0, orb.size, orb.size);
  orb.ctx.drawImage(p.canvas, 0, MAX_SIZE - orb.size, orb.size, orb.size, 0, 0, orb.size, orb.size);
  orb.lastDraw = time;
  orb.drawnLvl = orb.lvl;
  orb.stale = false;
}

function tick(time: number, dt: number): void {
  const p = painter ?? getPainter();
  const reduced = effectsReduced();
  for (const orb of orbs) {
    const target = orb.level ? orb.level() : 0;
    orb.lvl += (target - orb.lvl) * (1 - Math.exp(-dt * (target > orb.lvl ? 26 : 4.5)));
    if (orb.lvl > 0.22 !== orb.speaking && (orb.lvl > 0.22 || orb.lvl < 0.12)) {
      orb.speaking = orb.lvl > 0.22;
      orb.root.classList.toggle('speaking', orb.speaking);
    }
    if (orb.level || orb.speaking) {
      const wobble = reduced ? 0 : Math.sin(time * 5.1 + orb.seed) * 0.02 * orb.lvl;
      orb.canvas.style.transform = `scale(${(1 + orb.lvl * 0.09 + wobble).toFixed(3)},${(1 + orb.lvl * 0.09 - wobble).toFixed(3)})`;
    }
    if (orb.still) {
      if (orb.stale && p) draw(orb, p, time);
      continue;
    }
    if (!reduced) {
      orb.angle += dt * (0.07 + orb.lvl * 0.9);
      orb.flow += dt * (0.09 + orb.lvl * 1.5);
    }
    if (!p) continue;
    const due = reduced ? Math.abs(orb.lvl - orb.drawnLvl) > 0.03 : isDue(orb.lvl, time - orb.lastDraw);
    if (orb.stale || due) draw(orb, p, time);
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
  const resized = new ResizeObserver(([entry]) => {
    const size = Math.min(MAX_SIZE, Math.round((entry?.contentRect.width ?? 0) * devicePixelRatio));
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
