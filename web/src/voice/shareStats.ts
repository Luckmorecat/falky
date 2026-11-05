export function shareStatsEnabled(development: boolean, hostname: string): boolean {
  return development || hostname === 'dev.falky.lunari.win';
}

export type ShareStatsDirection = 'send' | 'receive';
export interface ShareStatsPoint { at: number; bitrate: number | null }
export interface ShareStatsSample extends ShareStatsPoint {
  codecs: string[];
  history: ShareStatsPoint[];
}

interface StatsEndpoint {
  getStats(): Promise<RTCStatsReport>;
}
interface StatsSender extends StatsEndpoint {
  getParameters?(): { encodings?: { active?: boolean }[] };
}
export interface ShareStatsTrack {
  sender?: StatsSender;
  receiver?: StatsEndpoint;
  mediaStreamTrack?: MediaStreamTrack;
}

interface Counter { bytes: number; timestamp: number; codec?: string }

/** LiveKit 2.23 has no public API for backup sender stats. Keep its @internal
 * simulcastCodecs access here and recheck this adapter when upgrading the SDK. */
function endpoints(track: ShareStatsTrack, direction: ShareStatsDirection): StatsEndpoint[] {
  if (direction === 'receive') return track.receiver ? [track.receiver] : [];
  const local = track as ShareStatsTrack & { simulcastCodecs?: Map<string, { sender?: StatsSender }> };
  return [...new Set([track.sender, ...[...(local.simulcastCodecs?.values() ?? [])].map((info) => info.sender)])]
    .filter((sender): sender is StatsSender => !!sender)
    .filter((sender) => {
      const encodings = sender.getParameters?.().encodings;
      return !encodings?.length || encodings.some((encoding) => encoding.active !== false);
    });
}

/** Observe video RTP payload bytes; these are not a configured limit or wire overhead. */
export function observeShareStats(track: ShareStatsTrack, direction: ShareStatsDirection, onSample: (sample: ShareStatsSample) => void): () => void {
  let stopped = false;
  let pending = false;
  let previous = new Map<StatsEndpoint, Map<string, Counter>>();
  let history: ShareStatsPoint[] = [];

  async function poll() {
    if (stopped || pending) return;
    pending = true;
    let bitrate: number | null = null;
    const codecs = new Set<string>();
    const next = new Map<StatsEndpoint, Map<string, Counter>>();
    try {
      const sources = endpoints(track, direction);
      const reports = await Promise.all(sources.map(async (source) => ({ source, report: await source.getStats() })));
      if (stopped) return;
      let total = 0;
      let count = 0;
      let valid = !!sources.length;
      for (const { source, report } of reports) {
        const counters = new Map<string, Counter>();
        next.set(source, counters);
        let inactive = false;
        report.forEach((stat) => {
          if (stat.type !== (direction === 'send' ? 'outbound-rtp' : 'inbound-rtp') || stat.isRemote) return;
          if (stat.active === false) { inactive = true; return; }
          const codec = report.get(stat.codecId)?.mimeType as string | undefined;
          if (stat.kind !== 'video' && stat.mediaType !== 'video' && !codec?.toLowerCase().startsWith('video/')) return;
          if (codec && /\/(rtx|red|ulpfec|flexfec-03)$/i.test(codec)) return;
          const bytes = direction === 'send' ? stat.bytesSent : stat.bytesReceived;
          if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(stat.timestamp)) {
            valid = false;
            return;
          }
          const old = previous.get(source)?.get(stat.id);
          counters.set(stat.id, { bytes, timestamp: stat.timestamp, codec });
          count++;
          if (!old || stat.timestamp <= old.timestamp || bytes < old.bytes || old.codec !== codec) {
            valid = false;
            return;
          }
          total += (bytes - old.bytes) * 8000 / (stat.timestamp - old.timestamp);
          if (bytes > old.bytes && codec) codecs.add(codec.slice(6).toUpperCase());
        });
        if (!counters.size && !inactive) valid = false;
      }
      if (valid && count) bitrate = total;
    } catch {
      // Diagnostics must never interrupt screen sharing.
    } finally {
      pending = false;
    }
    if (stopped) return;
    previous = next;
    const at = performance.now();
    history = [...history.filter((point) => point.at >= at - 60_000), { at, bitrate }].slice(-61);
    onSample({ at, bitrate, codecs: [...codecs].sort(), history });
  }

  const timer = setInterval(() => void poll(), 1000);
  function stop() {
    stopped = true;
    clearInterval(timer);
    track.mediaStreamTrack?.removeEventListener('ended', ended);
  }
  function ended() {
    stop();
    previous.clear();
    history = [];
    onSample({ at: performance.now(), bitrate: null, codecs: [], history });
  }
  track.mediaStreamTrack?.addEventListener('ended', ended);
  if (track.mediaStreamTrack?.readyState === 'ended') ended();
  else void poll();
  return stop;
}
