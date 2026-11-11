import { createContext, lazy, Suspense, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { authenticate, cancelAccountFlow, completeEnrollment, recover, recoveryPhrase, register, type PendingEnrollment } from '../app/accounts';
import { enter, reconcileSession } from '../app/controller';
import { clearEntryLinks, clearDeviceEntry, getDeviceEntry, getEntryLinks, subscribeEntryLinks, takeDeviceEntry } from '../app/entryLinks';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
import { Orb } from './Orb';
const DeviceReceiver = lazy(() => import('./DeviceSignIn').then(module => ({ default: module.DeviceReceiver })));
const DeviceScanner = lazy(() => import('./DeviceSignIn').then(module => ({ default: module.DeviceScanner })));
import { RecoveryWords, SaveRecoveryKit } from './RecoveryKit';

type Step = 'welcome' | 'guest' | 'register' | 'recover';
type Kit = { accountId: string; phrase: string; enrollment?: PendingEnrollment };
type AccountUI = {
  locked: boolean;
  deviceOpen: boolean;
  openDevice(): void;
  openScanner(): void;
  completeEntry(): void;
  entryOpen: boolean;
  openEntry(): void;
  run<T>(action: () => Promise<T>): Promise<T>;
  presentKit(accountId: string, phrase: string): void;
  step: Step;
  navigate(step: Step): void;
  exit(): void;
  error: string;
  attempt(action: () => Promise<void>): void;
  restore(): void;
  unknown: boolean;
  reportError(message: string): void;
};
const Context = createContext<AccountUI | null>(null);
export function useAccountUI(): AccountUI { const value = useContext(Context); if (!value) throw new Error('AccountFlowProvider required'); return value; }

export function accountError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'other';
  if (code in t.account.errors) return t.account.errors[code as keyof typeof t.account.errors];
  if (code in t.errors) return t.errors[code as keyof typeof t.errors];
  return t.errors.other;
}

/** Owns once-only server material above both the entrance and lazy Settings. */
export function AccountFlowProvider({ children }: { children: ReactNode }) {
  const links = useSyncExternalStore(subscribeEntryLinks, getEntryLinks);
  const deviceEntry = useSyncExternalStore(subscribeEntryLinks, getDeviceEntry);
  const session = useApp(s => s.accountSession);
  const [device, setDevice] = useState<{ type: 'receiver' | 'scanner'; token?: string } | null>(null);
  const deviceDialog = useRef<HTMLDialogElement>(null);
  const phase = useApp(s => s.phase);
  const ready = phase === 'ready';
  useApp(s => s.settings.language);
  const [opened, setOpened] = useState(false);
  const [chosen, setChosen] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [kit, setKit] = useState<Kit | null>(null);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = busy || !!kit;
  const step = chosen ?? (links.recovery ? 'recover' : links.invitation ? 'register' : links.guest ? 'guest' : 'welcome');
  useEffect(() => {
    if (!locked && !unknown && (links.invitation || links.recovery || links.guest)) { setChosen(null); if (ready) setOpened(true); }
  }, [links, ready, locked, unknown]);
  useEffect(() => () => { cancelAccountFlow(); clearEntryLinks(); clearDeviceEntry(); }, []);
  useEffect(() => {
    if (!deviceEntry || phase === 'loading' || busy || kit || unknown) return;
    if (deviceEntry.type === 'qr' && session?.kind !== 'account') {
      if (ready) setOpened(true);
      return;
    }
    const entry = takeDeviceEntry();
    if (entry) { setOpened(false); setDevice({ type: entry.type === 'link' ? 'receiver' : 'scanner', token: entry.token }); }
  }, [deviceEntry, session?.kind, phase, ready, busy, kit, unknown]);
  useLayoutEffect(() => {
    const el = deviceDialog.current;
    if (!el) return;
    if (device && !el.open) { el.showModal(); el.querySelector<HTMLElement>('h1')?.focus(); }
    else if (!device && el.open) el.close();
  }, [device]);
  const modal = locked || (opened && ready);
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (modal && !el.open) el.showModal();
    else if (!modal && el.open) el.close();
  }, [modal]);
  const run = async <T,>(action: () => Promise<T>): Promise<T> => {
    if (running.current) throw new Error('busy');
    running.current = true; setBusy(true);
    try { return await action(); }
    finally { running.current = false; setBusy(false); }
  };
  const finishEntry = (preserveDevice: boolean) => {
    if (locked || unknown) return;
    cancelAccountFlow(); clearEntryLinks(); if (!preserveDevice) clearDeviceEntry(); setChosen('welcome'); setOpened(false); setError(''); setUnknown(false);
  };
  const exit = () => finishEntry(false);
  const completeEntry = () => finishEntry(true);
  const closeDevice = () => { setDevice(null); clearDeviceEntry(); };
  const attempt = (action: () => Promise<void>) => {
    if (locked || unknown) return;
    setError('');
    void run(action).catch((err: unknown) => {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'outcome_unknown') { setUnknown(true); setError(t.account.unknown); }
      else setError(accountError(err));
    });
  };
  const ui: AccountUI = {
    locked: locked || !!device, deviceOpen: !!device, openDevice: () => { if (!locked) { clearDeviceEntry(); setDevice({ type: 'receiver' }); } }, openScanner: () => { if (!locked) setDevice({ type: 'scanner' }); }, completeEntry, entryOpen: opened, step, error, unknown, run, exit, reportError: setError,
    openEntry: () => { if (!locked && !unknown) { setChosen(null); setOpened(true); setError(''); } },
    navigate: next => { if (!locked && !unknown) { setChosen(next); setError(''); } },
    presentKit: (accountId, phrase) => { setKit({ accountId, phrase }); },
    attempt,
    restore: () => {
      if (locked) return;
      setError('');
      void run(async () => { await reconcileSession(); clearEntryLinks(); setUnknown(false); setOpened(false); setChosen('welcome'); }).catch(err => setError(accountError(err)));
    },
  };
  const enroll = (value: PendingEnrollment) => setKit({ accountId: value.session.visitor.id, phrase: recoveryPhrase(value.recoveryCodes), enrollment: value });
  return <Context.Provider value={ui}>
    <EnrollmentContext.Provider value={enroll}>{children}
      <dialog ref={deviceDialog} className={`device-dialog${device?.type === 'scanner' ? ' device-dialog-scanner' : ''}`} aria-label={device?.type === 'scanner' ? t.device.scan : t.device.another} onCancel={e => { e.preventDefault(); closeDevice(); }}>
        <Suspense fallback={<p role="status">{t.account.working}</p>}>{device?.type === 'scanner' ? <DeviceScanner token={device.token} onClose={closeDevice} /> : device ? <DeviceReceiver token={device.token} onClose={closeDevice} /> : null}</Suspense>
      </dialog>
      <dialog ref={dialog} className="auth-dialog" aria-label={kit ? t.account.saveTitle : t.account.account}
        onCancel={e => { e.preventDefault(); if (!locked) exit(); }}
        onPointerDown={e => { if (e.target === e.currentTarget && !locked) exit(); }}>
        {opened && ready && <div hidden={locked}><AccountEntrance overlay /></div>}
        {kit ? <div className="auth-centre"><SaveRecoveryKit key={kit.phrase} accountId={kit.accountId} phrase={kit.phrase} busy={busy} onContinue={() => {
          if (!kit || running.current) return;
          void run(async () => { if (kit.enrollment) await completeEnrollment(kit.enrollment); setKit(null); setOpened(false); setChosen('welcome'); setError(''); }).catch(err => setError(accountError(err)));
        }} />{error && <p className="auth-error" role="alert">{error}</p>}</div>
          : busy ? <div className="auth-busy" role="status"><Orb seed="entry" palette="sky" /><p>{t.account.busy}</p><p className="auth-field-note">{t.account.working}</p></div>
            : null}
      </dialog>
    </EnrollmentContext.Provider>
  </Context.Provider>;
}
const EnrollmentContext = createContext<(result: PendingEnrollment) => void>(() => {});

export function AccountEntrance({ overlay = false }: { overlay?: boolean }) {
  const ui = useAccountUI();
  const enroll = useContext(EnrollmentContext);
  const links = useSyncExternalStore(subscribeEntryLinks, getEntryLinks);
  const visitorName = useApp(s => s.visitor?.name ?? '');
  const phase = useApp(s => s.phase);
  const [name, setName] = useState(visitorName);
  const [accountId, setAccountId] = useState('');
  const [words, setWords] = useState(Array<string>(12).fill(''));
  const [wordError, setWordError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); if (ui.step !== 'recover') { setWords(Array<string>(12).fill('')); setAccountId(''); setWordError(''); } }, [ui.step]);
  const title = ui.step === 'guest' ? t.enterTitle : ui.step === 'register' ? t.account.invitation : ui.step === 'recover' ? t.account.recoveryTitle : t.account.welcome;
  const hint = ui.step === 'guest' ? t.account.guestHint : ui.step === 'register' ? t.account.registerHint : ui.step === 'recover' ? links.recovery ? t.account.operatorHint : t.account.recoveryHint : t.account.welcomeHint;
  return <div className={overlay ? 'auth-layout' : 'screen auth-screen'}><div className={`auth-centre auth-step-${ui.step}`}>
    {!overlay && <div className="auth-topbar"><span className="mark">falky</span></div>}
    <div className="auth-voice"><Orb seed="entry" palette="sky" /></div>
    <section className="auth-content">
      {(overlay || ui.step !== 'welcome' || getDeviceEntry()?.type === 'qr') && <button type="button" className="auth-back" disabled={ui.locked || ui.unknown} onClick={ui.exit}>{overlay ? t.account.returnApp : getDeviceEntry()?.type === 'qr' ? t.account.cancel : t.account.chooseAccess}</button>}
      <div className="auth-heading"><h1 ref={heading} tabIndex={-1}>{title}</h1><p>{hint}</p></div>
      {getDeviceEntry()?.type === 'qr' && <p className="device-note" role="status">{t.device.authResume}</p>}
      {(phase === 'revoked' || phase === 'noaccess') && <p className="auth-field-note">{t.account.ended}</p>}
      {ui.step === 'welcome' ? <div className="auth-actions">
        <Button variant="primary" disabled={ui.locked || ui.unknown} onClick={() => ui.attempt(async () => { await authenticate(); ui.completeEntry(); })}>{t.account.signIn}</Button>
        <p className="auth-field-note">{t.account.passkeyHint}</p>
        <button className="device-choice" disabled={ui.locked || ui.unknown} onClick={ui.openDevice}><span><strong>{t.device.another}</strong><small>{t.device.anotherHint}</small></span><span aria-hidden="true">→</span></button>
        <button className="auth-text" disabled={ui.locked || ui.unknown} onClick={() => ui.navigate('recover')}>{t.account.recover}</button>
        <p className="auth-invite">{t.account.invitationHint}</p>
      </div> : <form className="auth-fields" noValidate onSubmit={e => {
        e.preventDefault();
        if (ui.step === 'guest' && name.trim()) ui.attempt(async () => { const error = await enter(name.trim()); if (error) { setWordError(error); return; } ui.exit(); });
        if (ui.step === 'register' && name.trim() && links.invitation) ui.attempt(async () => enroll(await register(links.invitation!, name.trim())));
        if (ui.step === 'recover') {
          if (!links.recovery && (!accountId.trim() || words.some(word => !word || /\s/.test(word)))) { setWordError(t.account.wordsError); return; }
          ui.attempt(async () => enroll(await recover(links.recovery?.accountId ?? accountId.trim(), links.recovery?.proof ?? words.join(' '))));
        }
      }}>
        {(ui.step === 'register' || ui.step === 'guest') && <label>{t.name}<input maxLength={32} autoComplete="off" value={name} onChange={e => setName(e.target.value)} /></label>}
        {ui.step === 'recover' && <>
          {!links.recovery && <><label>{t.account.accountId}<input autoComplete="off" autoCapitalize="none" spellCheck={false} value={accountId} onChange={e => setAccountId(e.target.value)} /></label><RecoveryWords words={words} onChange={next => { setWords(next); setWordError(''); }} onError={setWordError} /></>}
          <p className="auth-field-note">{t.account.replacementWarning}</p>
        </>}
        <Button variant="primary" type="submit" disabled={ui.locked || ui.unknown || ((ui.step === 'guest' || ui.step === 'register') && !name.trim()) || (ui.step === 'recover' && !links.recovery && (!accountId.trim() || words.some(word => !word)))}>{ui.step === 'guest' ? t.account.guestEnter : ui.step === 'register' ? t.account.register : t.account.replace}</Button>
      </form>}
      {(ui.error || wordError) && <p className="auth-error" role="alert">{ui.error || wordError}</p>}
      {ui.unknown && <Button onClick={ui.restore} disabled={ui.locked}>{t.account.restore}</Button>}
    </section>
  </div></div>;
}
