/** How loud a slice of samples sounds, from 0 to 1. */
export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  // Speech sits low on a linear scale; two roots spread it across the range.
  return Math.max(0, Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.75 - 0.12));
}

export interface MicTest {
  level(): number;
  setGain(value: number): void;
  stop(): void;
}

export interface MicTestOptions {
  gain?: number;
  sinkId?: string;
  signal?: AbortSignal;
}

/** Delayed playback stays local and is disconnected before room audio resumes. */
export async function startMicTest(constraints: MediaTrackConstraints, options: MicTestOptions = {}): Promise<MicTest> {
  const ctx = new AudioContext();
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let delay: DelayNode | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    options.signal?.removeEventListener('abort', stop);
    source?.disconnect();
    delay?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    void ctx.close().catch(() => {});
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    options.signal?.throwIfAborted();
    const resumed = ctx.resume();
    // Capture rejection even if the permission prompt stays open.
    void resumed.catch(() => {});
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    if (stopped) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Microphone test stopped', 'AbortError');
    }
    const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (options.sinkId && withSink.setSinkId) await withSink.setSinkId(options.sinkId);
    await resumed;
    options.signal?.throwIfAborted();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const gain = ctx.createGain();
    gain.gain.value = options.gain ?? 1;
    delay = ctx.createDelay(1);
    delay.delayTime.value = 1;
    source = ctx.createMediaStreamSource(stream);
    source.connect(gain).connect(analyser).connect(delay).connect(ctx.destination);
    const buf = new Float32Array(analyser.fftSize);
    return {
      level() {
        analyser.getFloatTimeDomainData(buf);
        return stopped ? 0 : loudness(buf);
      },
      setGain(value) { gain.gain.value = value; },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
