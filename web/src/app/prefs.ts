import type { OrbLook } from '../fx/orbRenderer';
import { preferencePrefix } from '../runtime/preferences';
import { loadShortcuts } from './shortcuts';
import { LANGUAGE_CODES, type LanguageChoice } from '../strings';
import type { CameraSettings } from '../voice/camera';
import { SHARE_BITRATE_MAX, type ShareSettings } from '../voice/share';

/** What this browser remembers for the person. Reads and writes may fail in a private window. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(`${preferencePrefix}${key}`);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(`${preferencePrefix}${key}`, value);
  } catch {
    // Forgotten on reload; nothing else depends on it.
  }
}

export type Theme = 'dark' | 'light' | 'system';
export type AwayMinutes = '5' | '10' | '30';

export interface Settings extends ShareSettings, CameraSettings {
  micId: string;
  speakerId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  joinMuted: boolean;
  pushToTalk: boolean;
  /** Turns a long-silent live microphone off. */
  awayMute: boolean;
  /** Minutes of silence before that happens. */
  awayMinutes: AwayMinutes;
  /** Sound and a system notification when someone calls you into voice. */
  knockAlerts: boolean;
  sounds: boolean;
  uiSounds: boolean;
  notifications: boolean;
  fewerEffects: boolean;
  liveBackground: boolean;
  orbLight: OrbLook;
  theme: Theme;
  language: LanguageChoice;
}

function oneOf<V extends string>(key: string, values: readonly V[], fallback: V): V {
  const v = read(key);
  return values.includes(v as V) ? (v as V) : fallback;
}

export const prefs = {
  settings(): Settings {
    // Old browser-only favourites are intentionally not imported into shared identity.
    try { localStorage.removeItem(`${preferencePrefix}favoriteColors`); } catch { /* Private storage may be unavailable. */ }
    loadShortcuts();
    return {
      micId: read('micId') ?? '',
      speakerId: read('speakerId') ?? '',
      noiseSuppression: read('noiseSuppression') !== 'off',
      echoCancellation: read('echoCancellation') !== 'off',
      autoGain: read('autoGain') !== 'off',
      joinMuted: read('joinMuted') === 'on',
      pushToTalk: read('pushToTalk') === 'on',
      awayMute: read('awayMute') !== 'off',
      awayMinutes: oneOf('awayMinutes', ['5', '10', '30'], '10'),
      knockAlerts: read('knockAlerts') !== 'off',
      shareResolution: oneOf('shareResolution', ['720', '1080', '1440'], '1080'),
      shareFps: oneOf('shareFps', ['15', '30', '60'], '30'),
      shareCodec: oneOf('shareCodec', ['vp8', 'h264', 'h265'], 'vp8'),
      shareFocus: oneOf('shareFocus', ['motion', 'detail'], 'motion'),
      shareAudio: read('shareAudio') !== 'off',
      // A new key: the old one held a multiplier, which would read here as a few megabits.
      shareMbps: String(Math.max(0, Math.min(SHARE_BITRATE_MAX, Math.round(Number(read('shareMbps'))) || 0))),
      cameraId: read('cameraId') ?? '',
      cameraResolution: oneOf('cameraResolution', ['360', '720', '1080'], '720'),
      cameraMirror: read('cameraMirror') !== 'off',
      orbLight: oneOf('orbLight', ['flat', 'volume'], 'flat'),
      theme: oneOf('theme', ['dark', 'light', 'system'], 'dark'),
      // A new key: the old one was saved with every setting, so it does not say anyone chose.
      language: oneOf('language', ['system', ...LANGUAGE_CODES], 'system'),
      sounds: read('sounds') !== 'off',
      uiSounds: read('uiSounds') !== 'off',
      notifications: read('notifications') === 'on',
      fewerEffects: read('fewerEffects') === 'on',
      liveBackground: (read('liveBackground') ?? read('voiceBackground')) === 'on',
    };
  },
  saveSettings(s: Settings): void {
    for (const [key, value] of Object.entries(s)) write(key, typeof value === 'boolean' ? (value ? 'on' : 'off') : Array.isArray(value) ? value.join(',') : value);
  },
  clearIdentity(): void {
    try {
      const keys = Object.keys(localStorage).filter((key) => key === `${preferencePrefix}viewedRoom` || key.startsWith(`${preferencePrefix}read.`));
      for (const key of keys) localStorage.removeItem(key);
    } catch { /* Private storage may be unavailable. */ }
  },
  lastRead: (roomId: string) => read(`read.${roomId}`),
  setLastRead: (roomId: string, messageId: string) => write(`read.${roomId}`, messageId),
  viewedRoom: () => read('viewedRoom'),
  setViewedRoom: (roomId: string) => write('viewedRoom', roomId),
  /** A participant's volume from 0 to 2, where 1 is as they arrive and everyone starts. */
  volume(connectionId: string): number {
    const v = Number(read(`connectionVolume.${connectionId}`));
    return read(`connectionVolume.${connectionId}`) === null || Number.isNaN(v) ? 1 : Math.max(0, Math.min(2, v));
  },
  volumeBeforeMute(connectionId: string): number {
    const saved = Number(read(`volumeBeforeMute.${connectionId}`));
    return saved > 0 ? Math.min(2, saved) : 1;
  },
  setVolume(connectionId: string, v: number): void {
    if (v === 0) {
      const current = this.volume(connectionId);
      if (current > 0) write(`volumeBeforeMute.${connectionId}`, String(current));
    }
    write(`connectionVolume.${connectionId}`, String(v));
  },
};
