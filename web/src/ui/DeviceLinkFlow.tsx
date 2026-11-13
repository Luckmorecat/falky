import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { deviceIssuer, DeviceProblem } from '../app/deviceSignIn';
import { t } from '../strings';
import { Button } from './Button';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { SignInRequestDetails } from './SignInRequestDetails';
import { InputOTP } from './InputOTP';
import './AccountFlow.css';
import './AccountPanel.css';
import './DeviceSignIn.css';
import './DeviceLinkFlow.css';
import './Forms.css';

export type DeviceLinkIssuer = Pick<typeof deviceIssuer, 'getSnapshot' | 'subscribe' | 'refresh' | 'create' | 'revoke' | 'approve' | 'deny'>;
export type DeviceLinkFlowProps = {
  issuer: DeviceLinkIssuer;
  active: boolean;
  disabled: boolean;
  onScan(): void;
  scanFocusRequested: boolean;
  onScanFocused(): void;
  defaultOpen?: boolean;
};

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
export function DeviceLinkFlow({ issuer, active, disabled, onScan, scanFocusRequested, onScanFocused, defaultOpen = false }: DeviceLinkFlowProps) {
  const state = useSyncExternalStore(issuer.subscribe, issuer.getSnapshot);
  const scanButton = useRef<HTMLButtonElement>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');
  const [fallback, setFallback] = useState('');
  const [codeIssue, setCodeIssue] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadingVisible, setLoadingVisible] = useState(false);
  const previousLinks = useRef<typeof state.links>([]);
  const drawer = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(defaultOpen);
  useEffect(() => {
    const hadLinks = previousLinks.current.length > 0;
    const newlyRevoked = state.links.find(link => link.state === 'revoked' && previousLinks.current.some(previous => previous.id === link.id && previous.state !== 'revoked'));
    const needsAttention = state.links.some(link => {
      const previous = previousLinks.current.find(value => value.id === link.id);
      return (link.state === 'open' && !previous) || link.requests.some(request => request.state === 'pending' && Date.parse(request.expiresAt) > Date.now() && !previous?.requests.some(value => value.id === request.id && value.state === 'pending'));
    });
    previousLinks.current = state.links;
    if (needsAttention) setDrawerOpen(true);
    if ((!state.links.length && hadLinks) || (newlyRevoked && !state.links.some(link => (link.state === 'open' || link.state === 'approved') && Date.parse(link.expiresAt) > Date.now()))) setDrawerOpen(false);
  }, [state.links]);
  useLayoutEffect(() => {
    const el = drawer.current;
    if (!el) return;
    if (drawerOpen && !el.open) el.showModal();
    else if (!drawerOpen && el.open) {
      el.close();
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected && !target.closest('dialog:not([open])')) target.focus();
    }
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [drawerOpen]);
  const now = useDeviceClock();
  useEffect(() => { if (active) void issuer.refresh().catch(() => {}); }, [active, issuer]);
  const blocked = disabled || state.busy || (state.retryAt ?? 0) > now;
  useEffect(() => {
    const target = scanButton.current;
    if (!scanFocusRequested || !active || blocked || !target?.closest('dialog')?.open) return;
    target.focus();
    if (document.activeElement === target) onScanFocused();
  }, [scanFocusRequested, active, blocked, onScanFocused]);
  const links = state.links.filter(link => link.state !== 'revoked' && (link.state === 'open' || link.state === 'approved' || Date.parse(link.expiresAt) > now)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 1);
  const activeLink = links.find(link => (link.state === 'open' || link.state === 'approved') && Date.parse(link.expiresAt) > now);
  const waitingForLink = (creating || (state.busy && !state.links.length)) && !activeLink;
  useEffect(() => {
    if (!waitingForLink) { setLoadingVisible(false); return; }
    const timer = setTimeout(() => { setLoadingVisible(true); setDrawerOpen(true); }, 150);
    return () => clearTimeout(timer);
  }, [waitingForLink]);
  const content = useRef({ links, urls: state.urls });
  if ((links.length && drawerOpen && !waitingForLink) || !state.links.length) content.current = { links, urls: state.urls };
  const drawerLinks = content.current.links;
  const drawerURLs = content.current.urls;
  const openDrawer = () => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDrawerOpen(true); };
  const create = () => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    content.current = { links: [], urls: {} }; setCreating(true); setLoadingVisible(false); setCopied(''); setFallback(''); setCodeIssue('');
    void issuer.create().then(() => setDrawerOpen(true), () => setDrawerOpen(true)).finally(() => setCreating(false));
  };
  return <section className="device-issuer"><h3>{t.device.another}</h3><p className="set-note">{t.device.createHint}</p>
    <div className="account-actions"><Button ref={scanButton} disabled={blocked} onClick={onScan}><Icon name="camera" />{t.device.scan}</Button>
      <Button className={`device-link-slot${activeLink ? ' device-link-item' : ''}`} disabled={blocked && !activeLink} aria-haspopup="dialog" onClick={activeLink ? openDrawer : create}>
        {activeLink ? <><span><strong>{t.device.linkButton}</strong><small><DeviceDeadline at={activeLink.expiresAt} now={now} /></small></span><span aria-hidden="true">→</span></> : t.device.create}
      </Button>
    </div>
    {createPortal(<dialog ref={drawer} className="auth-dialog device-link-drawer device-issuer" aria-labelledby="device-link-title"
      onCancel={e => { e.preventDefault(); e.stopPropagation(); setDrawerOpen(false); }}
      onClose={() => { if (!drawer.current?.open) setDrawerOpen(false); }}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        if (e.target !== e.currentTarget) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (e.clientX < bounds.left || e.clientX >= bounds.right || e.clientY < bounds.top || e.clientY >= bounds.bottom) {
          e.preventDefault(); setDrawerOpen(false);
        }
      }}>
      <header className="device-link-header"><h2 id="device-link-title">{t.device.link}</h2><IconButton aria-label={t.close} onClick={() => setDrawerOpen(false)}><Icon name="x" /></IconButton></header>
      <div className="device-link-area">
      {waitingForLink && loadingVisible ? <div className="device-link-skeleton" role="status" aria-label={t.account.working} aria-busy="true">
        <div aria-hidden="true"><span className="skeleton-deadline" /><span className="skeleton-label" /><span className="skeleton-field" /><div className="account-actions"><span /><span /></div></div>
      </div> : <>
      {drawerLinks.map(link => { const expired = Date.parse(link.expiresAt) <= now; const url = drawerURLs[link.id]; const pending = link.requests.filter(request => request.state === 'pending' && Date.parse(request.expiresAt) > now); return <div className="device-inline-link" key={link.id}>
        <p className="device-wait">{expired ? t.device.expired : link.state === 'approved' ? t.device.linkApproved : link.state === 'consumed' ? t.device.consumed : <DeviceDeadline at={link.expiresAt} now={now} />}</p>
        {(link.state === 'open' || link.state === 'approved') && !expired && <>{link.state === 'open' && (url ? <label className="device-copy"><span>{fallback === link.id ? t.device.copyFallback : t.device.link}</span><input readOnly value={url} onFocus={e => e.target.select()} /></label> : <p className="set-note">{t.device.lostLink}</p>)}<div className="account-actions">{link.state === 'open' && url && <Button disabled={blocked} onClick={() => { void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('clipboard unavailable'))).then(() => setCopied(link.id), () => setFallback(link.id)); }}>{copied === link.id ? t.device.copied : t.device.copy}</Button>}<Button variant="danger" disabled={blocked} onClick={() => void issuer.revoke(link.id).catch(() => {})}>{t.device.revoke}</Button></div></>}
        {pending.length > 0 && <><h4>{t.device.pending}</h4><div className="device-pending-list" role="list">{pending.map(request => <div className="account-key device-pending" role="listitem" key={request.id}><SignInRequestDetails request={request} /><Button disabled={blocked} onClick={() => void issuer.deny(link.id, request.id).catch(() => {})}>{t.device.deny}</Button></div>)}</div><p className="set-note">{t.device.selfWarning}</p><form className="device-code-form" onSubmit={e => { e.preventDefault(); const code = codes[link.id] ?? ''; if (/^[0-9]{4}$/.test(code)) { setCodeIssue(link.id); void issuer.approve(link.id, code).then(() => setCodes(current => ({ ...current, [link.id]: '' }))).catch(() => {}); } }}><label className="device-code-label" htmlFor={`device-code-${link.id}`}>{t.device.codeLabel}<span className="device-code-beacon" aria-hidden="true" data-active={!blocked && (codes[link.id] ?? '').length < 4 || undefined} /></label><InputOTP id={`device-code-${link.id}`} maxLength={4} disabled={blocked} value={codes[link.id] ?? ''} onChange={code => setCodes(current => ({ ...current, [link.id]: code }))} /><Button variant="primary" type="submit" disabled={blocked || !/^[0-9]{4}$/.test(codes[link.id] ?? '')}>{t.device.approve}</Button></form><p className="set-note">{t.device.codePolicy}</p></>}
      </div>; })}</>}
      </div>{!waitingForLink && <DeviceError problem={state.problem?.code === 'invalid_proof' && state.links.some(link => link.id === codeIssue && link.state === 'open' && Date.parse(link.expiresAt) > now) ? { code: 'invalid_code' } : state.problem} now={now} />}
    </dialog>, document.body)}
  </section>;
}
