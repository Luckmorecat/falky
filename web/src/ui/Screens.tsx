import { useEffect, useRef, useState } from 'react';
import { enter, rename } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Orb } from './Orb';

/** Typing wakes the entry orb, as a voice would. */
export function Entry() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pulse = useRef(0);
  const last = useRef(performance.now());
  const level = useRef(() => {
    const now = performance.now();
    pulse.current = Math.max(0, pulse.current - ((now - last.current) / 1000) * 1.6);
    last.current = now;
    return pulse.current > 0 ? 0.16 + pulse.current * 0.84 : 0.05;
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const reason = await enter(n);
    setBusy(false);
    setError(reason ?? '');
  };

  return (
    <div className="screen center">
      <form className="enter" onSubmit={(e) => void submit(e)} noValidate>
        <Orb seed="entry" palette="sky" level={level.current} />
        <h1>{t.enterTitle}</h1>
        <p>{t.enterHint}</p>
        <input
          autoFocus
          maxLength={32}
          autoComplete="off"
          placeholder={t.name}
          aria-label={t.name}
          aria-describedby="enter-err"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
            pulse.current = Math.min(1, pulse.current + 0.7);
          }}
        />
        <button className="go" disabled={!name.trim() || busy}>{t.enter}</button>
        <p className="enter-err" id="enter-err" role="alert">{error}</p>
      </form>
    </div>
  );
}

export function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="screen center">
      <div className="message-screen">
        <Orb seed="message" palette="sky" />
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
    </div>
  );
}

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
        <button className="btn2" disabled={!name.trim()}>{t.changeName}</button>
      </div>
      {error && <p className="field-err" role="alert">{error}</p>}
    </form>
  );
}
