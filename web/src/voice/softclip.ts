const KNEE = 0.8;

/**
 * Passes everything below the knee untouched and bends what is above it towards
 * full scale, so that a raised voice keeps its loudness and its peaks do not
 * clip harshly. A compressor would pull the raised level back down.
 */
export function softClipCurve(samples = 2049): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const size = Math.abs(x);
    const y = size <= KNEE ? size : KNEE + (1 - KNEE) * Math.tanh((size - KNEE) / (1 - KNEE));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
