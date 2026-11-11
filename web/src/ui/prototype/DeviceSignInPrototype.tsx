// Three throwaway sign-in layouts on the existing entrance, selected with ?variant=A|B|C.
import { useEffect, useRef, useState } from 'react';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import { Orb } from '../Orb';
import { PrototypeSwitcher } from '../PrototypeSwitcher';
import './device-sign-in-prototype.css';

const variants = [
  { key: 'A', name: 'Quiet entrance' },
  { key: 'B', name: 'Open handoff' },
  { key: 'C', name: 'Guided steps' },
] as const;
const scenes = {
  welcome: 'Choose a sign-in method',
  settings: 'Signed-in device: Account settings',
  scanner: 'Signed-in device: scan a QR code',
  qr: 'New browser: waiting for a scan',
  link: 'New browser: open a sign-in link',
  code: 'New browser: show the code',
  issue: 'Signed-in device: create a link',
  approve: 'Signed-in device: approve a QR',
  signedOut: 'QR opened while signed out',
  success: 'Sign-in complete',
  approved: 'Signed-in device: approval sent',
  expired: 'Five-minute deadline reached',
  cancelled: 'Request cancelled or replaced',
  locked: 'Link closed after five wrong codes',
  denied: 'Request declined',
  passkey: 'Passkey handoff',
  recover: 'Recovery handoff',
} as const;
type Scene = keyof typeof scenes;
type Method = 'qr' | 'link';
type Model = ReturnType<typeof usePrototype>;
const code = '0428';

function DeviceGlyph({ kind, className = '' }: { kind: 'phone' | 'laptop' | 'key' | 'link' | 'scan'; className?: string }) {
  return <svg className={`i ${className}`} viewBox="0 0 24 24" aria-hidden="true">
    {kind === 'phone' ? <><rect x="6" y="2.5" width="12" height="19" rx="3.5" /><path d="M10 18h4" /></>
      : kind === 'laptop' ? <><rect x="4" y="4" width="16" height="12" rx="2.5" /><path d="m4 16-2 4h20l-2-4M9 20h6" /></>
        : kind === 'key' ? <><circle cx="8" cy="9" r="4" /><path d="m11 12 9 9m-5-5 3-3m0 6 3-3" /></>
          : kind === 'scan' ? <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M3 12h18" /><path d="M8 7h2v2H8zM14 7h2v2h-2zM8 15h2v2H8zM14 15h2v2h-2z" /></>
          : <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.92)" /></>}
  </svg>;
}

function usePrototype() {
  const params = new URLSearchParams(location.search);
  const initialScene = params.get('scene');
  const [variant, setVariant] = useState(variants.some(item => item.key === params.get('variant')) ? params.get('variant')! : 'A');
  const [scene, setScene] = useState<Scene>(initialScene && initialScene in scenes ? initialScene as Scene : 'welcome');
  const [method, setMethod] = useState<Method>(params.get('method') === 'link' || initialScene === 'code' || initialScene === 'issue' ? 'link' : 'qr');
  const [deadline, setDeadline] = useState(() => Date.now() + 300_000);
  const [now, setNow] = useState(Date.now());
  const [created, setCreated] = useState(initialScene === 'issue');
  const [pending, setPending] = useState(false);
  const [attempts, setAttempts] = useState(5);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [controls, setControls] = useState(false);
  const [camera, setCamera] = useState<'permission' | 'scanning' | 'denied'>('permission');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  const originalTheme = useRef(document.documentElement.dataset.theme);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const active = scene === 'qr' || scene === 'code' || (scene === 'issue' && created) || scene === 'approve' || (scene === 'welcome' && variant === 'B');
  const waiting = scene === 'qr' || scene === 'code';
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const go = (next: Scene, nextMethod: Method = method) => {
    setScene(next); setMethod(nextMethod); setError(''); setNotice(''); setInput('');
  };
  const start = (next: Scene, nextMethod: Method = ['code', 'issue', 'link'].includes(next) ? 'link' : ['qr', 'approve'].includes(next) ? 'qr' : method) => {
    setDeadline(Date.now() + 300_000); setNow(Date.now()); setAttempts(5); setCreated(false); setPending(false); setCamera('permission'); go(next, nextMethod);
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { if (active && seconds === 0) go('expired'); }, [active, seconds]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('variant', variant); url.searchParams.set('scene', scene); url.searchParams.set('method', method);
    history.replaceState(null, '', url);
    console.info('[Device sign-in prototype]', { variant, scene, method, camera, deadline: new Date(deadline).toISOString(), created, pending, attempts, code, simulated: true });
  }, [variant, scene, method, camera, deadline, created, pending, attempts]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => { document.documentElement.dataset.theme = originalTheme.current; };
  }, [theme]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [scene]);
  const copy = async () => {
    await navigator.clipboard.writeText(`${location.origin}/?prototype=device-sign-in&variant=${variant}&scene=code&method=link`);
    setNotice('Sign-in link copied');
  };
  return { variant, setVariant, scene, method, deadline, seconds, time, created, setCreated, pending, setPending, attempts, setAttempts,
    input, setInput, error, setError, notice, setNotice, controls, setControls, camera, setCamera, theme, setTheme, go, start, waiting, heading, copy };
}

function Heading({ model, title, children }: { model: Model; title: string; children?: React.ReactNode }) {
  return <div className="dsp-heading"><h1 ref={model.heading} tabIndex={-1}>{title}</h1>{children && <p>{children}</p>}</div>;
}

function MethodTabs({ model }: { model: Model }) {
  return <div className="seg dsp-methods" role="group" aria-label="Sign in with another device">
    <button aria-pressed={model.method === 'qr'} onClick={() => { if (model.method !== 'qr') model.start('qr', 'qr'); }}>Scan a QR code</button>
    <button aria-pressed={model.method === 'link'} onClick={() => model.go('link', 'link')}>Use a link</button>
  </div>;
}

function Qr({ model }: { model: Model }) {
  return <>
    <div className="dsp-qr"><img src={new URL('./approval-fixture.svg', import.meta.url).href} width="216" height="216" alt="Prototype QR code opening the local approval preview" /></div>
    <div className="dsp-wait" role="status"><span />Waiting for approval<time aria-label={`${model.time} remaining`}>{model.time}</time></div>
  </>;
}

function Choice({ kind, title, children, onClick }: { kind: 'phone' | 'key' | 'link'; title: string; children: React.ReactNode; onClick(): void }) {
  return <button className="dsp-choice" onClick={onClick}><span className="dsp-choice-icon"><DeviceGlyph kind={kind} /></span><span><strong>{title}</strong><small>{children}</small></span><Icon name="right" /></button>;
}

function Success({ model }: { model: Model }) {
  return <>
    <div className="dsp-result-icon"><Icon name="check" /></div>
    <Heading model={model} title="You’re signed in.">This browser can now join your rooms as Alex.</Heading>
    <div className="dsp-identity"><Orb seed="alex" palette="sky" still /><span>Alex<small>Chrome on macOS</small></span><Icon name="check" /></div>
    <Button variant="primary" onClick={() => model.setNotice('End of prototype. In Falky, this opens your rooms.')}>Go to my rooms</Button>
    <p className="dsp-note">Changing passkeys or your recovery phrase will ask for a passkey on this browser.</p>
  </>;
}

function Issuer({ model, embedded = false }: { model: Model; embedded?: boolean }) {
  return <>
    {!embedded && <><div className="dsp-context"><Orb seed="alex" palette="sky" still /><span>Alex<small>Account settings</small></span></div>
      <Heading model={model} title="Sign in another device">Create a link here, then open it in the browser you want to sign in.</Heading></>}
    {!model.created ? <>
      {!embedded && <div className="dsp-device-pair"><DeviceGlyph kind="phone" /><Icon name="right" /><DeviceGlyph kind="laptop" /></div>}
      <Button variant="primary" onClick={() => { model.start('issue', 'link'); model.setCreated(true); }}>Create sign-in link</Button>
      <p className="dsp-note">The link lasts 5 minutes. Keep this device open to approve the other browser.</p>
    </> : <>
      <div className="dsp-link-preview"><DeviceGlyph kind="link" /><span>falky / sign-in link<small>Expires in {model.time}</small></span><Button onClick={() => void model.copy().catch(() => model.setNotice('Select the link in the preview controls to copy it.'))}>Copy link</Button></div>
      {model.pending ? <form className="dsp-code-form" onSubmit={event => {
        event.preventDefault();
        if (model.input !== code) {
          const left = model.attempts - 1; model.setAttempts(left);
          if (!left) model.go('locked');
          else model.setError(`That code doesn’t match. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
          return;
        }
        model.go('approved');
      }}>
        <div className="dsp-request"><DeviceGlyph kind="laptop" /><span>A browser is waiting<small>Chrome on macOS</small></span></div>
        <label htmlFor="dsp-code">Enter the code shown on that browser</label>
        <input id="dsp-code" className="dsp-code-input" inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]{4}" placeholder="0000" value={model.input} aria-invalid={!!model.error} aria-describedby={model.error ? 'dsp-error' : undefined} onChange={event => { model.setInput(event.target.value.replace(/\D/g, '')); model.setError(''); }} />
        <p className="dsp-note">Approve only a browser you’re signing in to.</p>
        <Button variant="primary" type="submit" disabled={model.input.length !== 4}>Approve sign-in</Button>
        <button type="button" className="dsp-text" onClick={() => model.go('denied')}>Decline request</button>
      </form> : <p className="dsp-note dsp-spaced">When the other browser opens your link, enter its four-digit code here.</p>}
      <button className="dsp-text" onClick={() => { if (embedded) model.start('settings', 'link'); else model.go('cancelled'); }}>Revoke sign-in link</button>
    </>}
  </>;
}

function AccountSettingsPreview({ model }: { model: Model }) {
  return <main className="dsp-settings-window">
    <header className="settings-head"><h1 ref={model.heading} tabIndex={-1}>Settings</h1><IconButton aria-label="Close settings" onClick={() => model.go('welcome')}><Icon name="x" /></IconButton></header>
    <nav className="tabs dsp-settings-tabs" aria-label="Settings sections"><span>Audio &amp; video</span><span>Profile</span><span aria-current="page">Account</span><span>System</span></nav>
    <div className="settings-panel">
      <div className="account-panel">
        <section className="dsp-settings-identity"><Orb seed="alex" palette="sky" still /><div><h2>Alex</h2><p className="set-note">You’re signed in on this device.</p></div></section>
        <section>
          <h3>Sign in another device</h3>
          <p className="set-note">Open Falky on your new device and choose “Use another device”. Then scan its QR code here, or create a sign-in link.</p>
          <div className="account-actions dsp-settings-actions">
            <Button variant="primary" onClick={() => model.start('scanner', 'qr')}><DeviceGlyph kind="scan" />Scan QR code</Button>
            {!(model.scene === 'issue' && model.created) && <Button onClick={() => { model.start('issue', 'link'); model.setCreated(true); }}><DeviceGlyph kind="link" />Create sign-in link</Button>}
          </div>
          {model.scene === 'issue' && model.created && <div className="dsp-settings-link"><Issuer model={model} embedded /></div>}
        </section>
        <section><h3>Passkeys</h3><p className="set-note">Use a passkey to sign in or change your account security.</p><div className="account-key"><div className="dsp-settings-passkey"><DeviceGlyph kind="key" /><div><strong>Your passkey</strong><p className="set-note">Available on this device</p></div></div></div></section>
        <section><h3>Recovery phrase</h3><p className="set-note">Keep your twelve-word recovery phrase somewhere safe.</p></section>
      </div>
    </div>
  </main>;
}

function Scanner({ model }: { model: Model }) {
  return <main className="dsp-scanner-fullscreen">
    <header className="dsp-scanner-header"><button className="dsp-text dsp-scanner-back" onClick={() => model.go('settings')}><Icon name="left" />Account settings</button><span>Signed in as Alex</span></header>
    <div className="dsp-scanner-content">
      <Heading model={model} title={model.camera === 'denied' ? 'Camera access is off' : 'Scan a QR code'}>{model.camera === 'denied' ? 'Allow camera access in your browser settings, then try again.' : 'Point your camera at the QR code on the browser you want to sign in.'}</Heading>
      <div className={`dsp-camera-preview dsp-camera-${model.camera}`} aria-label="Simulated camera preview">
        <div className="dsp-scan-frame"><span /><span /><span /><span /><Icon name="camera" /></div>
        <p role="status">{model.camera === 'scanning' ? 'Looking for a Falky QR code…' : model.camera === 'denied' ? 'Camera unavailable' : 'Your camera preview will appear here'}</p>
      </div>
      <div className="dsp-scanner-actions">
        {model.camera === 'scanning' ? <p className="dsp-note">Review the browser before approving sign-in.</p> : <Button variant="primary" onClick={() => model.setCamera(model.camera === 'denied' ? 'permission' : 'scanning')}>{model.camera === 'denied' ? 'Try again' : 'Enable camera'}</Button>}
        <button className="dsp-text" onClick={() => { model.start('issue', 'link'); model.setCreated(true); }}>Create a sign-in link instead</button>
        <p className="dsp-note dsp-simulation-note">Simulated camera preview</p>
      </div>
    </div>
  </main>;
}

function Task({ model, embeddedQr = false }: { model: Model; embeddedQr?: boolean }) {
  const scene = embeddedQr && model.scene === 'welcome' ? 'qr' : model.scene;
  if (scene === 'settings') return <AccountSettingsPreview model={model} />;
  if (scene === 'scanner') return <Scanner model={model} />;
  if (scene === 'success') return <Success model={model} />;
  if (scene === 'approved') return <>
    <div className="dsp-result-icon"><Icon name="check" /></div>
    <Heading model={model} title="Browser approved">Chrome on macOS can now finish signing in as Alex. You can return to Falky on this device.</Heading>
    <Button variant="primary" onClick={() => model.go('settings')}>Done</Button>
  </>;
  if (scene === 'issue') return <Issuer model={model} />;
  if (scene === 'welcome') return <>
    <Heading model={model} title="Welcome back">Pick up the conversation.</Heading>
    <div className="dsp-choices">
      <Button variant="primary" onClick={() => model.go('passkey')}><DeviceGlyph kind="key" />Sign in with a passkey</Button>
      <Choice kind="phone" title="Use another device" onClick={() => model.start('qr', 'qr')}>Approve from a device already signed in</Choice>
    </div>
    <button className="dsp-text" onClick={() => model.go('recover')}>Recover your account</button>
    <p className="dsp-note dsp-invitation">New to Falky? Ask for an invitation.</p>
  </>;
  if (scene === 'qr') return <>
    {!embeddedQr && <Heading model={model} title="Bring this browser along">Use a device where you’re already signed in to Falky.</Heading>}
    <MethodTabs model={model} />
    <Qr model={model} />
    <p className="dsp-qr-instructions">On your signed-in device, open Settings, then Account, and choose “Scan QR code”. You can also use your phone’s camera.</p>
    <button className="dsp-text" onClick={() => model.go('cancelled')}>Cancel sign-in</button>
  </>;
  if (scene === 'link') return <>
    <Heading model={model} title="Use a sign-in link">On your signed-in device, open Settings, then Account, and choose “Sign in another device”.</Heading>
    <MethodTabs model={model} />
    <form className="dsp-link-form" onSubmit={event => { event.preventDefault(); if (model.input.trim()) model.start('code', 'link'); }}>
      <label htmlFor="dsp-link">Open that link here, or paste it below</label>
      <input id="dsp-link" type="url" placeholder="Paste your sign-in link" value={model.input} onChange={event => model.setInput(event.target.value)} required />
      <Button variant="primary" type="submit" disabled={!model.input.trim()}>Continue with link</Button>
    </form>
    <p className="dsp-note">You’ll get a code to enter on your signed-in device.</p>
  </>;
  if (scene === 'code') return <>
    <Heading model={model} title="One more thing on your other device">Enter this code in the device that created your sign-in link.</Heading>
    <div className="dsp-code" aria-label={`Sign-in code: ${code.split('').join(' ')}`}>{code.split('').map((digit, index) => <span key={index} aria-hidden="true">{digit}</span>)}</div>
    <div className="dsp-wait" role="status"><span />Waiting for approval<time>{model.time}</time></div>
    <p className="dsp-note dsp-spaced">Leave this tab open. You’ll be signed in as soon as the other device approves.</p>
    <button className="dsp-text" onClick={() => model.setNotice('Request sent again. The original expiry stays the same.')}>Send request again</button>
    <button className="dsp-text" onClick={() => model.go('cancelled')}>Cancel sign-in</button>
  </>;
  if (scene === 'approve') return <>
    <div className="dsp-context"><Orb seed="alex" palette="sky" still /><span>Signed in as Alex</span></div>
    <Heading model={model} title="Sign in this browser?">You’re giving another browser access to your Falky account.</Heading>
    <div className="dsp-request dsp-approval-device"><DeviceGlyph kind="laptop" /><span>Chrome on macOS<small>Requested just now</small></span></div>
    <p className="dsp-approval-note">Only approve if you started this sign-in. A QR code can be forwarded by someone else.</p>
    <Button variant="primary" onClick={() => model.go('approved')}>Approve sign-in as Alex</Button>
    <button className="dsp-text" onClick={() => model.go('denied')}>Decline request</button>
  </>;
  if (scene === 'signedOut') return <>
    <Heading model={model} title="Use a signed-in device">This browser isn’t signed in. Open the QR code on a device where you already use Falky.</Heading>
    <Button variant="primary" onClick={() => model.go('passkey')}>Sign in with a passkey</Button>
    <button className="dsp-text" onClick={() => model.go('welcome')}>Choose another way</button>
  </>;
  if (scene === 'passkey' || scene === 'recover') return <>
    <Heading model={model} title={scene === 'passkey' ? 'Use your passkey' : 'Recover your account'}>{scene === 'passkey' ? 'Your browser will ask you to unlock your passkey.' : 'The existing recovery flow uses your account ID and twelve-word recovery phrase.'}</Heading>
    <div className="dsp-device-pair"><DeviceGlyph kind="key" /></div>
    <Button variant="primary" onClick={() => model.go('success')}>{scene === 'passkey' ? 'Simulate passkey sign-in' : 'Simulate account recovery'}</Button>
    <p className="dsp-note">Prototype handoff to the existing Falky flow.</p>
  </>;
  const terminal = {
    expired: ['This sign-in has expired', 'Requests last 5 minutes. Start a new request to try again.'],
    cancelled: ['This sign-in was cancelled', 'The request was cancelled or replaced. This browser hasn’t been signed in.'],
    locked: ['This sign-in link is closed', 'Five incorrect codes were entered. Create a new link on your signed-in device.'],
    denied: ['Sign-in wasn’t approved', 'This browser hasn’t been given access to your account.'],
  }[scene];
  return <>
    <div className="dsp-terminal-icon"><Icon name={scene === 'expired' ? 'retry' : 'x'} /></div>
    <Heading model={model} title={terminal[0]!}>{terminal[1]}</Heading>
    <Button variant="primary" onClick={() => model.start(scene === 'locked' ? 'issue' : model.method === 'qr' ? 'qr' : 'link')}>{scene === 'locked' ? 'Create a new sign-in link' : 'Start a new sign-in'}</Button>
    <button className="dsp-text" onClick={() => model.go('welcome')}>Back to sign-in</button>
  </>;
}

export function VariantA({ model }: { model: Model }) {
  return <main className="dsp-quiet">
    <div className="dsp-entrance-orb"><Orb seed="entry" palette="sky" still /></div>
    <section className="dsp-task"><Task model={model} /></section>
  </main>;
}

export function VariantB({ model }: { model: Model }) {
  const atEntrance = model.scene === 'welcome' || model.scene === 'qr' || model.scene === 'link';
  return <main className="dsp-open">
    <section className="dsp-intro">
      <div className="dsp-handoff-orb"><Orb seed="entry" palette="sky" still /><span><DeviceGlyph kind="laptop" /></span></div>
      <h2>{atEntrance ? <>Your voice.<br />Another device.</> : <>A familiar place.<br />A new way in.</>}</h2>
      <p>Bring your Falky account to this browser.<br />Your rooms are right where you left them.</p>
      <Button variant="primary" onClick={() => model.go('passkey')}><DeviceGlyph kind="key" />Sign in with a passkey</Button>
      <button className="dsp-text" onClick={() => model.go('recover')}>Recover your account</button>
    </section>
    <section className="dsp-task dsp-open-task">{model.scene === 'welcome' && <div className="dsp-open-title"><h3>Already signed in on your phone?</h3><p>Let it sign you in here.</p></div>}<Task model={model} embeddedQr={model.scene === 'welcome'} /></section>
  </main>;
}

export function VariantC({ model }: { model: Model }) {
  const stage = model.scene === 'welcome' ? 0 : model.scene === 'success' || model.scene === 'approved' ? 2 : 1;
  return <main className="dsp-guided">
    <aside className="dsp-guide">
      <div className="dsp-guide-orb"><Orb seed="entry" palette="sky" still /></div>
      <h2>A little help<br />getting back in.</h2>
      <ol>{['Choose a method', 'Connect your device', 'Back to your rooms'].map((title, index) => <li key={title} aria-current={stage === index ? 'step' : undefined} data-complete={stage > index}><span>{stage > index ? <Icon name="check" /> : index + 1}</span><div>{title}<small>{['A passkey or a signed-in device', 'You’re always in control', 'The conversation continues'][index]}</small></div></li>)}</ol>
    </aside>
    <section className="dsp-task dsp-guided-task">{model.scene === 'welcome' ? <>
      <Heading model={model} title="How would you like to sign in?">Use a passkey, or let a signed-in device help.</Heading>
      <div className="dsp-choices">
        <Choice kind="key" title="Use a passkey" onClick={() => model.go('passkey')}>Unlock with your fingerprint, face or PIN</Choice>
        <Choice kind="phone" title="Scan with your phone" onClick={() => model.start('qr', 'qr')}>Open a QR code with a signed-in phone</Choice>
        <Choice kind="link" title="Open a sign-in link" onClick={() => model.go('link', 'link')}>Send a link from a device already signed in</Choice>
      </div>
      <button className="dsp-text" onClick={() => model.go('recover')}>I need to recover my account</button>
    </> : <Task model={model} />}</section>
  </main>;
}

export default function DeviceSignInPrototype() {
  const model = usePrototype();
  const accountSide = ['issue', 'approve', 'approved', 'denied'].includes(model.scene);
  const settingsWindow = model.scene === 'settings' || model.scene === 'issue';
  const scanner = model.scene === 'scanner';
  const showBack = !settingsWindow && !scanner && model.scene !== 'welcome' && model.scene !== 'success';
  return <div className={`screen dsp-screen dsp-variant-${model.variant}${scanner ? ' dsp-is-scanning' : ''}`}>
    {!scanner && <header className="dsp-header"><a className="mark" href="?prototype=device-sign-in&variant=A">falky</a><span>Sign-in prototype</span></header>}
    {showBack && <button className="dsp-back" onClick={() => model.go(accountSide ? 'settings' : 'welcome')}><Icon name="left" />{accountSide ? 'Account settings' : 'All sign-in options'}</button>}
    {scanner ? <Scanner model={model} /> : settingsWindow ? <AccountSettingsPreview model={model} /> : model.variant === 'A' ? <VariantA model={model} /> : model.variant === 'B' ? <VariantB model={model} /> : <VariantC model={model} />}
    <div className="dsp-feedback" aria-live="polite">{model.error && <p className="auth-error" role="alert" id="dsp-error">{model.error}</p>}{model.notice && <p role="status">{model.notice}</p>}</div>
    {model.controls && <aside id="dsp-preview-panel" className="dsp-controls" aria-label="Prototype preview controls">
      <div className="dsp-control-title"><strong>Preview controls</strong><button aria-label="Close preview controls" onClick={() => model.setControls(false)}><Icon name="x" /></button></div>
      <p>Simulated sign-in. No account changes.</p>
      <label>Screen<select value={model.scene} onChange={event => model.start(event.target.value as Scene)}>{Object.entries(scenes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <div className="dsp-control-actions">
        {model.waiting && <Button onClick={() => model.go('success')}>Simulate approval</Button>}
        {model.scene === 'code' && <Button onClick={() => { model.go('issue', 'link'); model.setCreated(true); model.setPending(true); }}>View issuing device</Button>}
        <Button onClick={() => { model.go('settings'); model.setControls(false); }}>View signed-in Account settings</Button>
        {(model.scene === 'qr' || model.scene === 'welcome' && model.variant === 'B') && <Button onClick={() => { model.go('settings', 'qr'); model.setControls(false); }}>View scanning device</Button>}
        {model.scene === 'scanner' && <><Button onClick={() => { model.go('approve', 'qr'); model.setControls(false); }}>Simulate QR found</Button><Button onClick={() => { model.setCamera('denied'); model.setControls(false); }}>Simulate camera blocked</Button></>}
        {model.scene === 'issue' && model.created && <><Button onClick={() => model.setPending(true)}>Simulate link opened</Button><Button onClick={() => model.go('code', 'link')}>View requesting browser</Button></>}
        <Button onClick={() => model.setTheme(model.theme === 'dark' ? 'light' : 'dark')}>{model.theme === 'dark' ? 'Light appearance' : 'Dark appearance'}</Button>
        <Button onClick={() => model.go('expired')}>Expire request</Button>
      </div>
      <dl><dt>Variant / scene</dt><dd>{model.variant} / {model.scene}</dd><dt>Method / code</dt><dd>{model.method} / {model.method === 'link' ? code : 'none'}</dd><dt>Original deadline</dt><dd>{new Date(model.deadline).toLocaleTimeString()}</dd><dt>Code attempts remaining</dt><dd>{model.attempts}</dd><dt>Link / request</dt><dd>{model.created ? 'created' : 'not created'} / {model.pending ? 'pending' : 'none'}</dd><dt>Camera preview</dt><dd>{model.camera}</dd></dl>
    </aside>}
    <PrototypeSwitcher variants={variants} current={model.variant} onChange={model.setVariant}>
      <button className="dsp-preview-button" aria-label="Preview controls" aria-expanded={model.controls} aria-controls="dsp-preview-panel" onClick={() => model.setControls(!model.controls)}><Icon name="sliders" /><span>Preview controls</span></button>
    </PrototypeSwitcher>
  </div>;
}
