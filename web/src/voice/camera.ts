import type { TrackPublishOptions, VideoCaptureOptions } from 'livekit-client';

export type CameraResolution = '360' | '720' | '1080';

export interface CameraSettings {
  cameraId: string;
  cameraResolution: CameraResolution;
  /** Whether a person sees their own picture as in a mirror; others never do. */
  cameraMirror: boolean;
}

export const canUseCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Enough for a talking person at each height; lower layers follow from these. */
const BITRATE: Record<CameraResolution, number> = { 360: 600_000, 720: 1_800_000, 1080: 3_500_000 };

export function cameraOptions(s: CameraSettings): { capture: VideoCaptureOptions; publish: TrackPublishOptions } {
  const height = Number(s.cameraResolution);
  return {
    capture: {
      deviceId: s.cameraId || undefined,
      resolution: { width: Math.round((height * 16) / 9), height, frameRate: 30 },
    },
    publish: {
      videoEncoding: { maxBitrate: BITRATE[s.cameraResolution], maxFramerate: 30 },
      // Everyone gets the layer their block's size needs, however large it is sent.
      simulcast: true,
    },
  };
}
