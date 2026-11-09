export interface BeaconFrame {
  phase: number;
  strength: number;
}

/** A new unread message gets one strong cue; leaving it unread gets quieter reminders. */
export function createUnreadBeacon() {
  let current: string | null = null;
  let elapsed = 0;
  return {
    frame(message: string | null, dt: number, reduced: boolean): BeaconFrame {
      if (message !== current) { current = message; elapsed = 0; }
      else elapsed += Math.max(0, dt);
      if (message === null) return { phase: 0, strength: 0 };
      if (reduced) return { phase: -1, strength: .32 };
      const phase = elapsed % 6;
      const envelope = Math.min(1, phase / .25) * Math.max(0, Math.min(1, (3.5 - phase) / .9));
      return { phase, strength: envelope * (elapsed < 6 ? 1 : .55) };
    },
  };
}

export const UNREAD_BEACON_GLSL = `
uniform vec4 uBeacon;
void unreadBeacon(vec2 p, out vec2 offset, out float glow) {
  offset = vec2(0.);
  glow = 0.;
  if (uBeacon.w <= 0.) return;
  vec2 delta = p - uBeacon.xy;
  float distance = length(delta);
  if (uBeacon.z < 0.) {
    glow = exp(-distance * distance / (2. * 160. * 160.)) * uBeacon.w;
    return;
  }
  for (int i = 0; i < 2; i++) {
    float age = uBeacon.z - float(i) * .65;
    if (age < 0. || age > 2.5) continue;
    float band = (distance - 24. - age * 112.) / 23.;
    glow += exp(-band * band) * (1. - age / 2.5) * uBeacon.w;
  }
  offset = delta / max(distance, 1.) * glow * 12.;
}`;
