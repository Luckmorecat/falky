import { useEffect, useRef, useState } from 'react';
import type { AccountPasskey } from '../api/client';
import { addPasskey, listPasskeys, regenerateRecovery, removePasskey } from '../app/accounts';
import { logout } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { accountError, useAccountUI } from './AccountFlow';
import { DeviceIssuer } from './DeviceSignIn';
import { Button } from './Button';
import './AccountFlow.css';
import './AccountPanel.css';
import './Forms.css';

export function AccountPanel({ active, onScan, scanFocusRequested, onScanFocused }: { active: boolean; onScan(): void; scanFocusRequested: boolean; onScanFocused(): void }) {
  const session = useApp(s => s.accountSession);
  const ui = useAccountUI();
  const [keys, setKeys] = useState<AccountPasskey[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = async () => {
    setLoading(true);
    try { const result = await listPasskeys(); if (alive.current) setKeys(result); }
    catch (err) { if (alive.current) setError(accountError(err)); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => {
    if (!active || ui.locked || ui.entryOpen || session?.kind !== 'account') return;
    let cancelled = false;
    const abort = new AbortController();
    setLoading(true);
    void listPasskeys(abort.signal).then(result => { if (!cancelled) setKeys(result); }, err => { if (!cancelled) setError(accountError(err)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; abort.abort(); };
  }, [active, ui.locked, ui.entryOpen, session?.kind, session?.visitor.id]);
  const mutate = async (action: () => Promise<unknown>) => {
    setError('');
    try { await ui.run(action); }
    catch (err) {
      if (alive.current) setError(err && typeof err === 'object' && 'code' in err && err.code === 'outcome_unknown' ? t.account.mutationUnknown : accountError(err));
    }
  };
  const disabled = loading || ui.locked;
  return <div className="account-panel">
    {session?.kind === 'account' && <>
      <DeviceIssuer active={active} disabled={disabled} onScan={onScan} scanFocusRequested={scanFocusRequested} onScanFocused={onScanFocused} />
      <section>
        <h3>{t.account.passkeys}</h3>
        <p className="set-note">{t.account.verifyHint}</p>
        <div className="account-key-list" aria-busy={loading}>
          {keys?.map(key => <div className="account-key" key={key.id}>
            <div><strong>{key.label}</strong><p className="set-note">{t.account.created} <time dateTime={key.createdAt}>{new Date(key.createdAt).toLocaleString(t.locale)}</time></p></div>
            <Button disabled={disabled || keys.length < 2} title={keys.length < 2 ? t.account.lastKey : undefined} aria-label={`${t.account.removeKey}: ${key.label}`} onClick={() => void mutate(() => removePasskey(key.id))}>{t.account.removeKey}</Button>
          </div>)}
        </div>
        {keys?.length === 1 && <p className="set-note">{t.account.lastKey}</p>}
        <Button disabled={disabled} onClick={() => { setError(''); void refresh(); }}>{t.account.refresh}</Button>
        <form className="account-add" onSubmit={e => { e.preventDefault(); if (disabled) return; void mutate(async () => { await addPasskey(label || undefined); if (alive.current) setLabel(''); }); }}>
          <label htmlFor="account-key-label">{t.account.keyLabel}</label><input id="account-key-label" autoComplete="off" value={label} onChange={e => setLabel(e.target.value)} />
          <Button type="submit" disabled={disabled}>{t.account.addKey}</Button>
        </form>
      </section>
      <section>
        <h3>{t.account.phrase}</h3><p className="set-note">{t.account.regenerateWarning}</p>
        {!confirm ? <Button disabled={disabled} onClick={() => setConfirm(true)}>{t.account.regenerate}</Button> : <div className="account-actions">
          <Button disabled={disabled} onClick={() => {
            setError(''); void ui.run(async () => { const phrase = await regenerateRecovery(); ui.presentKit(session.visitor.id, phrase); setConfirm(false); }).catch(err => setError(err && typeof err === 'object' && 'code' in err && err.code === 'outcome_unknown' ? t.account.mutationUnknown : accountError(err)));
          }}>{t.account.regenerateConfirm}</Button><Button disabled={disabled} onClick={() => setConfirm(false)}>{t.account.cancel}</Button>
        </div>}
      </section>
    </>}
    <section>
      {session?.kind === 'guest' && <h3>{t.account.guestState}</h3>}
      {session?.kind === 'account' && <dl className="auth-account-id"><dt>{t.account.accountId}</dt><dd>{session.visitor.id}</dd></dl>}
      {session?.expiresAt && <p className="set-note">{t.account.expires} <time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleString(t.locale)}</time></p>}
      <div className="account-actions">
        {session?.kind === 'guest' && <Button disabled={disabled} onClick={() => { setUpgrade(true); ui.openEntry(); }}>{t.account.upgrade}</Button>}
        <Button variant="danger" disabled={disabled} onClick={() => {
          setError(''); void ui.run(logout).catch(() => { ui.reportError(t.account.signOutUnknown); });
        }}>{t.account.signOut}</Button>
      </div>
      {upgrade && <p className="set-note">{t.account.upgradeHint}</p>}
    </section>
    {error && <p className="auth-error" role="alert">{error}</p>}
  </div>;
}
