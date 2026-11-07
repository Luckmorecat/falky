import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { enableNotifications, rename, toggleFavoriteColor, updateSettings, voice } from '../app/controller';
import type { Settings as SettingsValues } from '../app/prefs';
import { shortcuts } from '../app/shortcuts';
import { useApp } from '../app/store';
import { MAX_FAVORITES, ownPalette, PALETTE_NAMES, paletteStyle, type PaletteName } from '../fx/palette';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import type { MicTest } from '../voice/meter';
import { canChooseSpeaker, enumerateDevices, watchDevices, refreshDevices, startMicTest, playSound, notificationsAvailable } from '@falky/browser';
import { canUseCamera } from '../voice/camera';
import { canShareScreen, SHARE_BITRATE_MAX, SHARE_BITRATE_PRESETS, shareBitrate, supportedShareCodecs, type ShareCodec } from '../voice/share';
import { Button } from './Button';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { Orb } from './Orb';
import { Segmented } from './Segmented';
import { Toggle } from './Toggle';
import { useMediaQuery } from './useMediaQuery';

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

type Flag = { [K in keyof SettingsValues]: SettingsValues[K] extends boolean ? K : never }[keyof SettingsValues];

function SettingToggle({ flag, label }: { flag: Flag; label: string }) {
  const on = useApp((s) => s.settings[flag]);
  return <Toggle label={label} checked={on} data-cue-always={flag === 'uiSounds' ? '' : undefined} onChange={(checked) => updateSettings({ [flag]: checked })} />;
}

/** How loud the microphone is: in voice, what goes out; otherwise a test on request. */
function MicLevel({ open }: { open: boolean }) {
  const settings = useApp((s) => s.settings);
  const selfId = useApp((s) => s.visitor?.id);
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
    <div className="setrow">
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
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t.systemDefault}</option>
        {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
      </select>
    </label>
  );
}

function AudioVideoPanel({ active }: { active: boolean }) {
  const settings = useApp((s) => s.settings);
  const mics = useDevices('audioinput', active);
  const cameras = useDevices('videoinput', active && canUseCamera);
  const speakers = useDevices('audiooutput', active && canChooseSpeaker);
  return (
    <div className="set-columns">
      <div>
        <section>
          <h3>{t.sectionVoice}</h3>
          <DeviceSelect label={t.mic} value={settings.micId} devices={mics} onChange={(micId) => updateSettings({ micId })} />
          <MicLevel open={active} />
          <SettingToggle flag="noiseSuppression" label={t.noiseSuppression} />
          <SettingToggle flag="echoCancellation" label={t.echoCancellation} />
          <SettingToggle flag="autoGain" label={t.autoGain} />
          <SettingToggle flag="joinMuted" label={t.joinMuted} />
        </section>
      </div>
      <div>
        <section>
          <h3>{t.sectionAudio}</h3>
          {canChooseSpeaker && <DeviceSelect label={t.speakers} value={settings.speakerId} devices={speakers} onChange={(speakerId) => updateSettings({ speakerId })} />}
          <div className="setrow">
            <Button data-cue="none" onClick={() => playSound('test', settings.speakerId)}>{t.testSound}</Button>
          </div>
        </section>
        {canUseCamera && (
          <section>
            <h3>{t.sectionVideo}</h3>
            <DeviceSelect label={t.camera} value={settings.cameraId} devices={cameras} onChange={(cameraId) => updateSettings({ cameraId })} />
            <Segmented label={t.cameraQuality} value={settings.cameraResolution} options={[['360', '360p'], ['720', '720p'], ['1080', '1080p']]} onChange={(cameraResolution) => updateSettings({ cameraResolution })} />
            <SettingToggle flag="cameraMirror" label={t.cameraMirror} />
          </section>
        )}
      </div>
    </div>
  );
}

function SharePanel() {
  const settings = useApp((s) => s.settings);
  const sharing = useApp((s) => s.voice.sharing);
  const shareCodecs = supportedShareCodecs();
  const shareCodec = shareCodecs.includes(settings.shareCodec) ? settings.shareCodec : 'vp8';
  return (
    <div className="set-columns">
      <div>
        <section>
          {sharing && <p className="set-note set-now">{t.shareNextTime}</p>}
          <Segmented label={t.shareCodec} value={shareCodec} options={shareCodecs.map((codec) => [codec, codecLabels[codec]])} onChange={(shareCodec) => updateSettings({ shareCodec })} />
          {shareCodec === 'h265' && <p className="set-note set-hint">{t.shareCodecFallback}</p>}
          <Segmented label={t.shareResolution} value={settings.shareResolution} options={[['720', '720p'], ['1080', '1080p'], ['1440', '1440p']]} onChange={(shareResolution) => updateSettings({ shareResolution })} />
          <Segmented label={t.shareFps} value={settings.shareFps} options={[['15', '15'], ['30', '30'], ['60', '60']]} onChange={(shareFps) => updateSettings({ shareFps })} />
          <SettingToggle flag="shareAudio" label={t.shareAudio} />
        </section>
      </div>
      <div>
        <section>
          <Segmented label={t.shareFocus} value={settings.shareFocus} options={[['motion', t.shareFocusMotion], ['detail', t.shareFocusDetail]]} onChange={(shareFocus) => updateSettings({ shareFocus })} />
          <p className="set-note set-hint">{t.shareFocusHint[settings.shareFocus]}</p>
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
        </section>
      </div>
    </div>
  );
}

function ColorOption({ name }: { name: PaletteName }) {
  const favorites = useApp((s) => s.settings.favoriteColors);
  const chosen = favorites.includes(name);
  return (
    <label className="color">
      <input type="checkbox" checked={chosen} disabled={!chosen && favorites.length >= MAX_FAVORITES} onChange={() => toggleFavoriteColor(name)} />
      <span className="orb flat" style={paletteStyle(name)} aria-hidden="true" />
      <i aria-hidden="true"><Icon name="check" /></i>
      {t.colorNames[name]}
    </label>
  );
}

function ProfilePanel() {
  const visitor = useApp((s) => s.visitor);
  const ownColor = useApp((s) => s.ownColor);
  const favoriteCount = useApp((s) => s.settings.favoriteColors.length);
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
        <Orb seed={selfId} palette={ownPalette(selfId, selfId, ownColor)} still />
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
          <legend className="set-head">{t.favoriteColors}<b>{t.favoriteColorsCount(favoriteCount, MAX_FAVORITES)}</b></legend>
          <div className="color-grid">
            {PALETTE_NAMES.map((name) => <ColorOption key={name} name={name} />)}
          </div>
          <p className="set-note">{t.favoriteColorsHint}</p>
          <p className="set-note">{t.favoriteColorsLocal}</p>
        </fieldset>
      </div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: ReactNode; label: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{keys}</dd>
    </div>
  );
}

function KeysPanel() {
  return (
    <div className="set-columns">
      <div>
        <section>
          <h3>{t.keysInVoice}</h3>
          <dl className="keys">
            <Shortcut label={t.keyMute} keys={<kbd>{shortcuts.mute.label}</kbd>} />
            <Shortcut label={t.keyDeafen} keys={<kbd>{shortcuts.deafen.label}</kbd>} />
            {canUseCamera && <Shortcut label={t.keyCamera} keys={<kbd>{shortcuts.camera.label}</kbd>} />}
          </dl>
        </section>
      </div>
      <div>
        <section>
          <h3>{t.keysAnywhere}</h3>
          <dl className="keys">
            <Shortcut label={t.keyChat} keys={<><kbd>{shortcuts.chat.label}</kbd>{t.keyOr}<kbd>{shortcuts.chatEnter.label}</kbd></>} />
            <Shortcut label={t.keyRooms} keys={<><kbd>{shortcuts.previousRoom.label}</kbd><kbd>{shortcuts.nextRoom.label}</kbd></>} />
            <Shortcut label={t.keyClose} keys={<kbd>{shortcuts.closeRooms.label}</kbd>} />
          </dl>
        </section>
      </div>
    </div>
  );
}

function SystemPanel() {
  const settings = useApp((s) => s.settings);
  const [notifError, setNotifError] = useState(false);
  return (
    <div className="set-columns">
      <div>
        <section>
          <h3>{t.sectionLook}</h3>
          <Segmented label={t.theme} value={settings.theme} options={[['dark', t.themeDark], ['light', t.themeLight], ['system', t.themeSystem]]} onChange={(theme) => updateSettings({ theme })} />
          <Segmented label={t.language} value={settings.language} options={[['system', t.languageSystem], ['uk', 'Українська'], ['en', 'English']]} onChange={(language) => updateSettings({ language })} />
          <Segmented label={t.orbLook} value={settings.orbLight} options={[['flat', t.orbLookFlat], ['volume', t.orbLookVolume]]} onChange={(orbLight) => updateSettings({ orbLight })} />
          <p className="set-note set-hint">{t.orbLookHint}</p>
          <SettingToggle flag="liveBackground" label={t.liveBackground} />
          <SettingToggle flag="fewerEffects" label={t.fewerEffects} />
          <p className="set-note set-hint">{t.fewerEffectsHint}</p>
        </section>
      </div>
      <div>
        <section>
          <h3>{t.sectionAlerts}</h3>
          <SettingToggle flag="sounds" label={t.eventSounds} />
          <SettingToggle flag="uiSounds" label={t.interfaceSounds} />
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
          {notifError && <p className="field-err" role="alert">{t.notificationsBlocked}</p>}
        </section>
      </div>
    </div>
  );
}

type Tab = 'media' | 'share' | 'profile' | 'keys' | 'system';

/** Everything a person can change, in one window with its parts along the top. */
export function Settings({ open, onClose }: { open: boolean; onClose(): void }) {
  // Words are read when rendering, so a new language needs only this render.
  useApp((s) => s.settings.language);
  const dialog = useRef<HTMLDialogElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  // Too narrow for the screen-share button, its settings mean nothing without it; no keyboard, no shortcuts.
  const showShare = !useMediaQuery('(max-width: 560px)') && canShareScreen;
  const showKeys = !useMediaQuery('(hover: none)');
  const tabs: readonly (readonly [Tab, string])[] = [
    ['media', t.tabAudioVideo],
    ...(showShare ? [['share', t.sectionShare] as const] : []),
    ['profile', t.sectionProfile],
    ...(showKeys ? [['keys', t.tabKeys] as const] : []),
    ['system', t.tabSystem],
  ];
  const [chosen, setChosen] = useState<Tab>('media');
  const tab = tabs.some(([id]) => id === chosen) ? chosen : 'media';

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
    tabButton(tab)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  const onTabKey = (e: ReactKeyboardEvent) => {
    const at = tabs.findIndex(([id]) => id === tab);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
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
      onClose={onClose}
      // Pressing on the dialog itself, not on anything in it, is pressing on what lies around it.
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <header className="settings-head">
        <h2 id="set-title">{t.settings}</h2>
        <IconButton aria-label={t.close} data-cue="close" onClick={onClose}><Icon name="x" /></IconButton>
      </header>
      <div ref={tabList} className="tabs" role="tablist" aria-label={t.settings} onKeyDown={onTabKey}>
        {tabs.map(([id, label]) => (
          <button key={id} id={`set-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`set-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setChosen(id)}>
            {label}
          </button>
        ))}
      </div>
      {panel('media', <AudioVideoPanel active={open && tab === 'media'} />)}
      {showShare && panel('share', <SharePanel />)}
      {panel('profile', <ProfilePanel />)}
      {showKeys && panel('keys', <KeysPanel />)}
      {panel('system', <SystemPanel />)}
    </dialog>
  );
}
