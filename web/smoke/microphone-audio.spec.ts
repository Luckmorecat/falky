import { expect, test } from '@playwright/test';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });

// Real Web Audio nodes with a generated input; no microphone hardware or media server.
test('manual gain changes the processed audio track and survives a capture restart', async ({ page }) => {
  await page.goto(app.url);
  await page.mouse.click(1, 1);
  const result = await page.evaluate(async () => {
    const path = '/src/voice/micGain.ts';
    const { MicrophoneGain, microphoneGain } = await import(path);
    const ctx = new AudioContext();
    await ctx.resume();
    const capture = new AudioContext();
    const playback = new AudioContext();
    await Promise.all([capture.resume(), playback.resume()]);
    const tone = capture.createOscillator();
    const quiet = capture.createGain();
    quiet.gain.value = 0.1;
    const input = capture.createMediaStreamDestination();
    tone.connect(quiet).connect(input);
    tone.start();
    let volume = 1;
    const processor = new MicrophoneGain(() => volume);
    const options = { track: input.stream.getAudioTracks()[0]!, audioContext: ctx, kind: 'audio' };
    await processor.init(options);
    let source = playback.createMediaStreamSource(new MediaStream([processor.processedTrack]));
    const analyser = playback.createAnalyser();
    source.connect(analyser);
    const read = async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    };
    try {
      const normal = await read();
      const localLevel = processor.level();
      volume = microphoneGain(false, 50); processor.update();
      const half = await read();
      volume = microphoneGain(false, 0); processor.update();
      const silent = await read();
      volume = microphoneGain(false, 200); processor.update();
      const double = await read();
      volume = microphoneGain(true, 0); processor.update();
      const automatic = await read();
      const previous = processor.processedTrack;
      await processor.restart(options);
      source.disconnect();
      source = playback.createMediaStreamSource(new MediaStream([processor.processedTrack]));
      source.connect(analyser);
      const restarted = await read();
      await processor.destroy();
      return { normal, localLevel, half, silent, double, automatic, restarted, previousStopped: previous.readyState === 'ended', inputAlive: options.track.readyState === 'live' };
    } finally {
      await processor.destroy();
      tone.stop();
      input.stream.getTracks().forEach(track => track.stop());
      await Promise.all([ctx.close(), capture.close(), playback.close()]);
    }
  });
  expect(result.normal).toBeGreaterThan(0.05);
  expect(result.localLevel).toBeGreaterThan(0);
  expect(result.half / result.normal).toBeCloseTo(0.5, 1);
  expect(result.silent).toBe(0);
  expect(result.double / result.normal).toBeCloseTo(2, 1);
  expect(result.automatic / result.normal).toBeCloseTo(1, 1);
  expect(result.restarted / result.normal).toBeCloseTo(1, 1);
  expect(result.previousStopped).toBe(true);
  expect(result.inputAlive).toBe(true);
});

test('microphone test delays playback, applies live gain and releases capture on stop', async ({ page }) => {
  await page.goto(app.url);
  await page.mouse.click(1, 1);
  const result = await page.evaluate(async () => {
    const path = '/src/voice/meter.ts';
    const { startMicTest } = await import(path);
    const inputContext = new AudioContext();
    await inputContext.resume();
    const tone = inputContext.createOscillator();
    const input = inputContext.createMediaStreamDestination();
    tone.connect(input); tone.start();
    navigator.mediaDevices.getUserMedia = async () => input.stream;
    let output: AnalyserNode;
    const createDelay = AudioContext.prototype.createDelay;
    AudioContext.prototype.createDelay = function (maxDelay) {
      const delay = createDelay.call(this, maxDelay);
      output = this.createAnalyser();
      delay.connect(output);
      return delay;
    };
    const abort = new AbortController();
    const playback = await startMicTest({}, { gain: 0.1, signal: abort.signal });
    const read = async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms));
      const samples = new Float32Array(output.fftSize);
      output.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    };
    try {
      const beforeDelay = await read(200);
      const playing = await read(1100);
      playback.setGain(0);
      const silent = await read(1200);
      abort.abort();
      playback.stop();
      return { beforeDelay, playing, silent, stopped: input.stream.getTracks().every(track => track.readyState === 'ended') };
    } finally {
      playback.stop(); tone.stop(); await inputContext.close();
      AudioContext.prototype.createDelay = createDelay;
    }
  });
  expect(result.beforeDelay).toBe(0);
  expect(result.playing).toBeCloseTo(0.1, 2);
  expect(result.silent).toBe(0);
  expect(result.stopped).toBe(true);
});

test('canceling a pending microphone prompt stops the late capture without playing it', async ({ page }) => {
  await page.goto(app.url);
  await page.mouse.click(1, 1);
  const result = await page.evaluate(async () => {
    const path = '/src/voice/meter.ts';
    const { startMicTest } = await import(path);
    const ctx = new AudioContext();
    const input = ctx.createMediaStreamDestination();
    let accept!: (stream: MediaStream) => void;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { accept = resolve; });
    const abort = new AbortController();
    const pending = startMicTest({}, { signal: abort.signal }).catch((error: Error) => error.name);
    abort.abort();
    accept(input.stream);
    const error = await pending;
    await ctx.close();
    return { error, stopped: input.stream.getTracks().every(track => track.readyState === 'ended') };
  });
  expect(result).toEqual({ error: 'AbortError', stopped: true });
});
