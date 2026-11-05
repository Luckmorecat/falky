import { useEffect, useState } from 'react';
import { t } from '../strings';
import { observeShareStats, type ShareStatsDirection, type ShareStatsSample, type ShareStatsTrack } from '../voice/shareStats';

const empty: ShareStatsSample = { at: 0, bitrate: null, codecs: [], history: [] };

export function ShareStats({ track, direction }: { track: ShareStatsTrack | null; direction: ShareStatsDirection }) {
  const [state, setState] = useState<{ track: ShareStatsTrack | null; direction: ShareStatsDirection; sample: ShareStatsSample } | null>(null);
  useEffect(() => {
    setState(null);
    if (!track) return;
    return observeShareStats(track, direction, (sample) => setState({ track, direction, sample }));
  }, [track, direction]);
  // A replacement track must never paint the previous track's last sample.
  const sample = state?.track === track && state.direction === direction ? state.sample : empty;
  return <ShareStatsOverlay direction={direction} sample={sample} />;
}

export function ShareStatsOverlay({ direction, sample }: { direction: ShareStatsDirection; sample: ShareStatsSample }) {
  const peak = Math.max(1_000_000, ...sample.history.map((point) => point.bitrate ?? 0));
  const ceiling = Math.ceil(peak / 1_000_000) * 1_000_000;
  const paths: string[] = [];
  let path = '';
  let previousAt: number | null = null;
  const dots: { x: number; y: number }[] = [];
  for (const point of sample.history) {
    if (point.bitrate === null || point.at < sample.at - 60_000) {
      if (path) paths.push(path);
      path = '';
      previousAt = null;
      continue;
    }
    // A throttled/background tab also leaves a gap instead of invented samples.
    if (previousAt !== null && point.at - previousAt > 2500) {
      if (path) paths.push(path);
      path = '';
    }
    const x = 2 + Math.max(0, Math.min(1, (point.at - sample.at + 60_000) / 60_000)) * 236;
    const y = 48 - point.bitrate / ceiling * 44;
    path += `${path ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
    dots.push({ x, y });
    previousAt = point.at;
  }
  if (path) paths.push(path);
  return (
    <aside className="share-stats" aria-label={t.shareStats}>
      <div className="share-stats-heading">
        <span>{direction === 'send' ? t.shareStatsSend : t.shareStatsReceive}</span>
        <strong>{sample.bitrate === null ? '—' : (sample.bitrate / 1_000_000).toFixed(2)} <small>{t.shareStatsMbps}</small></strong>
      </div>
      <div className="share-stats-codecs">{sample.codecs.join(' + ') || '—'}</div>
      <div className="share-stats-scale"><span>{ceiling / 1_000_000} {t.shareStatsMbps}</span></div>
      <svg viewBox="0 0 240 52" role="img" aria-label={t.shareStatsGraph}>
        <path className="share-stats-axis" d="M2,4 H238 M2,48 H238" />
        {paths.map((segment, i) => <path key={i} className="share-stats-line" d={segment} />)}
        {dots.map((dot, i) => <circle key={i} cx={dot.x} cy={dot.y} r="1.25" />)}
      </svg>
      <div className="share-stats-scale"><span>{t.shareStatsWindow}</span><span>0 · {t.shareStatsNow}</span></div>
    </aside>
  );
}
