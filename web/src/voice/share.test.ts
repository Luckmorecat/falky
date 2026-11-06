import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareOptions, supportedShareCodecs, type ShareSettings } from './share';

const base: ShareSettings = { shareResolution: '1080', shareFps: '30', shareMbps: '0', shareCodec: 'vp8', shareFocus: 'motion', shareAudio: true };

afterEach(() => vi.unstubAllGlobals());

function sendingCodecs(...mimeTypes: string[]) {
  const getCapabilities = vi.fn(() => ({ codecs: mimeTypes.map((mimeType) => ({ mimeType })) }));
  vi.stubGlobal('RTCRtpSender', { getCapabilities });
  return getCapabilities;
}

describe('screen share codec support', () => {
  it('offers only codecs the browser can send, ignoring duplicates and transport codecs', () => {
    const getCapabilities = sendingCodecs('video/VP8', 'video/H264', 'video/h264', 'video/rtx', 'video/VP9');
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H265' }] }) });
    expect(supportedShareCodecs()).toEqual(['vp8', 'h264']);
    expect(getCapabilities).toHaveBeenCalledWith('video');
  });

  it('offers H.265 when encoding is supported', () => {
    sendingCodecs('video/VP8', 'video/H264', 'video/H265');
    expect(supportedShareCodecs()).toEqual(['vp8', 'h264', 'h265']);
  });

  it.each([
    undefined,
    {},
    { getCapabilities: () => null },
    { getCapabilities: () => { throw new Error('Unavailable'); } },
  ])('keeps VP8 when capability discovery is unavailable (%#)', (sender) => {
    vi.stubGlobal('RTCRtpSender', sender);
    expect(supportedShareCodecs()).toEqual(['vp8']);
    expect(shareOptions({ ...base, shareCodec: 'h265' }, false).publish.videoCodec).toBe('vp8');
  });
});

describe('shareOptions', () => {
  it.each(['vp8', 'h264', 'h265'] as const)('publishes the selected %s codec with a compatible backup', (shareCodec) => {
    sendingCodecs('video/VP8', 'video/H264', 'video/H265');
    const { publish } = shareOptions({ ...base, shareCodec }, false);
    expect(publish.videoCodec).toBe(shareCodec);
    expect(publish.backupCodec).toEqual({ codec: 'vp8' });
  });

  it('falls back when a saved codec is no longer supported', () => {
    sendingCodecs('video/VP8', 'video/H264');
    expect(shareOptions({ ...base, shareCodec: 'h265' }, false).publish.videoCodec).toBe('vp8');
  });

  it('asks for what was chosen', () => {
    const { capture, publish } = shareOptions({ ...base, shareResolution: '1440', shareFps: '60' }, false);
    expect(capture.resolution).toEqual({ width: 2560, height: 1440, frameRate: 60 });
    expect(publish.screenShareEncoding?.maxFramerate).toBe(60);
  });

  it('spends more bits on more pixels and frames', () => {
    const rate = (s: Partial<ShareSettings>) => shareOptions({ ...base, ...s }, false).publish.screenShareEncoding!.maxBitrate;
    expect(rate({ shareResolution: '1440' })).toBeGreaterThan(rate({}));
    expect(rate({ shareFps: '60' })).toBeGreaterThan(rate({}));
    expect(rate({ shareFps: '15' })).toBeLessThan(rate({}));
  });

  it('holds to a fixed bitrate when one is set', () => {
    const { publish } = shareOptions({ ...base, shareMbps: '12', shareResolution: '720' }, false);
    expect(publish.screenShareEncoding?.maxBitrate).toBe(12_000_000);
  });

  it('lets the chosen focus decide what gives way on a weak network', () => {
    expect(shareOptions({ ...base, shareFocus: 'motion' }, false).publish.degradationPreference).toBe('maintain-framerate');
    expect(shareOptions({ ...base, shareFocus: 'detail' }, false).publish.degradationPreference).toBe('maintain-resolution');
  });

  it('leaves system sound out when sound is off', () => {
    const { capture } = shareOptions({ ...base, shareAudio: false }, false);
    expect(capture.audio).toBe(false);
    expect(capture.systemAudio).toBe('exclude');
  });

  it('names no resolution on Safari', () => {
    expect(shareOptions(base, true).capture.resolution).toBeUndefined();
  });
});
