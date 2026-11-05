import { supportedShareCodecs } from '@falky/browser';
import type { ScreenShareCaptureOptions, TrackPublishOptions } from 'livekit-client';

export type ShareResolution = '720' | '1080' | '1440';
export type ShareFps = '15' | '30' | '60';
export type ShareBitrate = '1' | '2' | '3';
export type ShareFocus = 'motion' | 'detail';
export type ShareCodec = 'vp8' | 'h264' | 'h265';

export interface ShareSettings {
  shareResolution: ShareResolution;
  shareFps: ShareFps;
  shareBitrate: ShareBitrate;
  shareCodec: ShareCodec;
  shareFocus: ShareFocus;
  shareAudio: boolean;
}

export { canShareScreen, supportedShareCodecs } from '@falky/browser';

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
    publish: {
      // Recheck at publication: a saved preference may outlive browser support.
      videoCodec: supportedShareCodecs().includes(s.shareCodec) ? s.shareCodec : 'vp8',
      backupCodec: { codec: 'vp8' },
      screenShareEncoding: { maxBitrate: Math.round(BITRATE[s.shareResolution] * FPS_COST[s.shareFps] * Number(s.shareBitrate)), maxFramerate: frameRate },
    },
  };
}
