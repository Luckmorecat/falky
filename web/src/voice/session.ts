import type {
  LocalAudioTrack,
  LocalTrack,
  LocalTrackPublication,
  Participant as LkParticipant,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
  Track,
  VideoTrack,
} from 'livekit-client';
import { api, ApiError } from '../api/client';
import { cameraOptions } from './camera';
import { loudness } from './meter';
import { MicrophoneGain } from './micGain';
import { MicTestMuting, type MicTestMute } from './micTestMute';
import { shareOptions } from './share';
import { softClipCurve } from './softclip';

import { idleVoice, type VoiceHost, type VoicePerson, type VoiceSnapshot, type VoiceClient } from './types';
export { idleVoice } from './types';
export type { VoiceHost, VoicePerson, VoiceSnapshot, VoiceProblem, VoiceSound } from './types';

interface Meter {
  trackId: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

let sdk: Pick<typeof import('livekit-client'), 'ConnectionQuality' | 'DisconnectReason' | 'RemoteAudioTrack' | 'Room' | 'RoomEvent' | 'Track'>;
let loading: Promise<void> | null = null;

/** Warm the SDK after the interface paints; joining can also start or await it. */
export function preloadVoice(): Promise<void> {
  return loading ??= import('livekit-client').then(
    ({ ConnectionQuality, DisconnectReason, RemoteAudioTrack, Room, RoomEvent, Track }) => {
      sdk = { ConnectionQuality, DisconnectReason, RemoteAudioTrack, Room, RoomEvent, Track };
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
}

const identityId = (transport: string) => transport.split('.')[0]!;
const isDeafened = (p: LkParticipant) => p.attributes.deafened === 'true';

/** One visitor's connection to one room's voice at a time, over LiveKit. */
export class VoiceSession implements VoiceClient {
  private room: Room | null = null;
  private snap: VoiceSnapshot = idleVoice;
  private audio: AudioContext | null = null;
  private meters = new Map<string, Meter>();
  private readonly sinkHost: HTMLElement;
  private mutedBeforeDeaf = false;
  private readonly micTestMuting = new MicTestMuting();
  private readonly micStarts = new WeakMap<Room, Promise<void>>();
  private refreshQueued = false;
  /** A refused admission keeps the current room intact. */
  private moving = false;
  private operation = 0;
  private removedWhileMoving = false;
  private knownShares = new Set<string>();
  /** What each remote track is raised by above 100%. */
  private boosts = new WeakMap<RemoteAudioTrack, GainNode>();

  constructor(private readonly host: VoiceHost) {
    this.sinkHost = document.createElement('div');
    this.sinkHost.hidden = true;
    document.body.append(this.sinkHost);
  }

  get snapshot(): VoiceSnapshot {
    return this.snap;
  }

  /** Admits a new connection before disconnecting this app instance's previous room. */
  async join(roomId: string): Promise<void> {
    if (this.snap.status === 'joining') return;
    // In the click's gesture, so that browsers let it start.
    this.audio ??= new AudioContext({ latencyHint: 'interactive' });
    void this.audio.resume();
    const operation = ++this.operation;
    const deafened = this.snap.deafened;
    // Moving rooms keeps the camera as it was; a first join never starts it.
    const keepCamera = this.snap.camera;
    const startMuted = this.snap.status === 'idle' ? this.host.joinMuted() : this.snap.muted && !this.snap.listenOnly;
    this.set({ status: 'joining', joiningRoomId: roomId });
    this.moving = true;
    this.removedWhileMoving = false;
    let creds;
    try {
      await preloadVoice();
      if (operation !== this.operation) return;
      creds = await api.joinVoice(roomId);
    } catch (err) {
      if (operation !== this.operation) return;
      this.moving = false;
      const code = err instanceof ApiError ? err.code : 'network';
      // Refused with `room_full` the visitor stays where they were, unless
      // LiveKit trouble already took them out.
      if (this.room && !this.removedWhileMoving) {
        this.set({ status: 'connected', joiningRoomId: null });
      } else {
        this.close();
      }
      if (code === 'room_full' || code === 'voice_unavailable' || code === 'name_taken' || code === 'visitor_required') this.host.onProblem(code);
      else this.host.onProblem('join_failed');
      return;
    }
    if (operation !== this.operation) return;
    this.moving = false;
    this.teardownRoom();

    let room: Room | null = null;
    try {
      const speakerId = this.host.speakerId();
      room = new sdk.Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: this.micOptions(),
        audioOutput: speakerId ? { deviceId: speakerId } : undefined,
        // Through Web Audio, because an audio element cannot play above 100%.
        webAudioMix: { audioContext: this.audio },
      });
      this.room = room;
      this.bind(room);
      await room.connect(creds.url, creds.token);
    } catch {
      if (operation === this.operation) {
        this.close();
        this.host.onProblem('media_failed');
      } else if (room) this.disconnectRoom(room);
      return;
    }
    if (this.room !== room) { this.disconnectRoom(room); return; }
    await room.startAudio().catch(() => {});
    if (this.room !== room) { this.disconnectRoom(room); return; }
    this.knownShares.clear();
    this.set({ status: 'connected', roomId, joiningRoomId: null, joinedAt: performance.now(), deafened, listenOnly: false });
    this.host.onSound('join');
    if (deafened) {
      this.applyVolumes();
      void room.localParticipant.setAttributes({ deafened: 'true' }).catch(() => {});
    }
    if (!deafened && !startMuted) await this.enableMic(room);
    if (this.room !== room) return;
    if (keepCamera) await this.enableCamera(room);
    this.refresh();
  }

  async leave(): Promise<void> {
    if (this.snap.status === 'idle') return;
    this.host.onSound('leave');
    this.close();
  }

  /** Ends voice without a sound: the access ended. */
  end(): void {
    this.close();
  }

  async toggleMute(): Promise<void> {
    if (this.micTestMuting.active) return;
    const room = this.room;
    if (!room) return;
    if (this.snap.deafened) await this.setDeafened(false);
    if (room.localParticipant.isMicrophoneEnabled) await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    else await this.enableMic(room);
    this.refresh();
  }

  async toggleDeafen(): Promise<void> {
    await this.setDeafened(!this.snap.deafened);
  }

  private async setDeafened(on: boolean): Promise<void> {
    const room = this.room;
    if (!room || on === this.snap.deafened) return;
    const local = room.localParticipant;
    this.set({ deafened: on });
    this.applyVolumes();
    void local.setAttributes({ deafened: on ? 'true' : 'false' }).catch(() => {});
    if (on) {
      this.micTestMuting.keepMuted();
      this.mutedBeforeDeaf = !local.isMicrophoneEnabled;
      await local.setMicrophoneEnabled(false).catch(() => {});
    } else if (!this.mutedBeforeDeaf) {
      await this.enableMic(room);
    }
    this.refresh();
  }

  async toggleShare(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const on = !room.localParticipant.isScreenShareEnabled;
    try {
      const { capture, publish } = shareOptions(this.host.shareSettings());
      await room.localParticipant.setScreenShareEnabled(on, capture, publish);
      if (this.room !== room) this.stopTracks(room);
    } catch (err) {
      if (this.room !== room) { this.stopTracks(room); return; }
      // Backing out of the browser's picker is not a failure.
      if ((err as Error).name !== 'NotAllowedError') this.host.onProblem('share_failed');
    }
    this.refresh();
  }

  async toggleCamera(): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (this.snap.camera) await this.disableCamera(room);
    else await this.enableCamera(room);
    this.refresh();
  }

  /** Puts changed camera quality to use: encodings are fixed when a track is published. */
  async restartCamera(): Promise<void> {
    const room = this.room;
    if (!room || !this.snap.camera) return;
    await this.disableCamera(room);
    await this.enableCamera(room);
    this.refresh();
  }

  async setCamera(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('videoinput', deviceId).catch(() => {});
  }

  private async enableCamera(room: Room): Promise<void> {
    if (this.room !== room) return;
    try {
      const { capture, publish } = cameraOptions(this.host.cameraSettings());
      await room.localParticipant.setCameraEnabled(true, capture, publish);
      if (this.room !== room) this.stopTracks(room);
    } catch (err) {
      if (this.room !== room) { this.stopTracks(room); return; }
      const name = (err as Error).name;
      this.host.onProblem(name === 'NotAllowedError' ? 'camera_denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'camera_missing' : 'camera_failed');
    }
  }

  /**
   * Unpublished and stopped rather than muted: the camera's light goes out, and
   * turning it on again takes up whatever device and quality are chosen by then.
   */
  private async disableCamera(room: Room): Promise<void> {
    const track = room.localParticipant.getTrackPublication(sdk.Track.Source.Camera)?.track as LocalTrack | undefined;
    if (track) await room.localParticipant.unpublishTrack(track, true).catch(() => {});
  }

  private videoTrack(connectionId: string, source: Track.Source): VideoTrack | null {
    const room = this.room;
    if (!room) return null;
    const p: LkParticipant | undefined = room.localParticipant.identity === connectionId ? room.localParticipant : [...room.remoteParticipants.values()].find((participant) => participant.identity === connectionId);
    return (p?.getTrackPublication(source)?.track as VideoTrack | undefined) ?? null;
  }

  /** The screen a participant shows, to attach to a video element. */
  shareTrack(connectionId: string): VideoTrack | null {
    return this.room ? this.videoTrack(connectionId, sdk.Track.Source.ScreenShare) : null;
  }

  /** A participant's camera, to attach to a video element. */
  cameraTrack(connectionId: string): VideoTrack | null {
    return this.room ? this.videoTrack(connectionId, sdk.Track.Source.Camera) : null;
  }

  /** How loud a participant is now, from 0 to 1. */
  level(connectionId: string): number {
    if (connectionId === this.room?.localParticipant.identity) {
      const processor = this.micGainProcessor();
      if (processor) return this.snap.muted ? 0 : processor.level();
    }
    const meter = this.meters.get(connectionId);
    if (!meter) return 0;
    meter.analyser.getFloatTimeDomainData(meter.buf);
    return loudness(meter.buf);
  }

  applyVolumes(): void {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) this.applyVolumesFor(p);
  }

  async setMic(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audioinput', deviceId).catch(() => {});
  }

  async setSpeaker(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audiooutput', deviceId).catch(() => {});
  }

  /** Applies changed noise, echo and gain settings to the microphone in use. */
  async applyMicProcessing(): Promise<void> {
    const track = this.room?.localParticipant.getTrackPublication(sdk.Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    await track?.restartTrack(this.micOptions()).catch(() => {});
    this.refresh();
  }

  applyMicGain(): void {
    this.micGainProcessor()?.update();
  }

  private micGainProcessor(): MicrophoneGain | undefined {
    const track = this.room?.localParticipant.getTrackPublication(sdk.Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    const processor = track?.getProcessor?.();
    return processor instanceof MicrophoneGain ? processor : undefined;
  }

  suspendMicForTest(): MicTestMute {
    const room = this.room;
    const restore = !!room && (room.localParticipant.isMicrophoneEnabled || this.micStarts.has(room));
    return this.micTestMuting.acquire(async () => {
      if (!room) return;
      await this.micStarts.get(room);
      if (this.room !== room) return;
      await room.localParticipant.setMicrophoneEnabled(false);
      this.refresh();
    }, restore ? async () => {
      if (!room || this.room !== room || this.snap.deafened) return;
      await this.enableMic(room);
      this.refresh();
    } : undefined);
  }

  private micOptions() {
    return { ...this.host.micProcessing(), deviceId: this.host.micId() || undefined };
  }

  private async enableMic(room: Room): Promise<void> {
    if (this.room !== room || this.micTestMuting.active) return;
    const pending = this.micStarts.get(room);
    if (pending) return pending;
    const starting = this.startMic(room);
    this.micStarts.set(room, starting);
    try { await starting; } finally { this.micStarts.delete(room); }
  }

  private async startMic(room: Room): Promise<void> {
    let created: LocalAudioTrack | undefined;
    try {
      const local = room.localParticipant;
      if (!local.getTrackPublication(sdk.Track.Source.Microphone)?.track) {
        const tracks = await local.createTracks({ audio: this.micOptions() });
        created = tracks[0] as LocalAudioTrack;
        if (this.room !== room) { created.stop(); return; }
        await created.setAudioContext(this.audio!);
        await created.setProcessor(new MicrophoneGain(() => this.host.micGain()));
        if (this.room !== room) { created.stop(); return; }
        if (this.micTestMuting.active || this.snap.deafened) await created.mute();
        await local.publishTrack(created);
      } else if (!this.micTestMuting.active && !this.snap.deafened) {
        await local.setMicrophoneEnabled(true, this.micOptions());
      }
      if (this.room !== room) { this.stopTracks(room); return; }
      if (this.micTestMuting.active || this.snap.deafened) await local.setMicrophoneEnabled(false);
      this.set({ listenOnly: false });
    } catch (err) {
      created?.stop();
      if (this.room !== room) { this.stopTracks(room); return; }
      this.set({ listenOnly: true });
      this.host.onProblem((err as Error).name === 'NotFoundError' ? 'mic_missing' : 'mic_denied');
    }
  }

  private bind(room: Room): void {
    const refresh = () => this.queueRefresh();
    room
      .on(sdk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === sdk.Track.Kind.Audio) {
          if (track instanceof sdk.RemoteAudioTrack) this.addBoost(track);
          const el = track.attach();
          this.sinkHost.append(el);
          this.applyVolumesFor(participant);
        }
        refresh();
      })
      .on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === sdk.Track.Kind.Audio) track.detach().forEach((el) => el.remove());
        refresh();
      })
      .on(sdk.RoomEvent.ParticipantConnected, () => {
        this.host.onSound('join');
        refresh();
      })
      .on(sdk.RoomEvent.ParticipantDisconnected, () => {
        this.host.onSound('leave');
        refresh();
      })
      .on(sdk.RoomEvent.TrackPublished, refresh)
      .on(sdk.RoomEvent.TrackUnpublished, refresh)
      .on(sdk.RoomEvent.TrackMuted, refresh)
      .on(sdk.RoomEvent.TrackUnmuted, refresh)
      .on(sdk.RoomEvent.LocalTrackPublished, refresh)
      .on(sdk.RoomEvent.LocalTrackUnpublished, refresh)
      .on(sdk.RoomEvent.ParticipantAttributesChanged, refresh)
      .on(sdk.RoomEvent.ParticipantNameChanged, refresh)
      .on(sdk.RoomEvent.ActiveSpeakersChanged, refresh)
      .on(sdk.RoomEvent.ConnectionQualityChanged, (_q, p) => {
        if (p.isLocal) refresh();
      })
      .on(sdk.RoomEvent.Reconnecting, () => this.set({ status: 'reconnecting' }))
      .on(sdk.RoomEvent.Reconnected, () => {
        this.set({ status: 'connected' });
        refresh();
      })
      .on(sdk.RoomEvent.Disconnected, (reason) => {
        if (room !== this.room) return;
        if (this.moving) {
          this.removedWhileMoving = true;
          return;
        }
        const closingInStatus = this.snap.status;
        this.close();
        if (closingInStatus === 'joining') return;
        if (reason === sdk.DisconnectReason.DUPLICATE_IDENTITY) this.host.onProblem('tab_taken');
        else if (reason === sdk.DisconnectReason.PARTICIPANT_REMOVED) this.host.onProblem('removed');
        else if (reason !== sdk.DisconnectReason.CLIENT_INITIATED) this.host.onProblem('lost');
      });
  }

  private applyVolumesFor(p: RemoteParticipant): void {
    const v = this.snap.deafened ? 0 : this.host.volumeOf(p.identity);
    p.setVolume(Math.min(v, 1), sdk.Track.Source.Microphone);
    p.setVolume(Math.min(v, 1), sdk.Track.Source.ScreenShareAudio);
    for (const pub of p.audioTrackPublications.values()) {
      const boost = pub.track && this.boosts.get(pub.track as RemoteAudioTrack);
      if (boost) boost.gain.value = Math.max(v, 1);
    }
  }

  /**
   * Room above 100% for a track, with soft clipping after it so that raising a
   * loud voice does not distort harshly. The SDK's own volume comes last and
   * stays at 100% or below.
   */
  private addBoost(track: RemoteAudioTrack): void {
    const ctx = this.audio;
    if (!ctx || this.boosts.has(track)) return;
    const boost = ctx.createGain();
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = '2x';
    this.boosts.set(track, boost);
    track.setWebAudioPlugins([boost, clip]);
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  private refresh(): void {
    const room = this.room;
    if (!room || this.snap.status === 'idle') return;
    const local = room.localParticipant;
    const everyone: LkParticipant[] = [local, ...room.remoteParticipants.values()];
    const people = everyone
      .filter((p) => p.identity)
      .map<VoicePerson>((p) => ({
        id: p.identity,
        visitorId: identityId(p.identity),
        name: p.name || identityId(p.identity),
        local: p === local,
        muted: !p.isMicrophoneEnabled,
        deafened: isDeafened(p),
        sharing: p.isScreenShareEnabled,
        shareTrackId: p.getTrackPublication(sdk.Track.Source.ScreenShare)?.track?.mediaStreamTrack.id ?? '',
        camera: p.isCameraEnabled,
        cameraTrackId: p.getTrackPublication(sdk.Track.Source.Camera)?.track?.mediaStreamTrack.id ?? '',
      }));

    const shares = new Set(people.filter((p) => p.sharing && !p.local).map((p) => p.id));
    for (const id of shares) if (!this.knownShares.has(id)) this.host.onSound('share');
    this.knownShares = shares;

    this.syncMeters(everyone);
    const q = local.connectionQuality;
    this.set({
      people,
      speakers: room.activeSpeakers.map((p) => p.identity),
      muted: !local.isMicrophoneEnabled,
      sharing: local.isScreenShareEnabled,
      camera: local.isCameraEnabled,
      quality: q === sdk.ConnectionQuality.Excellent || q === sdk.ConnectionQuality.Good ? 'good' : q === sdk.ConnectionQuality.Poor ? 'poor' : q === sdk.ConnectionQuality.Lost ? 'lost' : 'unknown',
    });
  }

  /** One level meter per audible microphone, replaced when its track changes. */
  private syncMeters(everyone: LkParticipant[]): void {
    const ctx = this.audio;
    if (!ctx) return;
    const wanted = new Map<string, MediaStreamTrack>();
    for (const p of everyone) {
      // Feeding a processed stream back into its own context can silence the capture graph.
      if (p === this.room?.localParticipant && this.micGainProcessor()) continue;
      const pub = p.getTrackPublication(sdk.Track.Source.Microphone) as LocalTrackPublication | undefined;
      const mst = pub?.track?.mediaStreamTrack;
      if (mst && !pub?.isMuted) wanted.set(p.identity, mst);
    }
    for (const [id, meter] of this.meters) {
      if (wanted.get(id)?.id !== meter.trackId) {
        meter.source.disconnect();
        this.meters.delete(id);
      }
    }
    for (const [id, mst] of wanted) {
      if (this.meters.has(id)) continue;
      const source = ctx.createMediaStreamSource(new MediaStream([mst]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.meters.set(id, { trackId: mst.id, source, analyser, buf: new Float32Array(analyser.fftSize) });
    }
  }

  private stopTracks(room: Room): void {
    for (const publication of room.localParticipant.trackPublications?.values() ?? []) publication.track?.stop();
  }

  private teardownRoom(): void {
    this.micTestMuting.reset();
    const room = this.room;
    this.room = null;
    for (const meter of this.meters.values()) meter.source.disconnect();
    this.meters.clear();
    this.sinkHost.replaceChildren();
    if (room) this.disconnectRoom(room);
  }

  private disconnectRoom(room: Room): void {
    this.stopTracks(room);
    room.removeAllListeners();
    void room.disconnect();
  }

  private close(): void {
    this.operation++;
    this.moving = false;
    this.teardownRoom();
    this.knownShares.clear();
    this.snap = { ...idleVoice };
    this.host.onChange(this.snap);
  }

  private set(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.host.onChange(this.snap);
  }
}
