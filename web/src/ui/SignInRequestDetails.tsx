import type { SignInRequest } from '../api/client';
import { t } from '../strings';
import './SignInRequestDetails.css';

export function requestDevice(agent: string): string {
  if (/iPad/i.test(agent) || (/Macintosh/i.test(agent) && /Mobile/i.test(agent))) return 'iPad';
  if (/iPhone|iPod/i.test(agent)) return 'iPhone';
  if (/Android/i.test(agent)) return /Mobile/i.test(agent) ? t.device.androidPhone : t.device.androidDevice;
  if (/Windows/i.test(agent)) return t.device.windowsPC;
  if (/Macintosh|Mac OS/i.test(agent)) return 'Mac';
  if (/CrOS/i.test(agent)) return 'Chromebook';
  if (/Linux/i.test(agent)) return t.device.linuxPC;
  return t.device.unknownDevice;
}

export function SignInRequestDetails({ request }: { request: SignInRequest }) {
  return <div className="device-request-details"><strong>{requestDevice(request.requesterUserAgent)}</strong><small><bdi>{request.requesterIp || t.device.ipUnavailable}</bdi></small></div>;
}
