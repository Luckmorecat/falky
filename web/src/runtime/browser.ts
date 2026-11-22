import type { ShareCodec } from '../voice/share';
export { startMicTest } from '../voice/meter';
export { playSound } from '../voice/sounds';

export const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/** Probe sending support, not playback support. VP8 remains the WebRTC baseline. */
export function supportedShareCodecs(): ShareCodec[] {
  const supported: ShareCodec[] = ['vp8'];
  try {
    if (typeof RTCRtpSender === 'undefined') return supported;
    const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
    for (const codec of ['h264', 'h265'] as const) {
      if (codecs.some((c) => c.mimeType.toLowerCase() === `video/${codec}`)) supported.push(codec);
    }
  } catch {
    // Capability discovery can be unavailable even when screen sharing works.
  }
  return supported;
}

export const canChooseSpeaker = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
export const notificationsAvailable = typeof Notification === 'function';
export const enumerateDevices = (): Promise<MediaDeviceInfo[]> => navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]);
export function watchDevices(onChange: () => void): () => void {
  navigator.mediaDevices?.addEventListener('devicechange', onChange);
  return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange);
}
export function refreshDevices(): void {
  navigator.mediaDevices?.dispatchEvent(new Event('devicechange'));
}
export function notificationPermission(): NotificationPermission {
  try { return notificationsAvailable ? Notification.permission ?? 'denied' : 'denied'; }
  catch { return 'denied'; }
}
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  try { return notificationsAvailable ? await Notification.requestPermission?.() ?? 'denied' : 'denied'; }
  catch { return 'denied'; }
}
export function notify(title: string, options: NotificationOptions, onClick: () => void): void {
  if (notificationPermission() !== 'granted') return;
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => { onClick(); notification.close(); };
  } catch {
    // Some mobile browsers grant permission but reject page-created notifications.
  }
}

export { startQRScanner } from './qrScanner';
/** The camera alone, for a person to see themselves before anyone else does. */
export const startCamera = async (video: MediaTrackConstraints): Promise<MediaStream> => navigator.mediaDevices.getUserMedia({ video, audio: false });
