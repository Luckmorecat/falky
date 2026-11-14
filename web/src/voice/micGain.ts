import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { loudness } from './meter';

export function microphoneGain(auto: boolean, percent: number): number {
  return auto ? 1 : Math.max(0, Math.min(200, percent)) / 100;
}

/** Applies the same gain before transmission and before local test playback. */
export class MicrophoneGain implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'microphone-volume';
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private analyser?: AnalyserNode;
  private readonly samples = new Float32Array(1024);

  constructor(private readonly value: () => number) {}

  async init({ audioContext, track }: AudioProcessorOptions): Promise<void> {
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.gain = audioContext.createGain();
    this.destination = audioContext.createMediaStreamDestination();
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    this.update();
    this.source.connect(this.gain).connect(this.destination);
    this.gain.connect(this.analyser);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }

  update(): void {
    if (this.gain) this.gain.gain.value = this.value();
  }

  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return loudness(this.samples);
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.destination?.disconnect();
    this.analyser?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined;
    this.gain = undefined;
    this.destination = undefined;
    this.analyser = undefined;
    this.processedTrack = undefined;
  }
}
