import { supportedShareCodecs } from '@falky/browser';
import type { ScreenShareCaptureOptions, TrackPublishOptions } from 'livekit-client';

export type ShareResolution = '720' | '1080' | '1440';
export type ShareFps = '15' | '30' | '60';
export type ShareFocus = 'motion' | 'detail';
export type ShareCodec = 'vp8' | 'h264' | 'h265';

export interface ShareSettings {
  shareResolution: ShareResolution;
  shareFps: ShareFps;
  shareCodec: ShareCodec;
  shareFocus: ShareFocus;
  shareAudio: boolean;
  /** A fixed ceiling in megabits per second as text, or '0' to follow resolution and frames. */
  shareMbps: string;
}

export { canShareScreen, supportedShareCodecs } from '@falky/browser';

/** The highest fixed bitrate on offer, in megabits per second. */
export const SHARE_BITRATE_MAX = 20;

/** The stops on the way there, in megabits per second, '0' being automatic. */
export const SHARE_BITRATE_PRESETS = ['0', '3', '6', '10', '20'] as const;

/** Bits per second at 30 frames; moving pictures stay clean without taking a whole home uplink. */
const BITRATE: Record<ShareResolution, number> = { 720: 2_500_000, 1080: 5_000_000, 1440: 8_000_000 };
const FPS_COST: Record<ShareFps, number> = { 15: 0.7, 30: 1, 60: 1.5 };

/** What a share may use: the fixed ceiling if one is set, otherwise what suits its size. */
export function shareBitrate(s: ShareSettings): number {
  const fixed = Number(s.shareMbps);
  return fixed > 0 ? fixed * 1_000_000 : Math.round(BITRATE[s.shareResolution] * FPS_COST[s.shareFps]);
}

/** Safari captures at a low resolution when asked for any particular one. */
const isSafari = () => /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

export function shareOptions(s: ShareSettings, safari = isSafari()): { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions } {
  const height = Number(s.shareResolution);
  const frameRate = Number(s.shareFps);
  return {
    capture: {
      audio: s.shareAudio,
      systemAudio: s.shareAudio ? 'include' : 'exclude',
      contentHint: s.shareFocus,
      ...(safari ? {} : { resolution: { width: Math.round((height * 16) / 9), height, frameRate } }),
    },
    publish: {
      // Recheck at publication: a saved preference may outlive browser support.
      videoCodec: supportedShareCodecs().includes(s.shareCodec) ? s.shareCodec : 'vp8',
      backupCodec: { codec: 'vp8' },
      screenShareEncoding: { maxBitrate: shareBitrate(s), maxFramerate: frameRate },
      // What gives way when the network falls short. Left out, LiveKit always keeps
      // the resolution for a screen, whatever the content hint asks for.
      degradationPreference: s.shareFocus === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
    },
  };
}
