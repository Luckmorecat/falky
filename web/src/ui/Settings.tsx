import { useEffect, useRef, useState } from 'react';
import { enableNotifications, rename, updateSettings, voice } from '../app/controller';
import { useApp } from '../app/store';
import { onTick } from '../fx/ticker';
import { t } from '../strings';
import { playSound } from '../voice/sounds';

function useDevices(kind: MediaDeviceKind, active: boolean): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!active || !navigator.mediaDevices?.enumerateDevices) return;
    const load = () => void navigator.mediaDevices.enumerateDevices().then((all) => setDevices(all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')));
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, [kind, active]);
  return devices;
}

const canChooseSpeaker = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

export function Settings({ open }: { open: boolean }) {
  const settings = useApp((s) => s.settings);
  const visitor = useApp((s) => s.visitor);
  const inVoice = useApp((s) => s.voice.status === 'connected');
  const mics = useDevices('audioinput', open);
  const speakers = useDevices('audiooutput', open && canChooseSpeaker);
  const [name, setName] = useState(visitor?.name ?? '');
  const [nameError, setNameError] = useState('');
  const [notifError, setNotifError] = useState(false);
  const line = useRef<HTMLDivElement>(null);
  const moon = useRef<HTMLDivElement>(null);

  useEffect(() => setName(visitor?.name ?? ''), [visitor?.name]);

  useEffect(() => {
    if (!open || !inVoice || !visitor) return;
    return onTick(() => {
      const l = voice.level(visitor.id);
      if (line.current) line.current.style.transform = `scaleX(${l.toFixed(3)})`;
      if (moon.current && line.current) moon.current.style.transform = `translateX(${(l * line.current.clientWidth).toFixed(1)}px)`;
    });
  }, [open, inVoice, visitor]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === visitor?.name) return;
    setNameError((await rename(n)) ?? '');
  };

  return (
    <div className={`sheet${open ? ' open' : ''}`} {...(open ? {} : { inert: true })} role="dialog" aria-label={t.settings}>
      <h2>{t.settings}</h2>
      <form className="setrow" onSubmit={(e) => void saveName(e)}>
        <label htmlFor="set-name">{t.name}</label>
        <span className="namerow">
          <input id="set-name" type="text" maxLength={32} value={name} onChange={(e) => { setName(e.target.value); setNameError(''); }} />
          <button className="btn2" disabled={!name.trim() || name.trim() === visitor?.name}>{t.save}</button>
        </span>
        {nameError && <span className="field-err" role="alert">{nameError}</span>}
      </form>
      <label className="setrow">
        {t.mic}
        <select value={settings.micId} onChange={(e) => updateSettings({ micId: e.target.value })}>
          <option value="">{t.systemDefault}</option>
          {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${t.mic} ${i + 1}`}</option>)}
        </select>
      </label>
      {inVoice && (
        <div className="setrow">
          <span>{t.micLevel}</span>
          <div className="meter" aria-hidden="true">
            <div className="dots" />
            <div className="line" ref={line} />
            <div className="moon" ref={moon} />
          </div>
        </div>
      )}
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
        <button className="btn2" onClick={() => playSound('test', settings.speakerId)}>{t.testSound}</button>
      </div>
      <label className="toggle">
        {t.eventSounds}
        <input type="checkbox" checked={settings.sounds} onChange={(e) => updateSettings({ sounds: e.target.checked })} />
      </label>
      {typeof Notification !== 'undefined' && (
        <label className="toggle">
          {t.notifications}
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={(e) => {
              setNotifError(false);
              if (!e.target.checked) updateSettings({ notifications: false });
              else void enableNotifications().then((on) => setNotifError(!on));
            }}
          />
        </label>
      )}
      {notifError && <p className="field-err" role="alert">{t.notificationsBlocked}</p>}
      <label className="toggle">
        {t.fewerEffects}
        <input type="checkbox" checked={settings.fewerEffects} onChange={(e) => updateSettings({ fewerEffects: e.target.checked })} />
      </label>
    </div>
  );
}
