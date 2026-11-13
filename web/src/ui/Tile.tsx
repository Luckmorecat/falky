import { useEffect, useRef, useState } from 'react';
import { prefs } from '../app/prefs';
import { setParticipantVolume, voice } from '../app/controller';
import { useApp } from '../app/store';
import { type PaletteName, paletteStyle } from '../fx/palette';
import { t } from '../strings';
import { Icon } from './Icon';
import { Orb } from './Orb';
import { VolumeSlider } from './VolumeSlider';
import './Tile.css';

export interface TileProps {
  id: string;
  visitorId: string;
  name: string;
  palette?: PaletteName;
  isSelf?: boolean;
  /** How loud they are now; absent outside the room's voice, where it is not known. */
  level?: () => number;
  muted?: boolean;
  deafened?: boolean;
  /** Whether this client hears them, so their volume can change. */
  adjustable?: boolean;
  mini?: boolean;
  /** Their camera's track when it is on and can be shown. */
  cameraTrackId?: string;
}

/**
 * A camera's picture, laid on the orb so that a rim of its colours stays around
 * it and the voice still shows. It fades in once frames arrive, never as a black box.
 */
function Camera({ id, trackId, mirror }: { id: string; trackId: string; mirror: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = video.current;
    const track = voice.cameraTrack(id);
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
      setPlaying(false);
    };
  }, [id, trackId]);

  return (
    <div className="orb-video">
      <video ref={video} className={`${playing ? 'on' : ''}${mirror ? ' mirror' : ''}`} autoPlay playsInline muted onPlaying={() => setPlaying(true)} />
    </div>
  );
}

/** A connection in the room: their orb, their name, and how they are heard. */
export function Tile({ id, visitorId, name, palette, isSelf, level, muted, deafened, adjustable, mini, cameraTrackId }: TileProps) {
  const tile = useRef<HTMLElement>(null);
  const mirror = useApp((s) => s.settings.cameraMirror);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [volume, setVolume] = useState(() => prefs.volume(id));

  const locallyMuted = !isSelf && volume === 0;
  const localStatus = `${t.statusMutedForYou} · ${t.volume} 0%`;
  const status = [deafened ? t.statusDeaf : muted ? t.statusMuted : '', locallyMuted ? localStatus : ''].filter(Boolean).join(', ');
  const dim = muted || deafened;

  return (
    <article
      ref={tile}
      data-tile={id}
      className={`tile${dim ? ' dim' : ''}${locallyMuted ? ' locally-muted' : ''}${mini ? ' mini' : ''}${volumeOpen ? ' vol-open' : ''}`}
      style={paletteStyle(palette)}
      aria-label={status ? `${name}, ${status}` : name}
    >
      <div
        className="t-orb"
        // No hover on a touch screen: a tap on the orb brings its controls up instead.
        onPointerUp={adjustable && !mini ? (e) => { if (e.pointerType !== 'mouse') setVolumeOpen(!volumeOpen); } : undefined}
      >
        <Orb seed={visitorId} palette={palette} level={level}>
          {cameraTrackId && <Camera id={id} trackId={cameraTrackId} mirror={!!isSelf && mirror} />}
        </Orb>
        {!mini && (deafened || muted || locallyMuted) && <div className="t-flags">
          {deafened ? <span className="t-flag" title={t.statusDeaf}><Icon name="headOff" /></span>
            : muted ? <span className="t-flag" title={t.statusMuted}><Icon name="micOff" /></span> : null}
          {locallyMuted && <span className="t-flag" title={localStatus}><Icon name="speakerOff" /></span>}
        </div>}
        {adjustable && !mini && (
          <VolumeSlider
            wheelTarget={tile}
            label={`${t.volume}: ${name}`}
            value={volume}
            onChange={(v) => {
              setVolume(v);
              setParticipantVolume(id, v);
            }}
          />
        )}
      </div>
      <div className="t-label">
        <span className="t-name">{name}</span>
      </div>
    </article>
  );
}
