/** How loud a slice of samples sounds, from 0 to 1. */
export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  // Speech sits low on a linear scale; two roots spread it across the range.
  return Math.max(0, Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.75 - 0.12));
}

export interface MicTest {
  level(): number;
  stop(): void;
}

/** Listens to a microphone outside voice, to see that it works. Nothing leaves the page. */
export async function startMicTest(constraints: MediaTrackConstraints): Promise<MicTest> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(buf);
      return loudness(buf);
    },
    stop() {
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
    },
  };
}
