import type { Language } from '../strings';
import type { ShareSettings } from '../voice/share';

/** What this browser remembers for the person. Reads and writes may fail in a private window. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(`falky.${key}`);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(`falky.${key}`, value);
  } catch {
    // Forgotten on reload; nothing else depends on it.
  }
}

export type Theme = 'dark' | 'light' | 'system';

export interface Settings extends ShareSettings {
  micId: string;
  speakerId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  joinMuted: boolean;
  sounds: boolean;
  notifications: boolean;
  fewerEffects: boolean;
  theme: Theme;
  lang: Language;
}

function oneOf<V extends string>(key: string, values: readonly V[], fallback: V): V {
  const v = read(key);
  return values.includes(v as V) ? (v as V) : fallback;
}

export const prefs = {
  settings(): Settings {
    return {
      micId: read('micId') ?? '',
      speakerId: read('speakerId') ?? '',
      noiseSuppression: read('noiseSuppression') !== 'off',
      echoCancellation: read('echoCancellation') !== 'off',
      autoGain: read('autoGain') !== 'off',
      joinMuted: read('joinMuted') === 'on',
      shareResolution: oneOf('shareResolution', ['720', '1080', '1440'], '1080'),
      shareFps: oneOf('shareFps', ['15', '30', '60'], '30'),
      shareBitrate: oneOf('shareBitrate', ['1', '2', '3'], '1'),
      shareCodec: oneOf('shareCodec', ['vp8', 'h264', 'h265'], 'vp8'),
      shareFocus: oneOf('shareFocus', ['motion', 'detail'], 'motion'),
      shareAudio: read('shareAudio') !== 'off',
      theme: oneOf('theme', ['dark', 'light', 'system'], 'dark'),
      lang: oneOf('lang', ['uk', 'en'], 'uk'),
      sounds: read('sounds') !== 'off',
      notifications: read('notifications') === 'on',
      fewerEffects: read('fewerEffects') === 'on',
    };
  },
  saveSettings(s: Settings): void {
    for (const [key, value] of Object.entries(s)) write(key, typeof value === 'boolean' ? (value ? 'on' : 'off') : value);
  },
  lastRead: (roomId: string) => read(`read.${roomId}`),
  setLastRead: (roomId: string, messageId: string) => write(`read.${roomId}`, messageId),
  viewedRoom: () => read('viewedRoom'),
  setViewedRoom: (roomId: string) => write('viewedRoom', roomId),
  /** A participant's volume from 0 to 2, where 1 is as they arrive and everyone starts. */
  volume(visitorId: string): number {
    const v = Number(read(`volume.${visitorId}`));
    return read(`volume.${visitorId}`) === null || Number.isNaN(v) ? 1 : Math.max(0, Math.min(2, v));
  },
  setVolume: (visitorId: string, v: number) => write(`volume.${visitorId}`, String(v)),
};
