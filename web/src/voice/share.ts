import type { ScreenShareCaptureOptions, TrackPublishOptions } from 'livekit-client';

export type ShareResolution = '720' | '1080' | '1440';
export type ShareFps = '15' | '30' | '60';
export type ShareFocus = 'motion' | 'detail';

export interface ShareSettings {
  shareResolution: ShareResolution;
  shareFps: ShareFps;
  shareFocus: ShareFocus;
  shareAudio: boolean;
}

export const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/** Bits per second at 30 frames; enough for moving pictures without taking the whole uplink. */
const BITRATE: Record<ShareResolution, number> = { 720: 1_700_000, 1080: 3_000_000, 1440: 5_000_000 };
const FPS_COST: Record<ShareFps, number> = { 15: 0.7, 30: 1, 60: 1.5 };

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
    publish: { screenShareEncoding: { maxBitrate: Math.round(BITRATE[s.shareResolution] * FPS_COST[s.shareFps]), maxFramerate: frameRate } },
  };
}
