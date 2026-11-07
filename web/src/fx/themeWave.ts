export interface ThemeFrame {
  progress: number;
  direction: number;
  fromLight: boolean;
}

/** Reversing the target retraces the same spreading front without restarting it. */
export function createThemeWave(light: boolean) {
  let progress = light ? 1 : 0;
  let fromLight = light;
  let direction = 0;
  return {
    frame(light: boolean, dt: number, reduced: boolean): ThemeFrame {
      const target = light ? 1 : 0;
      const wantedDirection = Math.sign(target - progress);
      if ((progress === 0 || progress === 1) && target !== progress) fromLight = progress === 1;
      const step = Math.max(0, dt) / .6;
      progress = reduced ? target : progress + Math.sign(target - progress) * Math.min(Math.abs(target - progress), step);
      direction += (wantedDirection - direction) * (1 - Math.exp(-Math.max(0, dt) * 30));
      if (Math.abs(wantedDirection - direction) < .04) direction = wantedDirection;
      if (reduced || progress === target) direction = 0;
      return { progress, direction, fromLight };
    },
  };
}

/** Shared by the solid background and dots, in CSS pixel coordinates. */
export const THEME_WAVE_GLSL = `
uniform float uTheme, uThemeDirection, uThemeFromLight;
float themeHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * .1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float themeNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(themeHash(cell), themeHash(cell + vec2(1., 0.)), f.x),
             mix(themeHash(cell + vec2(0., 1.)), themeHash(cell + vec2(1., 1.)), f.x), f.y);
}
float spreadArrival(vec2 p, float seed) {
  vec2 source = -uSize * .025;
  vec2 delta = p - source;
  float angle = atan(delta.y, delta.x);
  float lobes = sin(angle * 9. + 1.4 + seed) * .14
              + sin(angle * 19. - .7 - seed) * .06
              + sin(angle * 37. + 2.1 + seed) * .025;
  vec2 q = delta / 180. + seed;
  vec2 warp = vec2(themeNoise(q * .61), themeNoise(q * .61 + 17.7));
  q += (warp - .5) * 2.6;
  float floorTexture = (themeNoise(q) - .5) * 170.
                     + (themeNoise(q * 2.3 + 8.1) - .5) * 55.;
  return length(delta) * (1. + lobes) + floorTexture;
}
float spreadProgress() { return mix(uTheme, 1. - uTheme, uThemeFromLight); }
float spreadDirection() { return uThemeDirection * (1. - 2. * uThemeFromLight); }
float spreadFront() {
  float reach = length(uSize * 1.025) * .82;
  return mix(-400., reach + 400., smoothstep(0., 1., spreadProgress()));
}
vec2 spreadArrivals(vec2 p) {
  // Different terrain for each spill keeps the meeting line irregular.
  return vec2(spreadArrival(p, 0.), spreadArrival(uSize - p, 7.1));
}
float mergedArrival(vec2 arrivals) {
  float join = max(140. - abs(arrivals.x - arrivals.y), 0.) / 140.;
  return min(arrivals.x, arrivals.y) - join * join * 35.;
}
float themeAt(vec2 p) {
  if (uTheme <= 0.) return 0.;
  if (uTheme >= 1.) return 1.;
  float coverage = 1. - smoothstep(-140., 140., mergedArrival(spreadArrivals(p)) - spreadFront());
  return mix(coverage, 1. - coverage, uThemeFromLight);
}
void themeDot(vec2 p, out float light, out vec2 offset, out vec3 tint, out float activity) {
  light = uTheme;
  offset = vec2(0.);
  tint = vec3(0.);
  activity = 0.;
  if (uTheme <= 0. || uTheme >= 1.) return;
  float progress = spreadProgress(), direction = spreadDirection();
  vec2 arrivals = spreadArrivals(p);
  vec2 distances = arrivals - spreadFront();
  float coverage = 1. - smoothstep(-180., 180., mergedArrival(arrivals) - spreadFront() - direction * 160.);
  light = mix(coverage, 1. - coverage, uThemeFromLight);

  vec2 bands = (distances * direction - 90.) / 210.;
  vec2 pulses = exp(-bands * bands);
  float envelope = smoothstep(0., .12, progress) * (1. - smoothstep(.78, 1., progress));
  float gap = (arrivals.x - arrivals.y) / 260.;
  float collision = sqrt(pulses.x * pulses.y) * exp(-gap * gap);
  activity = clamp(max(pulses.x, pulses.y) + collision * .5, 0., 1.) * envelope;

  vec2 dx = spreadArrivals(p + vec2(3., 0.)) - arrivals;
  vec2 dy = spreadArrivals(p + vec2(0., 3.)) - arrivals;
  vec2 first = vec2(dx.x, dy.x), second = vec2(dx.y, dy.y);
  first /= max(length(first), .001);
  second /= max(length(second), .001);
  float t = progress * 9.;
  float eddy = sin(p.x * .016 + p.y * .022 + t);
  offset = (first * pulses.x + second * pulses.y) * direction * 24.;
  offset += (vec2(-first.y, first.x) * pulses.x - vec2(-second.y, second.x) * pulses.y) * eddy * 10.;

  // Opposing pressure becomes a rolling curl, rather than cancelling at the centre.
  vec2 q = (p - uSize * .5) / 100.;
  float diagonal = q.x * .7 + q.y * 1.3 + t;
  float curlX = cos(q.x + t) * sin(q.y - t) + .245 * cos(diagonal);
  float curlY = sin(q.x + t) * cos(q.y - t) + .455 * cos(diagonal);
  vec2 tangent = vec2(-q.y, q.x) / max(length(q), .6);
  offset += (vec2(curlY, -curlX) * 34. + tangent * 22.) * collision * direction;
  offset *= envelope;

  // Two temporary inks mingle in the collision, then fade to the final theme.
  float blend = pulses.y / max(pulses.x + pulses.y, .001);
  blend = clamp(blend + collision * sin(q.x + q.y + t) * .18, 0., 1.);
  tint = mix(vec3(.98, .46, .66), vec3(.35, .72, 1.), blend);
}`;
