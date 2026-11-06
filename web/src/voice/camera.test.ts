import { describe, expect, it } from 'vitest';
import { cameraOptions } from './camera';

describe('cameraOptions', () => {
  it('asks for the chosen device and height', () => {
    const { capture, publish } = cameraOptions({ cameraId: 'front', cameraResolution: '720', cameraMirror: true });
    expect(capture.deviceId).toBe('front');
    expect(capture.resolution).toMatchObject({ width: 1280, height: 720 });
    expect(publish.videoEncoding?.maxBitrate).toBeGreaterThan(1_000_000);
  });

  it('leaves the device to the system when none is chosen', () => {
    expect(cameraOptions({ cameraId: '', cameraResolution: '360', cameraMirror: false }).capture.deviceId).toBeUndefined();
  });
});
