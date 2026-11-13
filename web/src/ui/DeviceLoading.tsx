import { t } from '../strings';
import { Icon } from './Icon';

export function DeviceLoading({ scanner, onClose }: { scanner: boolean; onClose(): void }) {
  const heading = <div className="auth-heading" aria-hidden="true"><h1 className="device-skeleton-line">{scanner ? t.device.scanTitle : t.device.qrTitle}</h1><p className="device-skeleton-line">{scanner ? t.device.scanHint : t.device.qrHint}</p></div>;
  const placeholders = <div aria-hidden="true" className={scanner ? 'device-scanner-content' : 'device-task-content'}>
    {heading}
    {scanner ? <div className="device-camera device-skeleton-fill"><div className="device-scan-frame"><span /><span /><span /><span /></div></div> : <div className="device-qr device-skeleton-fill" />}
    <div className="device-skeleton-button device-skeleton-fill" />
    <div className="device-skeleton-link device-skeleton-fill" />
  </div>;
  return <div className={`${scanner ? 'device-scanner' : 'device-task'} device-loading`}>
    <header><button className="auth-back" onClick={onClose}><Icon name="left" />{scanner ? t.back(t.account.account) : t.account.back}</button></header>
    <div className="device-loading-status" role="status" aria-label={t.device.loading} aria-busy="true" tabIndex={-1}>{placeholders}</div>
  </div>;
}
