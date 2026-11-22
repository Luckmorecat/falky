import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { enableNotifications, rename, setVisitorColour, updateSettings, voice } from '../app/controller';
import type { Settings as SettingsValues } from '../app/prefs';
import { shortcuts, shortcutsRevision, subscribeShortcuts } from '../app/shortcuts';
import { useApp } from '../app/store';
import { PALETTE_NAMES, paletteStyle, type PaletteName } from '../fx/palette';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import type { MicTest } from '../voice/meter';
import { canChooseSpeaker, enumerateDevices, watchDevices, refreshDevices, startMicTest, playSound, notificationsAvailable } from '@falky/browser';
import { canUseCamera } from '../voice/camera';
import { canShareScreen, SHARE_BITRATE_MAX, SHARE_BITRATE_PRESETS, shareBitrate, supportedShareCodecs, type ShareCodec } from '../voice/share';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';
import { Orb } from './Orb';
import { Segmented } from './Segmented';
import { Toggle } from './Toggle';
import { AccountPanel } from './AccountPanel';
import { useAccountUI } from './AccountFlow';
import { useMediaQuery } from './useMediaQuery';
import { AvatarStage, CameraPreview, KeyBinding, MotionStage, PlaySample, SettingsGroup, ThemePicker } from './SettingsParts';
import './Range.css';
import './Forms.css';
import './Settings.css';

function useDevices(kind: MediaDeviceKind, active: boolean): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    const load = () => void enumerateDevices().then((all) => setDevices(all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')));
    load();
    return watchDevices(load);
  }, [kind, active]);
  return devices;
}

const codecLabels: Record<ShareCodec, string> = { vp8: 'VP8', h264: 'H.264', h265: 'H.265' };

/** Each language by its own name, so a person finds theirs whatever the interface is in now. */
const LANGUAGES: readonly (readonly [SettingsValues['language'], () => string])[] = [['system', () => t.languageSystem], ['uk', () => 'Українська'], ['en', () => 'English'], ['pl', () => 'Polski'], ['de', () => 'Deutsch'], ['es', () => 'Español'], ['fr', () => 'Français']];

type Flag = { [K in keyof SettingsValues]: SettingsValues[K] extends boolean ? K : never }[keyof SettingsValues];

function SettingToggle({ flag, label }: { flag: Flag; label: ReactNode }) {
  const on = useApp((s) => s.settings[flag]);
  return <Toggle label={label} checked={on} data-cue-always={flag === 'uiSounds' ? '' : undefined} onChange={(checked) => updateSettings({ [flag]: checked })} />;
}

/** How loud the microphone is: in voice, what goes out; otherwise a test on request. */
function MicLevel({ open }: { open: boolean }) {
  const settings = useApp((s) => s.settings);
  const selfId = useApp((s) => s.voice.people.find((p) => p.local)?.id);
  const inVoice = useApp((s) => s.voice.status === 'connected');
  const muted = useApp((s) => s.voice.muted);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const test = useRef<MicTest | null>(null);
  const fill = useRef<HTMLDivElement>(null);
  const { micId, echoCancellation, noiseSuppression, autoGain } = settings;

  useEffect(() => {
    if (!open || inVoice) setTesting(false);
  }, [open, inVoice]);

  useEffect(() => {
    if (!testing) return;
    let cancelled = false;
    setError('');
    startMicTest({ deviceId: micId || undefined, echoCancellation, noiseSuppression, autoGainControl: autoGain }).then(
      (started) => {
        if (cancelled) started.stop();
        else {
          test.current = started;
          // Device names appear once the browser has been allowed the microphone.
          refreshDevices();
        }
      },
      (err: Error) => {
        if (cancelled) return;
        setTesting(false);
        setError(err.name === 'NotFoundError' ? t.voiceProblems.mic_missing.title : t.voiceProblems.mic_denied.title);
      },
    );
    return () => {
      cancelled = true;
      test.current?.stop();
      test.current = null;
    };
  }, [testing, micId, echoCancellation, noiseSuppression, autoGain]);

  useEffect(() => {
    if (!open) return;
    let shown = 0;
    return onTick((_time, dt) => {
      const target = inVoice ? (selfId && !muted ? voice.level(selfId) : 0) : (test.current?.level() ?? 0);
      shown += (target - shown) * (1 - Math.exp(-dt * (target > shown ? 30 : 7)));
      if (fill.current) fill.current.style.transform = `scaleX(${shown.toFixed(3)})`;
    });
  }, [open, inVoice, muted, selfId]);

  return (
    <div className="setrow mic-level">
      <span>{t.micLevel}</span>
      <div className="meter" aria-hidden="true"><div ref={fill} /></div>
      {inVoice ? muted && <span className="set-note">{t.micMutedHint}</span> : (
        <Button onClick={() => setTesting(!testing)}>{testing ? t.micTestStop : t.micTest}</Button>
      )}
      {error && <span className="field-err" role="alert">{error}</span>}
    </div>
  );
}

function DeviceSelect({ label, value, devices, onChange }: { label: string; value: string; devices: MediaDeviceInfo[]; onChange(id: string): void }) {
  return (
    <label className="setrow">
      <span className="visually-hidden">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t.systemDefault}</option>
        {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
      </select>
    </label>
  );
}

function VoicePanel({ active }: { active: boolean }) {
  const { micId, awayMute, awayMinutes } = useApp((s) => s.settings);
  const mics = useDevices('audioinput', active);
  return (
    <div className="set-stack">
      <SettingsGroup title={t.mic}>
        <DeviceSelect label={t.mic} value={micId} devices={mics} onChange={(micId) => updateSettings({ micId })} />
        <MicLevel open={active} />
      </SettingsGroup>
      <SettingsGroup title={t.groupProcessing} note={t.processingNote}>
        <SettingToggle flag="noiseSuppression" label={t.noiseSuppression} />
        <SettingToggle flag="echoCancellation" label={t.echoCancellation} />
        <SettingToggle flag="autoGain" label={t.autoGain} />
      </SettingsGroup>
      <SettingsGroup title={t.groupBehaviour}>
        <SettingToggle flag="pushToTalk" label={t.pushToTalk(shortcuts.pushToTalk.label)} />
        <SettingToggle flag="joinMuted" label={t.joinMuted} />
        <SettingToggle flag="awayMute" label={t.awayMute} />
        {awayMute && <Segmented label={t.awayAfter} value={awayMinutes} options={(['5', '10', '30'] as const).map((m) => [m, t.minutes(Number(m))] as const)} onChange={(awayMinutes) => updateSettings({ awayMinutes })} />}
      </SettingsGroup>
    </div>
  );
}

function VideoPanel({ active }: { active: boolean }) {
  const settings = useApp((s) => s.settings);
  const cameras = useDevices('videoinput', active);
  return (
    <div className="set-stack">
      <SettingsGroup title={t.camera} note={t.cameraPreviewHint}>
        <CameraPreview active={active} />
        <DeviceSelect label={t.camera} value={settings.cameraId} devices={cameras} onChange={(cameraId) => updateSettings({ cameraId })} />
        <Segmented label={t.cameraQuality} value={settings.cameraResolution} options={[['360', '360p'], ['720', '720p'], ['1080', '1080p']]} onChange={(cameraResolution) => updateSettings({ cameraResolution })} />
        <SettingToggle flag="cameraMirror" label={t.cameraMirror} />
      </SettingsGroup>
    </div>
  );
}

type SharePreset = 'docs' | 'games' | 'video';
const SHARE_PRESETS: Record<SharePreset, Pick<SettingsValues, 'shareResolution' | 'shareFps' | 'shareFocus'>> = {
  docs: { shareResolution: '1440', shareFps: '15', shareFocus: 'detail' },
  games: { shareResolution: '1080', shareFps: '60', shareFocus: 'motion' },
  video: { shareResolution: '1080', shareFps: '30', shareFocus: 'motion' },
};
const presetOf = (s: SettingsValues): SharePreset | undefined =>
  (Object.keys(SHARE_PRESETS) as SharePreset[]).find((p) => Object.entries(SHARE_PRESETS[p]).every(([k, v]) => s[k as keyof SettingsValues] === v));

function SharePanel() {
  const settings = useApp((s) => s.settings);
  const sharing = useApp((s) => s.voice.sharing);
  const shareCodecs = supportedShareCodecs();
  const shareCodec = shareCodecs.includes(settings.shareCodec) ? settings.shareCodec : 'vp8';
  const preset = presetOf(settings);
  return (
    <div className="set-stack">
      <SettingsGroup title={t.sharePreset} note={sharing ? t.shareNextTime : t.sharePresetHint[preset ?? 'custom']}>
        <div className="setrow">
          <span className="visually-hidden">{t.sharePreset}</span>
          <div className="seg" role="group" aria-label={t.sharePreset}>
            {(Object.keys(SHARE_PRESETS) as SharePreset[]).map((p) => (
              <button key={p} type="button" aria-pressed={preset === p} onClick={() => updateSettings(SHARE_PRESETS[p])}>{t.sharePresets[p]}</button>
            ))}
          </div>
        </div>
        <SettingToggle flag="shareAudio" label={t.shareAudio} />
      </SettingsGroup>
      <details className="set-group set-more" open={!preset || undefined}>
        <summary><h3>{t.shareMore}</h3><Icon name="chevron" /></summary>
        <div className="set-card">
          <Segmented label={t.shareResolution} value={settings.shareResolution} options={[['720', '720p'], ['1080', '1080p'], ['1440', '1440p']]} onChange={(shareResolution) => updateSettings({ shareResolution })} />
          <Segmented label={t.shareFps} value={settings.shareFps} options={[['15', '15'], ['30', '30'], ['60', '60']]} onChange={(shareFps) => updateSettings({ shareFps })} />
          <Segmented label={t.shareFocus} value={settings.shareFocus} options={[['motion', t.shareFocusMotion], ['detail', t.shareFocusDetail]]} onChange={(shareFocus) => updateSettings({ shareFocus })} />
          <Segmented label={t.shareCodec} value={shareCodec} options={shareCodecs.map((codec) => [codec, codecLabels[codec]])} onChange={(shareCodec) => updateSettings({ shareCodec })} />
          <div className="setrow">
            <span className="set-head">
              {t.shareBitrate}
              <b>{Number(settings.shareMbps) ? t.shareBitrateFixed(settings.shareMbps) : t.shareBitrateAuto(String(Math.round(shareBitrate(settings) / 100_000) / 10))}</b>
            </span>
            <div className="seg fit" role="group" aria-label={t.shareBitrate}>
              {SHARE_BITRATE_PRESETS.map((v, i) => <button key={v} type="button" aria-pressed={v === settings.shareMbps} onClick={() => updateSettings({ shareMbps: v })}>{t.shareBitratePresets[i]}</button>)}
            </div>
            <input type="range" style={{ '--at': `${(Number(settings.shareMbps) / SHARE_BITRATE_MAX) * 100}%` } as React.CSSProperties} aria-label={t.shareBitrate} min="0" max={SHARE_BITRATE_MAX} step="1" value={settings.shareMbps} onChange={(e) => updateSettings({ shareMbps: e.target.value })} />
          </div>
        </div>
        <p className="set-foot">{shareCodec === 'h265' ? `${t.shareFocusHint[settings.shareFocus]} ${t.shareCodecFallback}` : t.shareFocusHint[settings.shareFocus]}</p>
      </details>
    </div>
  );
}

function ColorOption({ name }: { name: PaletteName }) {
  const chosen = useApp((s) => s.visitor ? s.colours[s.visitor.id]?.palette === name : false);
  return (
    <label className="color">
      <input type="radio" name="visitor-colour" checked={chosen} readOnly onClick={() => void setVisitorColour(name)} />
      <span className="orb flat" style={paletteStyle(name)} aria-hidden="true" />
      <i aria-hidden="true"><Icon name="check" /></i>
      {t.colorNames[name]}
    </label>
  );
}

function ProfilePanel() {
  const visitor = useApp((s) => s.visitor);
  const ownColour = useApp((s) => s.visitor ? s.colours[s.visitor.id]?.palette : undefined);
  const colourSave = useApp((s) => s.colourSave);
  const [name, setName] = useState(visitor?.name ?? '');
  const [nameError, setNameError] = useState('');
  const selfId = visitor?.id ?? '';

  useEffect(() => setName(visitor?.name ?? ''), [visitor?.name]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === visitor?.name) return;
    setNameError((await rename(n)) ?? '');
  };

  return (
    <div className="profile">
      <div className="profile-card">
        <Orb seed={selfId} palette={ownColour} still />
        <strong>{name.trim() || visitor?.name}</strong>
      </div>
      <div>
        <form className="setrow" onSubmit={(e) => void saveName(e)}>
          <label htmlFor="set-name">{t.name}</label>
          <span className="namerow">
            <input id="set-name" type="text" autoComplete="off" maxLength={32} value={name} onChange={(e) => { setName(e.target.value); setNameError(''); }} />
            <Button type="submit" disabled={!name.trim() || name.trim() === visitor?.name}>{t.save}</Button>
          </span>
          {nameError && <span className="field-err" role="alert">{nameError}</span>}
        </form>
        <fieldset className="colors">
          <legend className="set-head">{t.visitorColour}</legend>
          <div className="color-grid">
            {PALETTE_NAMES.map((name) => <ColorOption key={name} name={name} />)}
          </div>
          <p className="set-note">{t.visitorColourHint}</p>
          {colourSave?.pending && <p className="set-note" role="status">{t.colourSaving}</p>}
          {colourSave?.failed && <div className="colour-error"><span className="field-err" role="alert">{t.colourSaveFailed}</span><Button onClick={() => void setVisitorColour(colourSave.palette)}>{t.retry}</Button></div>}
        </fieldset>
      </div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: ReactNode; label: string }) {
  return (
    <div className="key-row">
      <span>{label}</span>
      <span className="key-edit">{keys}</span>
    </div>
  );
}

function KeysPanel() {
  const pushToTalk = useApp((s) => s.settings.pushToTalk);
  const names = { mute: t.keyMute, deafen: t.keyDeafen, camera: t.keyCamera, pushToTalk: t.keyPushToTalk, leave: t.keyLeave };
  return (
    <div className="set-stack">
      <SettingsGroup title={t.keysInVoice} note={t.keysHint}>
        <KeyBinding name="mute" label={t.keyMute} names={names} />
        <KeyBinding name="deafen" label={t.keyDeafen} names={names} />
        {canUseCamera && <KeyBinding name="camera" label={t.keyCamera} names={names} />}
        {pushToTalk && <KeyBinding name="pushToTalk" label={t.keyPushToTalk} names={names} />}
        <KeyBinding name="leave" label={t.keyLeave} names={names} />
        <Shortcut label={t.keyReact} keys={<kbd>{shortcuts.react.label}</kbd>} />
      </SettingsGroup>
      <SettingsGroup title={t.keysAnywhere}>
        <Shortcut label={t.keyChat} keys={<><kbd>{shortcuts.chat.label}</kbd>{t.keyOr}<kbd>{shortcuts.chatEnter.label}</kbd></>} />
        <Shortcut label={t.keyRooms} keys={<><kbd>{shortcuts.previousRoom.label}</kbd><kbd>{shortcuts.nextRoom.label}</kbd></>} />
        <Shortcut label={t.keyClose} keys={<kbd>{shortcuts.closeRooms.label}</kbd>} />
      </SettingsGroup>
    </div>
  );
}

function GeneralPanel({ active }: { active: boolean }) {
  const settings = useApp((s) => s.settings);
  return (
    <div className="set-stack">
      <SettingsGroup title={t.sectionLook} note={`${t.orbLookPreview} ${t.orbLookHint}`}>
        <ThemePicker />
        <label className="setrow">
          {t.language}
          <select value={settings.language} onChange={(e) => updateSettings({ language: e.target.value as SettingsValues['language'] })}>
            {LANGUAGES.map(([value, name]) => <option key={value} value={value}>{name()}</option>)}
          </select>
        </label>
        <div className="setrow">
          <span>{t.orbLook}</span>
          <AvatarStage />
          <div className="seg" role="group" aria-label={t.orbLook}>
            {([['flat', t.orbLookFlat], ['volume', t.orbLookVolume]] as const).map(([v, label]) => <button key={v} type="button" aria-pressed={settings.orbLight === v} onClick={() => updateSettings({ orbLight: v })}>{label}</button>)}
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup title={t.groupMotion} note={t.liveBackgroundHint}>
        <MotionStage active={active} />
        <SettingToggle flag="liveBackground" label={t.liveBackground} />
        <SettingToggle flag="fewerEffects" label={t.fewerEffects} />
      </SettingsGroup>
    </div>
  );
}

function SoundPanel({ active }: { active: boolean }) {
  const settings = useApp((s) => s.settings);
  const speakers = useDevices('audiooutput', active && canChooseSpeaker);
  const [notifError, setNotifError] = useState(false);
  return (
    <div className="set-stack">
      <SettingsGroup title={t.speakers}>
        <div className="device-action">
          {canChooseSpeaker && <DeviceSelect label={t.speakers} value={settings.speakerId} devices={speakers} onChange={(speakerId) => updateSettings({ speakerId })} />}
          <Button data-cue="none" onClick={() => playSound('test', settings.speakerId)}>{t.testSound}</Button>
        </div>
      </SettingsGroup>
      <SettingsGroup title={t.groupSounds}>
        <SettingToggle flag="sounds" label={<span className="toggle-label">{t.eventSounds}<PlaySample sound="join" label={t.eventSounds} /></span>} />
        <SettingToggle flag="uiSounds" label={<span className="toggle-label">{t.interfaceSounds}<PlaySample sound="on" label={t.interfaceSounds} /></span>} />
      </SettingsGroup>
      <SettingsGroup title={t.sectionAlerts} note={notifError ? <span className="field-err" role="alert">{t.notificationsBlocked}</span> : undefined}>
        {notificationsAvailable && (
          <Toggle
            label={t.notifications}
            checked={settings.notifications}
            onChange={(checked) => {
              setNotifError(false);
              if (!checked) updateSettings({ notifications: false });
              else void enableNotifications().then((on) => setNotifError(!on));
            }}
          />
        )}
        <SettingToggle flag="knockAlerts" label={<span className="toggle-label">{t.knockAlerts}<PlaySample sound="knock" label={t.knockAlerts} /></span>} />
      </SettingsGroup>
    </div>
  );
}

type Tab = 'general' | 'voice' | 'sound' | 'video' | 'share' | 'profile' | 'account' | 'keys';

/** Everything a person can change, in one window with its parts down the side. */
export function Settings({ open, onClose }: { open: boolean; onClose(): void }) {
  // Words are read when rendering, so a new language needs only this render.
  useApp((s) => s.settings.language);
  // Labels name the keys, so moving one renders every part again.
  useSyncExternalStore(subscribeShortcuts, shortcutsRevision);
  const accountUI = useAccountUI();
  const close = () => { if (!accountUI.locked) onClose(); };
  const dialog = useRef<HTMLDialogElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  // Too narrow for the screen-share button, its settings mean nothing without it; no keyboard, no shortcuts.
  const showShare = !useMediaQuery('(max-width: 560px)') && canShareScreen;
  const showKeys = !useMediaQuery('(hover: none)');
  const narrow = useMediaQuery('(max-width: 760px)');
  const tabs: readonly (readonly [Tab, string, IconName])[] = [
    ['general', t.tabGeneral, 'sliders'],
    ['voice', t.sectionVoice, 'mic'],
    ['sound', t.tabSound, 'speaker'],
    ...(canUseCamera ? [['video', t.sectionVideo, 'camera'] as const] : []),
    ...(showShare ? [['share', t.sectionShare, 'screen'] as const] : []),
    ['profile', t.sectionProfile, 'person'],
    ['account', t.account.account, 'key'],
    ...(showKeys ? [['keys', t.tabKeys, 'keyboard'] as const] : []),
  ];
  const [chosen, setChosen] = useState<Tab>('general');
  const [scanReturn, setScanReturn] = useState<'idle' | 'away' | 'pending'>('idle');
  const tab = tabs.some(([id]) => id === chosen) ? chosen : 'general';

  const tabButton = (id: Tab) => tabList.current?.querySelector<HTMLButtonElement>(`#set-tab-${id}`);

  useEffect(() => {
    const el = dialog.current!;
    if (open && !el.open) {
      el.showModal();
      tabButton(tab)?.focus();
    } else if (!open && el.open) el.close();
    // The tab is read only at the moment of opening.
  }, [open]);

  useEffect(() => {
    if (!accountUI.deviceOpen && scanReturn === 'away') setScanReturn('pending');
  }, [accountUI.deviceOpen, scanReturn]);

  useEffect(() => {
    tabButton(tab)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  const onTabKey = (e: ReactKeyboardEvent) => {
    const at = tabs.findIndex(([id]) => id === tab);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const [id] = tabs[(next + tabs.length) % tabs.length]!;
    setChosen(id);
    tabButton(id)?.focus();
  };

  const panel = (id: Tab, body: ReactNode) => (
    <div key={id} id={`set-panel-${id}`} className="settings-panel" role="tabpanel" aria-labelledby={`set-tab-${id}`} tabIndex={0} hidden={tab !== id}>
      {body}
    </div>
  );

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby="set-title"
      onClose={() => { if (dialog.current?.open || accountUI.deviceOpen) return; close(); }}
      onCancel={e => { e.preventDefault(); close(); }}
      // Pressing on the dialog itself, not on anything in it, is pressing on what lies around it.
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <nav className="settings-nav">
        <h2 id="set-title">{t.settings}</h2>
        <div ref={tabList} className="tabs" role="tablist" aria-label={t.settings} aria-orientation={narrow ? 'horizontal' : 'vertical'} onKeyDown={onTabKey}>
          {tabs.map(([id, label, icon]) => (
            <button key={id} id={`set-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`set-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setChosen(id)}>
              <Icon name={icon} />
              <span className="tx">{label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-main">
        <header className="settings-head">
          <p className="settings-title" aria-hidden="true">{tabs.find(([id]) => id === tab)?.[1]}</p>
          <IconButton aria-label={t.close} data-cue="close" disabled={accountUI.locked} onClick={close}><Icon name="x" /></IconButton>
        </header>
        {panel('general', <GeneralPanel active={open && tab === 'general'} />)}
        {panel('voice', <VoicePanel active={open && tab === 'voice'} />)}
        {panel('sound', <SoundPanel active={open && tab === 'sound'} />)}
        {canUseCamera && panel('video', <VideoPanel active={open && tab === 'video'} />)}
        {showShare && panel('share', <SharePanel />)}
        {panel('profile', <ProfilePanel />)}
        {panel('account', <AccountPanel active={open && tab === 'account' && !accountUI.entryOpen} onScan={() => { setScanReturn('away'); accountUI.openScanner(); }} scanFocusRequested={scanReturn === 'pending' && open && !accountUI.deviceOpen && tab === 'account'} onScanFocused={() => setScanReturn('idle')} />)}
        {showKeys && panel('keys', <KeysPanel />)}
      </div>
    </dialog>
  );
}
