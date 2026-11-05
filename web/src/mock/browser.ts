import { mockState } from './state';
import type { MicTest } from '../voice/meter';
import type { ShareCodec } from '../voice/share';
import type { VoiceSound } from '../voice/types';

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
];
export function watchDevices(onChange: () => void): () => void {
  devices.addEventListener('devicechange', onChange);
  return () => devices.removeEventListener('devicechange', onChange);
}
export function refreshDevices(): void { devices.dispatchEvent(new Event('devicechange')); }
export async function startMicTest(_constraints: MediaTrackConstraints): Promise<MicTest> {
  if (mockState()?.faults.micDenied) throw new DOMException('Simulated microphone denial', 'NotAllowedError');
  let stopped = false;
  return { level: () => stopped ? 0 : 0.35 + 0.25 * Math.sin(performance.now() / 170), stop: () => { stopped = true; } };
}
/** Settings exercise state only; no audio output or OS notification escapes mock mode. */
export function playSound(_sound: VoiceSound | 'test', _sinkId = ''): void {}
let permission: NotificationPermission = 'default';
export const notificationPermission = (): NotificationPermission => permission;
export async function requestNotificationPermission(): Promise<NotificationPermission> { return permission = 'granted'; }
export function notify(_title: string, _options: NotificationOptions, _onClick: () => void): void {}
