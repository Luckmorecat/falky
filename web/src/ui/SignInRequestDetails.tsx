import type { SignInRequest } from '../api/client';
import { useApp } from '../app/store';
import { resolveLanguage, t } from '../strings';
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
  const language = useApp(state => state.settings.language);
  const { city, countryCode } = request.requesterLocation ?? {};
  const country = countryCode && (typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(resolveLanguage(language), { type: 'region' }).of(countryCode)
    : countryCode);
  const location = [city, country].filter(Boolean).join(', ');

  return <div className="device-request-details">
    <strong>{requestDevice(request.requesterUserAgent)}</strong>
    {location && <div className="device-request-location">
      <span className="visually-hidden">{t.device.approximateLocation} </span><span aria-hidden="true">≈ </span><bdi>{location}</bdi>
    </div>}
    <small className="device-request-ip"><bdi>{request.requesterIp || t.device.ipUnavailable}</bdi></small>
  </div>;
}
