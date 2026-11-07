import { useEffect, useRef, useState } from 'react';
import { enableNotifications, rename, updateSettings, voice } from '../app/controller';
import type { Settings as SettingsValues } from '../app/prefs';
import { useApp } from '../app/store';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import type { MicTest } from '../voice/meter';
import { canChooseSpeaker, enumerateDevices, watchDevices, refreshDevices, startMicTest, playSound, notificationsAvailable } from '@falky/browser';
import { canUseCamera } from '../voice/camera';
import { canShareScreen, SHARE_BITRATE_MAX, SHARE_BITRATE_PRESETS, shareBitrate, supportedShareCodecs, type ShareCodec } from '../voice/share';
import { Button } from './Button';
import { Segmented } from './Segmented';
import { Toggle } from './Toggle';

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

export function Settings({ open }: { open: boolean }) {
  const settings = useApp((s) => s.settings);
  const visitor = useApp((s) => s.visitor);
  const sharing = useApp((s) => s.voice.sharing);
  const shareCodecs = supportedShareCodecs();
  const shareCodec = shareCodecs.includes(settings.shareCodec) ? settings.shareCodec : 'vp8';
  const mics = useDevices('audioinput', open);
  const cameras = useDevices('videoinput', open && canUseCamera);
  const speakers = useDevices('audiooutput', open && canChooseSpeaker);
  const [name, setName] = useState(visitor?.name ?? '');
  const [nameError, setNameError] = useState('');
  const [notifError, setNotifError] = useState(false);

  useEffect(() => setName(visitor?.name ?? ''), [visitor?.name]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === visitor?.name) return;
    setNameError((await rename(n)) ?? '');
  };

  return (
    <div className={`sheet${open ? ' open' : ''}`} {...(open ? {} : { inert: true })} role="dialog" aria-label={t.settings}>
      <h2>{t.settings}</h2>

      <section>
        <h3>{t.sectionProfile}</h3>
        <form className="setrow" onSubmit={(e) => void saveName(e)}>
          <label htmlFor="set-name">{t.name}</label>
          <span className="namerow">
            <input id="set-name" type="text" maxLength={32} value={name} onChange={(e) => { setName(e.target.value); setNameError(''); }} />
            <Button type="submit" disabled={!name.trim() || name.trim() === visitor?.name}>{t.save}</Button>
          </span>
          {nameError && <span className="field-err" role="alert">{nameError}</span>}
        </form>
      </section>

      <section>
        <h3>{t.sectionAudio}</h3>
        <label className="setrow">
          {t.mic}
          <select value={settings.micId} onChange={(e) => updateSettings({ micId: e.target.value })}>
            <option value="">{t.systemDefault}</option>
            {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.mic} ${i + 1}`}</option>)}
          </select>
        </label>
        <MicLevel open={open} />
        {canChooseSpeaker && (
          <label className="setrow">
            {t.speakers}
            <select value={settings.speakerId} onChange={(e) => updateSettings({ speakerId: e.target.value })}>
              <option value="">{t.systemDefault}</option>
              {speakers.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.speakers} ${i + 1}`}</option>)}
            </select>
          </label>
        )}
        <div className="setrow">
          <Button data-cue="none" onClick={() => playSound('test', settings.speakerId)}>{t.testSound}</Button>
        </div>
        <SettingToggle flag="noiseSuppression" label={t.noiseSuppression} />
        <SettingToggle flag="echoCancellation" label={t.echoCancellation} />
        <SettingToggle flag="autoGain" label={t.autoGain} />
        <SettingToggle flag="joinMuted" label={t.joinMuted} />
      </section>

      {canUseCamera && (
        <section>
          <h3>{t.sectionCamera}</h3>
          <label className="setrow">
            {t.camera}
            <select value={settings.cameraId} onChange={(e) => updateSettings({ cameraId: e.target.value })}>
              <option value="">{t.systemDefault}</option>
              {cameras.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.camera} ${i + 1}`}</option>)}
            </select>
          </label>
          <Segmented label={t.cameraQuality} value={settings.cameraResolution} options={[['360', '360p'], ['720', '720p'], ['1080', '1080p']]} onChange={(cameraResolution) => updateSettings({ cameraResolution })} />
          <SettingToggle flag="cameraMirror" label={t.cameraMirror} />
        </section>
      )}

      {canShareScreen && (
        <section className="hide-phone">
          <h3>{t.sectionShare}</h3>
          <Segmented label={t.shareCodec} value={shareCodec} options={shareCodecs.map((codec) => [codec, codecLabels[codec]])} onChange={(shareCodec) => updateSettings({ shareCodec })} />
          {shareCodec === 'h265' && <p className="set-note">{t.shareCodecFallback}</p>}
          <Segmented label={t.shareResolution} value={settings.shareResolution} options={[['720', '720p'], ['1080', '1080p'], ['1440', '1440p']]} onChange={(shareResolution) => updateSettings({ shareResolution })} />
          <Segmented label={t.shareFps} value={settings.shareFps} options={[['15', '15'], ['30', '30'], ['60', '60']]} onChange={(shareFps) => updateSettings({ shareFps })} />
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
          <SettingToggle flag="shareAudio" label={t.shareAudio} />
          {sharing && <p className="set-note">{t.shareNextTime}</p>}
        </section>
      )}

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
  );
}
