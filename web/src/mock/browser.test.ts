import { afterEach, expect, it, vi } from 'vitest';
import * as browser from './browser';

afterEach(() => vi.unstubAllGlobals());

it('offers usable simulated devices, mic levels and alerts without browser capture or permission APIs', async () => {
  const forbidden = () => { throw new Error('Real browser capability was used'); };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: forbidden, getDisplayMedia: forbidden, enumerateDevices: forbidden } });
  vi.stubGlobal('AudioContext', forbidden);
  vi.stubGlobal('Notification', forbidden);
  vi.stubGlobal('RTCRtpSender', { getCapabilities: forbidden });
  expect(browser.canShareScreen).toBe(true);
  expect(browser.canChooseSpeaker).toBe(true);
  expect(browser.supportedShareCodecs()).toEqual(['vp8', 'h264', 'h265']);
  const devices = await browser.enumerateDevices();
  expect(devices.map((d) => d.kind)).toEqual(['audioinput', 'audiooutput', 'videoinput']);
  const changed = vi.fn();
  const stopWatching = browser.watchDevices(changed);
  browser.refreshDevices();
  expect(changed).toHaveBeenCalledOnce();
  stopWatching();
  const test = await browser.startMicTest({});
  expect(test.level()).toBeGreaterThan(0);
  test.stop();
  expect(test.level()).toBe(0);
  browser.playSound('test');
  expect(await browser.requestNotificationPermission()).toBe('granted');
  expect(browser.notificationPermission()).toBe('granted');
  browser.notify('Message', { body: 'Hello' }, () => {});
});
