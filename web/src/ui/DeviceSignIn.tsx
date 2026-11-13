import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { startQRScanner } from '@falky/browser';
import { createDeviceCandidate, createQRApprover, deviceIssuer, type DeviceProblem } from '../app/deviceSignIn';
import { parseDeviceSignInURL } from '../app/entryLinks';
import { subscribeSessionEpoch } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
import { SignInRequestDetails } from './SignInRequestDetails';
import { Icon } from './Icon';
import { DeviceDeadline, DeviceError, DeviceLinkFlow, useDeviceClock, type DeviceLinkFlowProps } from './DeviceLinkFlow';

function QR({ value }: { value: string }) {
  const [qr, setQR] = useState<{ path: string; size: number }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void import('@zxing/library').then(({ BarcodeFormat, QRCodeWriter }) => {
      const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, new Map());
      let path = '';
      for (let y = 0; y < matrix.getHeight(); y++) for (let x = 0; x < matrix.getWidth(); x++) if (matrix.get(x, y)) path += `M${x} ${y}h1v1h-1z`;
      if (alive) setQR({ path, size: matrix.getWidth() });
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [value]);
  if (!qr) return <p role={failed ? 'alert' : 'status'}>{failed ? t.device.requestFailed : t.device.waiting}</p>;
  return <svg className="device-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={t.device.qrAlt}><rect width={qr.size} height={qr.size} fill="white" /><path d={qr.path} fill="black" /></svg>;
}
export function DeviceReceiver({ token, onClose }: { token?: string; onClose(): void }) {
  const [candidate] = useState(createDeviceCandidate);
  const finishAttempted = useRef('');
  const [finishProblem, setFinishProblem] = useState<DeviceProblem>();
  const state = useSyncExternalStore(candidate.subscribe, candidate.getSnapshot);
  const session = useApp(s => s.accountSession);
  const [consent, setConsent] = useState(!session);
  const [method, setMethod] = useState<'qr' | 'link'>(token ? 'link' : 'qr');
  const [pastedToken, setPastedToken] = useState<string>();
  const linkToken = token ?? pastedToken;
  const [input, setInput] = useState('');
  const [badLink, setBadLink] = useState(false);
  const now = useDeviceClock();
  useEffect(() => () => candidate.dispose(), [candidate]);
  useEffect(() => { if (consent && (method === 'qr' || linkToken)) void (linkToken ? candidate.beginLink(linkToken) : candidate.beginQR()).catch(() => {}); }, [candidate, consent, linkToken]);
  const finish = () => {
    finishAttempted.current = state.request?.id ?? '';
    setFinishProblem(undefined);
    void candidate.finish().catch(() => setFinishProblem(candidate.getSnapshot().problem ?? { code: 'outcome_unknown' }));
  };
  useEffect(() => { if ((state.request?.state === 'approved' || state.request?.state === 'consumed') && state.phase === 'waiting' && !state.problem && finishAttempted.current !== state.request.id) finish(); }, [candidate, state]);
  const blocked = state.busy || (state.retryAt ?? 0) > now;
  const terminal = ['expired', 'denied', 'cancelled', 'unavailable'].includes(state.phase);
  const title = state.phase === 'complete' ? t.device.complete : state.phase === 'finishing' ? t.device.finishing : terminal ? t.device[state.phase as 'expired' | 'denied' | 'cancelled' | 'unavailable'] : method === 'link' ? t.device.codeTitle : t.device.qrTitle;
  return <div className="device-task">
    <button className="auth-back" disabled={state.busy} onClick={() => { void candidate.cancel().catch(() => {}); onClose(); }}><Icon name="left" />{t.account.back}</button>
    <div className="auth-heading"><h1 tabIndex={-1}>{title}</h1>{!terminal && state.phase !== 'complete' && <p>{method === 'qr' ? t.device.qrHint : t.device.codeHint}</p>}</div>
    {!consent ? <><p className="device-note">{t.device.switchWarning}</p><Button variant="primary" onClick={() => setConsent(true)}>{t.account.continue}</Button></>
      : state.phase === 'complete' ? <Button variant="primary" onClick={onClose}>{t.device.done}</Button>
      : terminal ? <Button disabled={blocked} onClick={() => { if (linkToken) void candidate.beginLink(linkToken).catch(() => {}); else { setMethod('qr'); void candidate.retryQR().catch(() => {}); } }}>{t.device.retry}</Button>
      : <>
        {method === 'qr' && state.url && <QR value={state.url} />}
        {state.code && <p className="device-code" aria-label={`${t.device.codeLabel}: ${state.code}`}>{[...state.code].map((digit, i) => <span key={i}>{digit}</span>)}</p>}
        {state.request && <p className="device-wait" role="status">{t.device.waiting} · <DeviceDeadline at={state.request.expiresAt} now={now} /></p>}
        {method === 'qr' && <><p className="device-note">{t.device.qrInstructions}</p><button className="auth-text" disabled={blocked} onClick={() => { void candidate.cancel().catch(() => {}); setMethod('link'); }}>{t.device.useLink}</button></>}
        {method === 'link' && !state.code && <form className="auth-fields" onSubmit={e => { e.preventDefault(); const entry = parseDeviceSignInURL(input); if (entry?.type !== 'link') { setBadLink(true); return; } setInput(''); setBadLink(false); setPastedToken(entry.token); }}><label>{t.device.pasteLink}<input value={input} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={e => setInput(e.target.value)} /></label><Button type="submit" variant="primary" disabled={blocked || !input}>{t.account.continue}</Button></form>}
        {state.code && <button className="auth-text" disabled={blocked} onClick={() => void candidate.resend().catch(() => {})}>{t.device.resend}</button>}
      </>}
    {badLink && <p className="auth-error" role="alert">{t.device.unavailable}</p>}
    <DeviceError problem={state.problem ?? finishProblem} now={now} />
    {(state.problem || finishProblem) && !terminal && <Button disabled={blocked} onClick={() => { if (state.request?.state === 'approved' || state.request?.state === 'consumed') finish(); else void (state.request ? candidate.refresh() : linkToken ? candidate.beginLink(linkToken) : candidate.beginQR()).catch(() => {}); }}>{t.device.retry}</Button>}
  </div>;
}

export function DeviceScanner({ token, onClose }: { token?: string; onClose(): void }) {
  const [approver] = useState(createQRApprover);
  const state = useSyncExternalStore(approver.subscribe, approver.getSnapshot);
  const [paste, setPaste] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const now = useDeviceClock();
  useEffect(() => () => approver.dispose(), [approver]);
  useEffect(() => { setScanning(false); if (token) void approver.preview(token).catch(() => {}); }, [approver, token]);
  useEffect(() => subscribeSessionEpoch(onClose), [onClose]);
  const read = (value: string) => { setScanning(false); const entry = parseDeviceSignInURL(value); if (entry?.type !== 'qr') { setError(t.device.invalidQR); return; } setError(''); setInput(''); void approver.preview(entry.token).catch(() => {}); };
  useEffect(() => {
    if (!scanning || !video.current) return;
    const scanner = startQRScanner(video.current, read, error => { setScanning(false); const name = error instanceof Error ? error.name : ''; setError(name === 'NotAllowedError' ? t.device.cameraDenied : name === 'NotFoundError' ? t.device.cameraMissing : name === 'NotReadableError' ? t.device.cameraBusy : t.device.cameraFailed); });
    return () => scanner.stop();
  }, [scanning]);
  const blocked = state.busy || (state.retryAt ?? 0) > now;
  const expired = state.preview && Date.parse(state.preview.request.expiresAt) <= now;
  return <div className="device-scanner">
    <header><button className="auth-back" disabled={blocked} onClick={onClose}><Icon name="left" />{t.back(t.account.account)}</button></header>
    <section className="device-scanner-content">
      <div className="auth-heading"><h1 tabIndex={-1}>{state.phase === 'preview' ? t.device.previewTitle : state.phase === 'approved' ? t.device.approved : state.phase === 'denied' ? t.device.denied : t.device.scanTitle}</h1><p>{state.phase === 'idle' ? t.device.scanHint : state.phase === 'preview' ? t.device.selfWarning : ''}</p></div>
      {state.phase === 'idle' && <><div className="device-camera"><video ref={video} muted playsInline aria-label={t.device.scan} /><div className="device-scan-frame" aria-hidden="true"><span /><span /><span /><span />{!scanning && <Icon name="camera" />}</div></div>{scanning && <p role="status" className="device-note">{t.device.cameraScanning}</p>}{!scanning && <Button variant="primary" disabled={blocked} onClick={() => { setError(''); setScanning(true); }}>{error ? t.device.retry : t.device.cameraStart}</Button>}<button className="auth-text" aria-expanded={paste} disabled={blocked} onClick={() => setPaste(!paste)}>{t.device.pasteQR}</button>{paste && <form className="auth-fields" onSubmit={e => { e.preventDefault(); setScanning(false); read(input); }}><label>{t.device.pasteQR}<input value={input} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={e => setInput(e.target.value)} /></label><Button type="submit" disabled={!input || blocked}>{t.account.continue}</Button></form>}</>}
      {state.phase === 'preview' && <><div className="device-request">{state.preview && <SignInRequestDetails request={state.preview.request} />}{state.preview && <DeviceDeadline at={state.preview.request.expiresAt} now={now} />}</div>{expired && <p role="status">{t.device.expired}</p>}<Button variant="primary" disabled={blocked || !!expired} onClick={() => void approver.approve().catch(() => {})}>{t.device.approve}</Button><Button disabled={blocked || !!expired} onClick={() => void approver.deny().catch(() => {})}>{t.device.deny}</Button><button className="auth-text" disabled={blocked} onClick={() => { approver.clear(); setError(''); }}>{t.device.scan}</button></>}
      {(state.phase === 'approved' || state.phase === 'denied') && <Button variant="primary" onClick={onClose}>{t.device.done}</Button>}
      {error && <p className="auth-error" role="alert">{error}</p>}<DeviceError problem={state.problem} now={now} />
      {token && state.phase === 'idle' && state.problem && <Button disabled={blocked} onClick={() => void approver.preview(token).catch(() => {})}>{t.device.retry}</Button>}
    </section>
  </div>;
}

export function DeviceIssuer(props: Omit<DeviceLinkFlowProps, 'issuer' | 'defaultOpen'>) {
  return <DeviceLinkFlow {...props} issuer={deviceIssuer} />;
}
