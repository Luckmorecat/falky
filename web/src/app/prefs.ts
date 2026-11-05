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

export interface Settings {
  micId: string;
  speakerId: string;
  sounds: boolean;
  notifications: boolean;
  fewerEffects: boolean;
}

export const prefs = {
  settings(): Settings {
    return {
      micId: read('micId') ?? '',
      speakerId: read('speakerId') ?? '',
      sounds: read('sounds') !== 'off',
      notifications: read('notifications') === 'on',
      fewerEffects: read('fewerEffects') === 'on',
    };
  },
  saveSettings(s: Settings): void {
    write('micId', s.micId);
    write('speakerId', s.speakerId);
    write('sounds', s.sounds ? 'on' : 'off');
    write('notifications', s.notifications ? 'on' : 'off');
    write('fewerEffects', s.fewerEffects ? 'on' : 'off');
  },
  lastRead: (roomId: string) => read(`read.${roomId}`),
  setLastRead: (roomId: string, messageId: string) => write(`read.${roomId}`, messageId),
  viewedRoom: () => read('viewedRoom'),
  setViewedRoom: (roomId: string) => write('viewedRoom', roomId),
  /** A participant's volume from 0 to 1; everyone starts at full. */
  volume(visitorId: string): number {
    const v = Number(read(`volume.${visitorId}`));
    return read(`volume.${visitorId}`) === null || Number.isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
  },
  setVolume: (visitorId: string, v: number) => write(`volume.${visitorId}`, String(v)),
};
