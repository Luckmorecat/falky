import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { startQRScanner } from '@falky/browser';
import { createDeviceCandidate, createQRApprover, deviceIssuer, type DeviceProblem } from '../app/deviceSignIn';
import { parseDeviceSignInURL } from '../app/entryLinks';
import { subscribeSessionEpoch } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
import { Icon } from './Icon';
import { Orb } from './Orb';

export function useDeviceClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
function remaining(deadline: string | number, now: number) {
  const seconds = Math.max(0, Math.ceil(((typeof deadline === 'number' ? deadline : Date.parse(deadline)) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function DeviceDeadline({ at, now }: { at: string; now: number }) { return <span>{t.device.expiry} <time dateTime={at}>{remaining(at, now)}</time></span>; }
export function DeviceError({ problem, now }: { problem?: DeviceProblem; now: number }) {
  if (!problem) return null;
  const message = problem.code in t.device.errors ? t.device.errors[problem.code as keyof typeof t.device.errors] : problem.code === 'rate_limited' ? t.device.rateLimited : problem.code === 'outcome_unknown' ? t.device.outcomeUnknown : problem.code === 'invalid_code' ? t.device.codeWrong : problem.code === 'invalid_proof' || problem.code === 'stale' ? t.device.unavailable : t.device.requestFailed;
  return <p className="auth-error" role="alert">{message}{problem.retryAt && problem.retryAt > now ? ` ${remaining(problem.retryAt, now)}` : ''}</p>;
}
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
  const [input, setInput] = useState('');
  const [badLink, setBadLink] = useState(false);
  const now = useDeviceClock();
  useEffect(() => () => candidate.dispose(), [candidate]);
  useEffect(() => { if (consent && (method === 'qr' || token)) void (token ? candidate.beginLink(token) : candidate.beginQR()).catch(() => {}); }, [candidate, consent, token]);
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
      : terminal ? <Button disabled={blocked} onClick={() => { if (token) void candidate.beginLink(token).catch(() => {}); else { setMethod('qr'); void candidate.beginQR(true).catch(() => {}); } }}>{t.device.retry}</Button>
      : <>
        {method === 'qr' && state.url && <QR value={state.url} />}
        {state.code && <p className="device-code" aria-label={`${t.device.codeLabel}: ${state.code}`}>{[...state.code].map((digit, i) => <span key={i}>{digit}</span>)}</p>}
        {state.request && <p className="device-wait" role="status">{t.device.waiting} · <DeviceDeadline at={state.request.expiresAt} now={now} /></p>}
        {method === 'qr' && <><p className="device-note">{t.device.qrInstructions}</p><button className="auth-text" disabled={blocked} onClick={() => { void candidate.cancel().catch(() => {}); setMethod('link'); }}>{t.device.useLink}</button></>}
        {method === 'link' && !state.code && <form className="auth-fields" onSubmit={e => { e.preventDefault(); const entry = parseDeviceSignInURL(input); if (entry?.type !== 'link') { setBadLink(true); return; } setInput(''); setBadLink(false); void candidate.beginLink(entry.token).catch(() => {}); }}><label>{t.device.pasteLink}<input value={input} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={e => setInput(e.target.value)} /></label><Button type="submit" variant="primary" disabled={blocked || !input}>{t.account.continue}</Button></form>}
        {state.code && <button className="auth-text" disabled={blocked} onClick={() => void candidate.resend().catch(() => {})}>{t.device.resend}</button>}
      </>}
    {badLink && <p className="auth-error" role="alert">{t.device.unavailable}</p>}
    <DeviceError problem={state.problem ?? finishProblem} now={now} />
    {(state.problem || finishProblem) && !terminal && <Button disabled={blocked} onClick={() => { if (state.request?.state === 'approved' || state.request?.state === 'consumed') finish(); else void (state.request ? candidate.refresh() : token ? candidate.beginLink(token) : candidate.beginQR()).catch(() => {}); }}>{t.device.retry}</Button>}
  </div>;
}

export function DeviceScanner({ token, onClose }: { token?: string; onClose(): void }) {
  const [approver] = useState(createQRApprover);
  const state = useSyncExternalStore(approver.subscribe, approver.getSnapshot);
  const name = useApp(s => s.visitor?.name ?? '');
  const accountId = useApp(s => s.visitor?.id ?? '');
  const [paste, setPaste] = useState(false);
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const now = useDeviceClock();
  useEffect(() => { if (token) void approver.preview(token).catch(() => {}); return () => approver.dispose(); }, [approver, token]);
  useEffect(() => subscribeSessionEpoch(onClose), [onClose]);
  const read = (value: string) => { setScanning(false); const entry = parseDeviceSignInURL(value); if (entry?.type !== 'qr') { setError(t.device.invalidQR); return; } setError(''); setInput(''); void approver.preview(entry.token).catch(() => {}); };
  useEffect(() => {
    if (!scanning || !video.current) return;
    const scanner = startQRScanner(video.current, read, error => { setScanning(false); const name = error instanceof Error ? error.name : ''; setError(name === 'NotAllowedError' ? t.device.cameraDenied : name === 'NotFoundError' ? t.device.cameraMissing : name === 'NotReadableError' ? t.device.cameraBusy : t.device.cameraFailed); });
    return () => scanner.stop();
  }, [scanning]);
  const blocked = creating || state.busy || (state.retryAt ?? 0) > now;
  const expired = state.preview && Date.parse(state.preview.request.expiresAt) <= now;
  return <div className="device-scanner">
    <header><button className="auth-back" disabled={blocked} onClick={onClose}><Icon name="left" />{t.back(t.account.account)}</button><span className="device-scanner-identity"><Orb seed={accountId} palette="sky" still /><span>{name}<small>{t.account.accountState}</small></span></span></header>
    <section className="device-scanner-content">
      <div className="auth-heading"><h1 tabIndex={-1}>{state.phase === 'preview' ? t.device.previewTitle : state.phase === 'approved' ? t.device.approved : state.phase === 'denied' ? t.device.denied : t.device.scanTitle}</h1><p>{state.phase === 'idle' ? t.device.scanHint : state.phase === 'preview' ? t.device.selfWarning : ''}</p></div>
      {state.phase === 'idle' && <><div className="device-camera"><video ref={video} muted playsInline aria-label={t.device.scan} /><div className="device-scan-frame" aria-hidden="true"><span /><span /><span /><span />{!scanning && <Icon name="camera" />}</div></div><p role="status" className="device-note">{scanning ? t.device.cameraScanning : ''}</p>{!scanning && <Button variant="primary" disabled={blocked} onClick={() => { setError(''); setScanning(true); }}>{error ? t.device.retry : t.device.cameraStart}</Button>}<button className="auth-text" disabled={blocked} onClick={() => { setScanning(false); setCreating(true); void deviceIssuer.create().then(onClose, () => setError(t.device.requestFailed)).finally(() => setCreating(false)); }}>{t.device.createInstead}</button><button className="auth-text" aria-expanded={paste} disabled={blocked} onClick={() => setPaste(!paste)}>{t.device.pasteQR}</button>{paste && <form className="auth-fields" onSubmit={e => { e.preventDefault(); setScanning(false); read(input); }}><label>{t.device.pasteQR}<input value={input} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={e => setInput(e.target.value)} /></label><Button type="submit" disabled={!input || blocked}>{t.account.continue}</Button></form>}</>}
      {state.phase === 'preview' && <><div className="device-request"><small>{t.device.browser}</small><p>{state.preview?.request.requesterUserAgent || t.device.noBrowser}</p>{state.preview && <DeviceDeadline at={state.preview.request.expiresAt} now={now} />}</div>{expired && <p role="status">{t.device.expired}</p>}<Button variant="primary" disabled={blocked || !!expired} onClick={() => void approver.approve().catch(() => {})}>{t.device.approve}</Button><Button disabled={blocked || !!expired} onClick={() => void approver.deny().catch(() => {})}>{t.device.deny}</Button><button className="auth-text" disabled={blocked} onClick={() => { approver.clear(); setError(''); }}>{t.device.scan}</button></>}
      {(state.phase === 'approved' || state.phase === 'denied') && <Button variant="primary" onClick={onClose}>{t.device.done}</Button>}
      {error && <p className="auth-error" role="alert">{error}</p>}<DeviceError problem={state.problem} now={now} />
      {token && state.phase === 'idle' && state.problem && <Button disabled={blocked} onClick={() => void approver.preview(token).catch(() => {})}>{t.device.retry}</Button>}
    </section>
  </div>;
}

export function DeviceIssuer({ active, disabled, onScan, scanFocusRequested, onScanFocused }: { active: boolean; disabled: boolean; onScan(): void; scanFocusRequested: boolean; onScanFocused(): void }) {
  const state = useSyncExternalStore(deviceIssuer.subscribe, deviceIssuer.getSnapshot);
  const scanButton = useRef<HTMLButtonElement>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');
  const [fallback, setFallback] = useState('');
  const [codeIssue, setCodeIssue] = useState('');
  const now = useDeviceClock();
  useEffect(() => { if (active) void deviceIssuer.refresh().catch(() => {}); }, [active]);
  const blocked = disabled || state.busy || (state.retryAt ?? 0) > now;
  useEffect(() => {
    const target = scanButton.current;
    if (!scanFocusRequested || !active || blocked || !target?.closest('dialog')?.open) return;
    target.focus();
    if (document.activeElement === target) onScanFocused();
  }, [scanFocusRequested, active, blocked, onScanFocused]);
  const links = state.links.filter(link => link.state === 'open' || link.requests.some(r => r.state === 'approved') || (link.state !== 'consumed' && Date.parse(link.expiresAt) > now));
  return <section className="device-issuer"><h3>{t.device.another}</h3><p className="set-note">{t.device.createHint}</p>
    <div className="account-actions"><Button ref={scanButton} disabled={blocked} onClick={onScan}><Icon name="camera" />{t.device.scan}</Button><Button disabled={blocked} onClick={() => { setCopied(''); setFallback(''); setCodeIssue(''); void deviceIssuer.create().catch(() => {}); }}>{links.some(l => l.state === 'open') ? t.device.replaceLink : t.device.create}</Button></div>
    {links.some(l => l.state === 'open') && <p className="set-note">{t.device.replaceHint}</p>}
    {links.map(link => { const expired = Date.parse(link.expiresAt) <= now; const url = state.urls[link.id]; const pending = link.requests.filter(request => request.state === 'pending' && Date.parse(request.expiresAt) > now); return <div className="device-inline-link" key={link.id}>
      <p className="device-wait">{expired ? t.device.expired : link.state === 'revoked' ? t.device.revoked : link.state === 'approved' ? t.device.linkApproved : link.state === 'consumed' ? t.device.consumed : <DeviceDeadline at={link.expiresAt} now={now} />}</p>
      {link.state === 'open' && !expired && <><div className="account-actions">{url && <Button disabled={blocked} onClick={() => { void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('clipboard unavailable'))).then(() => setCopied(link.id), () => setFallback(link.id)); }}>{copied === link.id ? t.device.copied : t.device.copy}</Button>}<Button disabled={blocked} onClick={() => void deviceIssuer.revoke(link.id).catch(() => {})}>{t.device.revoke}</Button></div>{url ? <label className="device-copy"><span>{fallback === link.id ? t.device.copyFallback : t.device.link}</span><input readOnly value={url} onFocus={e => e.target.select()} /></label> : <p className="set-note">{t.device.lostLink}</p>}</>}
      {pending.length > 0 && <><h4>{t.device.pending}</h4>{pending.map(request => <div className="device-pending" key={request.id}><p>{request.requesterUserAgent || t.device.noBrowser}</p><Button disabled={blocked} onClick={() => void deviceIssuer.deny(link.id, request.id).catch(() => {})}>{t.device.deny}</Button></div>)}<p className="set-note">{t.device.selfWarning}</p><form className="device-code-form" onSubmit={e => { e.preventDefault(); const code = codes[link.id] ?? ''; if (/^[0-9]{4}$/.test(code)) { setCodeIssue(link.id); void deviceIssuer.approve(link.id, code).then(() => setCodes(current => ({ ...current, [link.id]: '' }))).catch(() => {}); } }}><label>{t.device.codeLabel}<input inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" maxLength={4} value={codes[link.id] ?? ''} onChange={e => setCodes(current => ({ ...current, [link.id]: e.target.value.replace(/[^0-9]/g, '') }))} /></label><Button variant="primary" type="submit" disabled={blocked || !/^[0-9]{4}$/.test(codes[link.id] ?? '')}>{t.device.approve}</Button></form><p className="set-note">{t.device.codePolicy}</p></>}
    </div>; })}<DeviceError problem={state.problem?.code === 'invalid_proof' && state.links.some(link => link.id === codeIssue && link.state === 'open' && Date.parse(link.expiresAt) > now) ? { code: 'invalid_code' } : state.problem} now={now} />
  </section>;
}
