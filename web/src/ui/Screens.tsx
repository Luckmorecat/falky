import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { goTo, passAccess, recoverAccount, register, rename, signIn, type AuthProblem } from '../app/controller';
import { useApp } from '../app/store';
import { t } from '../strings';
import { Button } from './Button';
import { Icon } from './Icon';
import { Orb } from './Orb';

/** An orb level that typing wakes, as a voice would. Call `poke` on every keystroke. */
function useTypingOrb() {
  const pulse = useRef(0);
  const last = useRef(performance.now());
  const level = useRef(() => {
    const now = performance.now();
    pulse.current = Math.max(0, pulse.current - ((now - last.current) / 1000) * 1.6);
    last.current = now;
    return pulse.current > 0 ? 0.16 + pulse.current * 0.84 : 0.05;
  });
  return { level: level.current, poke: () => { pulse.current = Math.min(1, pulse.current + 0.7); } };
}

type FieldProps = Omit<ComponentProps<'input'>, 'onChange'> & {
  label: string;
  hint?: string;
  error?: string;
  onValue(value: string): void;
};

/** A labelled input with its hint, replaced by its error when there is one. */
function Field({ label, hint, error, onValue, type = 'text', ...input }: FieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const secret = type === 'password';
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <span className="field-box">
        <input
          id={id}
          type={secret && shown ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          onChange={(e) => onValue(e.target.value)}
          {...input}
        />
        {secret && (
          <button type="button" className="field-eye" aria-label={shown ? t.auth.hide : t.auth.show} aria-pressed={shown} onClick={() => setShown(!shown)}>
            <Icon name={shown ? 'eyeOff' : 'eye'} />
          </button>
        )}
      </span>
      {error ? <span className="field-err" id={`${id}-note`} role="alert">{error}</span>
        : hint ? <span className="field-hint" id={`${id}-note`}>{hint}</span> : null}
    </div>
  );
}

/** The frame every step on the way in shares: the orb, a title, a line of help, the form and ways elsewhere. */
function AuthForm({ title, hint, notice, error, busy, submit, canSubmit, onSubmit, footer, level, children }: {
  title: string;
  hint: ReactNode;
  notice?: string | null;
  error?: string;
  busy: boolean;
  submit: string;
  canSubmit: boolean;
  onSubmit(): void;
  footer?: ReactNode;
  level?: () => number;
  children: ReactNode;
}) {
  return (
    <div className="screen center">
      <form className="enter auth" noValidate onSubmit={(e) => { e.preventDefault(); if (canSubmit && !busy) onSubmit(); }}>
        <Orb seed="entry" palette="sky" level={level} />
        <h1>{title}</h1>
        <p>{hint}</p>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        <div className="auth-fields">{children}</div>
        <Button variant="primary" type="submit" disabled={!canSubmit || busy} aria-busy={busy || undefined}>{submit}</Button>
        <p className="enter-err" role="alert">{error}</p>
        {footer && <div className="auth-links">{footer}</div>}
      </form>
    </div>
  );
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <button type="button" className="link" onClick={onClick}>{children}</button>;
}

/** Runs a step's request, keeping its problem for the form; the field it names gets the message. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<AuthProblem | null>(null);
  const run = async (request: () => Promise<AuthProblem | null>) => {
    setBusy(true);
    setProblem(null);
    const result = await request();
    setBusy(false);
    setProblem(result);
  };
  const fieldError = (field: AuthProblem['field']) => (problem && problem.field === field ? problem.message : undefined);
  return { busy, run, fieldError, formError: problem && !problem.field ? problem.message : '', clear: () => setProblem(null) };
}

function AccessStep() {
  const [password, setPassword] = useState('');
  const orb = useTypingOrb();
  const form = useSubmit();
  return (
    <AuthForm
      title={t.auth.accessTitle}
      hint={t.auth.accessHint}
      busy={form.busy}
      submit={t.auth.next}
      canSubmit={!!password}
      level={orb.level}
      error={form.formError}
      onSubmit={() => void form.run(() => passAccess(password))}
    >
      <Field label={t.auth.accessPassword} type="password" autoComplete="off" autoFocus value={password} error={form.fieldError('password')}
        onValue={(v) => { setPassword(v); form.clear(); orb.poke(); }} />
    </AuthForm>
  );
}

function SignInStep() {
  const reason = useApp((s) => s.auth.reason);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const orb = useTypingOrb();
  const form = useSubmit();
  return (
    <AuthForm
      title={t.auth.signinTitle}
      hint={t.auth.signinHint}
      notice={reason === 'signedOut' ? t.auth.signedOut : reason === 'ended' ? t.auth.ended : null}
      busy={form.busy}
      submit={t.auth.signIn}
      canSubmit={!!login.trim() && !!password}
      level={orb.level}
      error={form.formError || form.fieldError('password') || form.fieldError('login')}
      onSubmit={() => void form.run(() => signIn(login.trim(), password))}
      footer={<>
        <span>{t.auth.noAccount} <LinkButton onClick={() => goTo('register')}>{t.auth.createAccount}</LinkButton></span>
        <LinkButton onClick={() => goTo('recover')}>{t.auth.forgot}</LinkButton>
      </>}
    >
      <Field label={t.auth.login} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={login}
        onValue={(v) => { setLogin(v); form.clear(); orb.poke(); }} />
      <Field label={t.auth.password} type="password" name="password" autoComplete="current-password" value={password}
        onValue={(v) => { setPassword(v); form.clear(); orb.poke(); }} />
    </AuthForm>
  );
}

/** Suggests a login from a name, while the person has not typed one of their own. */
function loginFrom(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32);
}

function RegisterStep() {
  const guestName = useApp((s) => s.auth.guestName);
  const [name, setName] = useState(guestName ?? '');
  const [login, setLogin] = useState(loginFrom(guestName ?? ''));
  const [loginTouched, setLoginTouched] = useState(false);
  const [password, setPassword] = useState('');
  const orb = useTypingOrb();
  const form = useSubmit();
  return (
    <AuthForm
      title={guestName ? t.auth.guestTitle : t.auth.registerTitle}
      hint={guestName ? t.auth.guestHint(guestName) : t.auth.registerHint}
      busy={form.busy}
      submit={t.auth.register}
      canSubmit={!!name.trim() && !!login.trim() && !!password}
      level={orb.level}
      error={form.formError}
      onSubmit={() => void form.run(() => register(login.trim(), password, name.trim()))}
      footer={guestName ? null : <span>{t.auth.haveAccount} <LinkButton onClick={() => goTo('signin')}>{t.auth.signIn}</LinkButton></span>}
    >
      <Field label={t.name} autoComplete="nickname" maxLength={32} autoFocus value={name} error={form.fieldError('name')}
        onValue={(v) => { setName(v); if (!loginTouched) setLogin(loginFrom(v)); form.clear(); orb.poke(); }} />
      <Field label={t.auth.login} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} value={login}
        hint={t.auth.loginHint} error={form.fieldError('login')}
        onValue={(v) => { setLogin(v); setLoginTouched(true); form.clear(); orb.poke(); }} />
      <Field label={t.auth.password} type="password" name="password" autoComplete="new-password" value={password}
        hint={t.auth.passwordHint} error={form.fieldError('password')}
        onValue={(v) => { setPassword(v); form.clear(); orb.poke(); }} />
    </AuthForm>
  );
}

function RecoverStep() {
  const recovery = useApp((s) => s.auth.recovery);
  const [account, setAccount] = useState(recovery?.account ?? '');
  const [proof, setProof] = useState(recovery?.code ?? '');
  const [password, setPassword] = useState('');
  const [newLogin, setNewLogin] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const orb = useTypingOrb();
  const form = useSubmit();
  const fromLink = !!recovery;
  const submit = () => void form.run(async () => {
    const problem = await recoverAccount(account.trim(), proof, password, needsLogin ? newLogin.trim() : undefined);
    if (problem?.field === 'login' && !needsLogin) setNeedsLogin(true);
    return problem;
  });
  return (
    <AuthForm
      title={t.auth.recoverTitle}
      hint={fromLink ? t.auth.recoverFromLink : t.auth.recoverHint}
      busy={form.busy}
      submit={t.auth.setPassword}
      canSubmit={!!account.trim() && !!proof.trim() && !!password && (!needsLogin || !!newLogin.trim())}
      level={orb.level}
      error={form.formError}
      onSubmit={submit}
      footer={<span>{t.auth.remembered} <LinkButton onClick={() => goTo('signin')}>{t.auth.signIn}</LinkButton></span>}
    >
      {!fromLink && <>
        <Field label={t.auth.login} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={account}
          onValue={(v) => { setAccount(v); form.clear(); orb.poke(); }} />
        <Field label={t.auth.code} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} value={proof} error={form.fieldError('proof')}
          onValue={(v) => { setProof(v); form.clear(); orb.poke(); }} />
      </>}
      {fromLink && form.fieldError('proof') && <p className="field-err" role="alert">{form.fieldError('proof')}</p>}
      {needsLogin && (
        <Field label={t.auth.newLogin} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} autoFocus value={newLogin}
          hint={t.auth.newLoginHint} error={form.fieldError('login')}
          onValue={(v) => { setNewLogin(v); form.clear(); orb.poke(); }} />
      )}
      <Field label={t.auth.newPassword} type="password" name="password" autoComplete="new-password" autoFocus={fromLink && !needsLogin} value={password}
        hint={t.auth.passwordHint} error={form.fieldError('password')}
        onValue={(v) => { setPassword(v); form.clear(); orb.poke(); }} />
    </AuthForm>
  );
}

/** The way in: the access password, then signing in, registering or recovering. */
export function Auth() {
  const step = useApp((s) => s.auth.step);
  // A recovery link opened in this tab starts a fresh form, with its own focus.
  const recoveryCode = useApp((s) => s.auth.recovery?.code ?? '');
  switch (step) {
    case 'access': return <AccessStep key={step} />;
    case 'signin': return <SignInStep key={step} />;
    case 'register': return <RegisterStep key={step} />;
    case 'recover': return <RecoverStep key={`${step}:${recoveryCode}`} />;
  }
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
        <Button type="submit" disabled={!name.trim()}>{t.changeName}</Button>
      </div>
      {error && <p className="field-err" role="alert">{error}</p>}
    </form>
  );
}
