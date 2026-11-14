import { mockState, subscribeMockState } from './state';
import type { MicTest, MicTestOptions } from '../voice/meter';
import type { ShareCodec } from '../voice/share';
import type { Sound } from '../voice/sounds';

export const canShareScreen = true;
export const canChooseSpeaker = true;
export const notificationsAvailable = true;
export const supportedShareCodecs = (): ShareCodec[] => ['vp8', 'h264', 'h265'];
const devices = new EventTarget();
const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({
  kind, deviceId, label, groupId: 'mock', toJSON: () => ({ kind, deviceId, label, groupId: 'mock' }),
});
export const enumerateDevices = async (): Promise<MediaDeviceInfo[]> => [
  device('audioinput', 'mock-mic', 'Simulated microphone'),
  device('audiooutput', 'mock-speaker', 'Simulated speakers'),
  device('videoinput', 'mock-camera', 'Simulated camera'),
];
export function watchDevices(onChange: () => void): () => void {
  devices.addEventListener('devicechange', onChange);
  return () => devices.removeEventListener('devicechange', onChange);
}
export function refreshDevices(): void { devices.dispatchEvent(new Event('devicechange')); }
export async function startMicTest(_constraints: MediaTrackConstraints, options: MicTestOptions = {}): Promise<MicTest> {
  if (mockState()?.faults.micDenied) throw new DOMException('Simulated microphone denial', 'NotAllowedError');
  let stopped = false;
  let gain = options.gain ?? 1;
  return { level: () => stopped ? 0 : Math.min(1, gain * (0.35 + 0.25 * Math.sin(performance.now() / 170))), setGain: (value) => { gain = value; }, stop: () => { stopped = true; } };
}
/** Settings exercise state only; no audio output or OS notification escapes mock mode. */
export function playSound(_sound: Sound, _sinkId = '', _pitch = 0.5): void {}
let permission: NotificationPermission = 'default';
export const notificationPermission = (): NotificationPermission => permission;
export async function requestNotificationPermission(): Promise<NotificationPermission> { return permission = 'granted'; }
export function notify(_title: string, _options: NotificationOptions, _onClick: () => void): void {}

export function startQRScanner(video: HTMLVideoElement, onResult: (value: string) => void, onError: (error: unknown) => void): import('../runtime/qrScanner').QRScanner {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); unsubscribe(); removeEventListener('falky:mock-qr', detect); video.srcObject = null; };
  const detect = (event: Event) => {
    if (stopped || !(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
    stop(); onResult(event.detail);
  };
  addEventListener('falky:mock-qr', detect);
  const inspect = () => {
    if (stopped) return;
    const faults = mockState()?.faults;
    if (faults?.scannerError) { stop(); onError(new DOMException('Simulated scanner failure', faults.scannerError)); }
  };
  const unsubscribe = subscribeMockState(inspect);
  timer = setTimeout(inspect, mockState()?.faults.scannerDelayMs ?? 0);
  return { stop };
}
