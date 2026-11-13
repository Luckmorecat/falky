import { useEffect, useRef, useState } from 'react';
import { rename } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
import './Forms.css';
import './Screens.css';
export { AccountEntrance as Entry } from './AccountFlow';

/** Someone else took this visitor's name while they were away. */
export function NameConflict() {
  const current = useApp((s) => s.visitor?.name ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n) setError((await rename(n)) ?? '');
  };

  return (
    <form className="conflict" onSubmit={(e) => void submit(e)} role="alertdialog" aria-label={t.nameConflictTitle(current)}>
      <h2>{t.nameConflictTitle(current)}</h2>
      <p>{t.nameConflictBody}</p>
      <div className="namerow">
        <input ref={input} type="text" maxLength={32} placeholder={t.name} aria-label={t.name} value={name} onChange={(e) => { setName(e.target.value); setError(''); }} />
        <Button type="submit" disabled={!name.trim()}>{t.changeName}</Button>
      </div>
      {error && <p className="field-err" role="alert">{error}</p>}
    </form>
  );
}
