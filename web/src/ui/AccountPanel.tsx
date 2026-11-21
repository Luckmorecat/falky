import { useEffect, useRef, useState } from 'react';
import type { AccountPasskey } from '../api/client';
import { addPasskey, listPasskeys, regenerateRecovery, removePasskey } from '../app/accounts';
import { logout } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { accountError, useAccountUI } from './AccountFlow';
import { DeviceIssuer } from './DeviceSignIn';
import { Button } from './Button';
import { Icon } from './Icon';
import { Orb } from './Orb';
import { SettingsGroup } from './SettingsParts';
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
  const [adding, setAdding] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const palette = useApp(s => (session ? s.colours[session.visitor.id]?.palette : undefined));
  const day = (at: string) => new Date(at).toLocaleDateString(t.locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const copyId = (id: string) => void navigator.clipboard?.writeText(id).then(() => { setIdCopied(true); setTimeout(() => { if (alive.current) setIdCopied(false); }, 2000); }, () => {});
  return <div className="set-stack account-panel">
    {session && <SettingsGroup title={t.account.you}>
      <div className="account-card">
        <Orb seed={session.visitor.id} palette={palette} still />
        <div><strong>{session.visitor.name}</strong><p className="set-note">{session.kind === 'account' ? t.account.kindAccount : t.account.kindGuest}</p></div>
      </div>
      {session.kind === 'account' && <div className="account-row">
        <dl className="auth-account-id"><dt>{t.account.accountId}</dt><dd>{session.visitor.id}</dd></dl>
        <Button onClick={() => copyId(session.visitor.id)}>{idCopied ? t.account.idCopied : t.account.copyId}</Button>
      </div>}
      {session.expiresAt && <div className="account-row"><span>{t.account.expires}</span><time className="set-note" dateTime={session.expiresAt}>{day(session.expiresAt)}</time></div>}
    </SettingsGroup>}
    {session?.kind === 'guest' && <SettingsGroup title={t.account.guestState}>
      <div className="account-row"><p className="set-note">{t.account.upgradeHint}</p><Button disabled={disabled} onClick={() => ui.openEntry()}>{t.account.upgrade}</Button></div>
    </SettingsGroup>}
    {session?.kind === 'account' && <>
      <SettingsGroup title={t.account.passkeys} note={keys?.length === 1 ? `${t.account.lastKey} ${t.account.verifyHint}` : t.account.verifyHint}>
        {keys?.map(key => <div className="account-row" key={key.id}>
          <div><strong>{key.label}</strong><p className="set-note">{t.account.created} <time dateTime={key.createdAt}>{day(key.createdAt)}</time></p></div>
          <Button disabled={disabled || keys.length < 2} title={keys.length < 2 ? t.account.lastKey : undefined} aria-label={`${t.account.removeKey}: ${key.label}`} onClick={() => void mutate(() => removePasskey(key.id))}>{t.account.removeKey}</Button>
        </div>)}
        {adding
          ? <form className="account-add" onSubmit={e => { e.preventDefault(); if (disabled) return; void mutate(async () => { await addPasskey(label || undefined); if (alive.current) { setLabel(''); setAdding(false); } }); }}>
              <label htmlFor="account-key-label">{t.account.keyLabel}</label>
              <input id="account-key-label" autoComplete="off" autoFocus value={label} onChange={e => setLabel(e.target.value)} />
              <p className="set-note">{t.account.keyLabelHint}</p>
              <div className="account-actions"><Button variant="primary" type="submit" disabled={disabled}>{t.account.createKey}</Button><Button disabled={disabled} onClick={() => { setAdding(false); setLabel(''); }}>{t.account.cancel}</Button></div>
            </form>
          : <div className="account-row"><span /><Button disabled={disabled} onClick={() => { setError(''); setAdding(true); }}><Icon name="plus" /><span className="tx">{t.account.addKey}</span></Button></div>}
      </SettingsGroup>
      <DeviceIssuer active={active} disabled={disabled} onScan={onScan} scanFocusRequested={scanFocusRequested} onScanFocused={onScanFocused} />
      <SettingsGroup title={t.account.phrase}>
        <div className="account-row">
          <p className="set-note">{t.account.regenerateWarning}</p>
          {!confirm ? <Button disabled={disabled} onClick={() => setConfirm(true)}>{t.account.regenerate}</Button> : <span className="account-actions">
            <Button variant="primary" disabled={disabled} onClick={() => {
              setError(''); void ui.run(async () => { const phrase = await regenerateRecovery(); ui.presentKit(session.visitor.id, phrase); setConfirm(false); }).catch(err => setError(err && typeof err === 'object' && 'code' in err && err.code === 'outcome_unknown' ? t.account.mutationUnknown : accountError(err)));
            }}>{t.account.regenerateConfirm}</Button><Button disabled={disabled} onClick={() => setConfirm(false)}>{t.account.cancel}</Button>
          </span>}
        </div>
      </SettingsGroup>
    </>}
    {error && <div className="account-error"><p className="auth-error" role="alert">{error}</p>{session?.kind === 'account' && <Button disabled={disabled} onClick={() => { setError(''); void refresh(); }}>{t.account.refresh}</Button>}</div>}
    <div className="account-signout">
      <Button variant="danger" disabled={disabled} onClick={() => {
        setError(''); void ui.run(logout).catch(() => { ui.reportError(t.account.signOutUnknown); });
      }}>{t.account.signOut}</Button>
    </div>
  </div>;
}
