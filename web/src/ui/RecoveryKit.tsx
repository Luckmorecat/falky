import { useEffect, useRef, useState } from 'react';
import { t } from '../strings';
import { Button } from './Button';

export function RecoveryWords({ words, onChange, onError }: { words: string[]; onChange(words: string[]): void; onError(error: string): void }) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  return <fieldset className="auth-word-fields"><legend>{t.account.phrase}</legend><div className="auth-word-grid">{words.map((word, index) => <label className="auth-word" key={index}>
    <span aria-hidden="true">{index + 1}</span><input ref={(el) => { inputs.current[index] = el; }} aria-label={`${t.account.word} ${index + 1}`} aria-describedby="auth-words-hint" value={word} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
      onChange={(e) => { const next = [...words]; next[index] = e.target.value.trim().toLowerCase(); onChange(next); }}
      onPaste={(e) => {
        e.preventDefault();
        const parts = e.clipboardData.getData('text').trim().toLowerCase().split(/\s+/);
        const start = parts.length === 12 ? 0 : index;
        if (parts.length > 12 - start || parts.some(part => !part || /\s/.test(part))) { onError(t.account.wordsError); return; }
        const next = [...words]; parts.forEach((part, offset) => { next[start + offset] = part; }); onChange(next);
        inputs.current[Math.min(start + parts.length, 11)]?.focus();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (word && index < 11) inputs.current[index + 1]?.focus(); }
        if (e.key === 'Backspace' && !word && index > 0) { e.preventDefault(); inputs.current[index - 1]?.focus(); }
      }} />
  </label>)}</div><p id="auth-words-hint" className="auth-field-note">{t.account.wordsHint}</p></fieldset>;
}

export function recoveryKitText(accountId: string, phrase: string): string {
  return `${t.account.kitTitle}\n\n${t.account.accountId}: ${accountId}\n${t.account.phrase}: ${phrase}\n\n${t.account.kitHint}\n`;
}

export function SaveRecoveryKit({ accountId, phrase, busy, onContinue }: { accountId: string; phrase: string; busy: boolean; onContinue(): void }) {
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(recoveryKitText(accountId, phrase)); if (alive.current) setCopyStatus(t.account.copied); }
    catch { if (alive.current) setCopyStatus(t.account.copyFailed); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([recoveryKitText(accountId, phrase)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'falky-recovery-kit.txt'; document.body.append(link);
    try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
  };
  return <section className="auth-content auth-save">
    <div className="auth-heading"><h1 ref={heading} tabIndex={-1}>{t.account.saveTitle}</h1><p>{t.account.saveHint}</p></div>
    <dl className="auth-account-id"><dt>{t.account.accountId}</dt><dd>{accountId}</dd></dl>
    <ol className="auth-phrase-sheet" aria-label={t.account.phrase}>{phrase.split(' ').map((word, i) => <li key={i}><span aria-hidden="true">{i + 1}</span><strong>{word}</strong></li>)}</ol>
    <div className="auth-kit-actions"><Button onClick={() => void copy()}>{t.account.copyKit}</Button><Button onClick={download}>{t.account.downloadKit}</Button></div>
    {copyStatus && <p role="status" className="auth-field-note">{copyStatus}</p>}
    <label className="auth-ack"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />{t.account.saved}</label>
    <Button variant="primary" disabled={!saved || busy} onClick={() => { if (saved && !busy) onContinue(); }}>{t.account.continue}</Button>
  </section>;
}
