import { mockState, subscribeMockState } from './state';
import type { MicTest } from '../voice/meter';
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
export async function startMicTest(_constraints: MediaTrackConstraints): Promise<MicTest> {
  if (mockState()?.faults.micDenied) throw new DOMException('Simulated microphone denial', 'NotAllowedError');
  let stopped = false;
  return { level: () => stopped ? 0 : 0.35 + 0.25 * Math.sin(performance.now() / 170), stop: () => { stopped = true; } };
}
/** Settings exercise state only; no audio output or OS notification escapes mock mode. */
export function playSound(_sound: Sound, _sinkId = '', _pitch = 0.5): void {}
let permission: NotificationPermission = 'default';
export const notificationPermission = (): NotificationPermission => permission;
export async function requestNotificationPermission(): Promise<NotificationPermission> { return permission = 'granted'; }
export function notify(_title: string, _options: NotificationOptions, _onClick: () => void): void {}
/** A drawn picture in place of a camera: a slow gradient with a head and shoulders. */
export async function startCamera(_constraints: MediaTrackConstraints): Promise<MediaStream> {
  const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const ctx = canvas.getContext('2d')!;
  let frame = 0;
  const draw = () => {
    const t = performance.now() / 1000;
    const sky = ctx.createLinearGradient(0, 0, 640, 360);
    sky.addColorStop(0, `hsl(${210 + Math.sin(t / 3) * 20} 35% 32%)`);
    sky.addColorStop(1, 'hsl(260 25% 18%)');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = 'hsl(28 30% 62%)';
    ctx.beginPath(); ctx.arc(250 + Math.sin(t) * 6, 150, 58, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(250 + Math.sin(t) * 6, 360, 130, 110, 0, Math.PI, 0); ctx.fill();
    frame = requestAnimationFrame(draw);
  };
  draw();
  const stream = canvas.captureStream(30);
  const [track] = stream.getVideoTracks();
  const stop = track!.stop.bind(track);
  track!.stop = () => { cancelAnimationFrame(frame); stop(); };
  return stream;
}

export function startQRScanner(video: HTMLVideoElement, onResult: (value: string) => void, onError: (error: unknown) => void, canUseCamera = () => true): import('../runtime/qrScanner').QRScanner {
  if (!canUseCamera()) {
    onError(new DOMException('Camera already in use', 'NotReadableError'));
    return { stop() {} };
  }
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
