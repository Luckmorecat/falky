import {
  ConnectionQuality,
  DisconnectReason,
  type LocalTrackPublication,
  type Participant as LkParticipant,
  RemoteAudioTrack,
  type RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type VideoTrack,
} from 'livekit-client';
import { api, ApiError } from '../api/client';
import { softClipCurve } from './softclip';

export interface VoicePerson {
  id: string;
  name: string;
  local: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  /** The shared screen's track once it can be shown; it arrives after `sharing`. */
  shareTrackId: string;
}

export interface VoiceSnapshot {
  status: 'idle' | 'joining' | 'connected' | 'reconnecting';
  /** The room whose voice this is. While moving, still the previous one. */
  roomId: string | null;
  joiningRoomId: string | null;
  /** When this room's voice was joined, on the performance clock. */
  joinedAt: number;
  people: VoicePerson[];
  /** Visitor IDs of who is talking now. */
  speakers: string[];
  muted: boolean;
  deafened: boolean;
  /** In voice without a microphone: refused, or none exists. */
  listenOnly: boolean;
  sharing: boolean;
  quality: 'good' | 'poor' | 'lost' | 'unknown';
}

export const idleVoice: VoiceSnapshot = {
  status: 'idle', roomId: null, joiningRoomId: null, joinedAt: 0, people: [], speakers: [],
  muted: false, deafened: false, listenOnly: false, sharing: false, quality: 'unknown',
};

export type VoiceProblem =
  | 'room_full' | 'voice_unavailable' | 'name_taken' | 'visitor_required' | 'join_failed' | 'media_failed'
  | 'tab_taken' | 'removed' | 'lost' | 'mic_denied' | 'mic_missing' | 'share_failed';

export type VoiceSound = 'join' | 'leave' | 'share';

export interface VoiceHost {
  onChange(snapshot: VoiceSnapshot): void;
  onProblem(problem: VoiceProblem): void;
  onSound(sound: VoiceSound): void;
  micId(): string;
  speakerId(): string;
  volumeOf(visitorId: string): number;
}

interface Meter {
  trackId: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

const isDeafened = (p: LkParticipant) => p.attributes.deafened === 'true';

/** One visitor's connection to one room's voice at a time, over LiveKit. */
export class VoiceSession {
  private room: Room | null = null;
  private snap: VoiceSnapshot = idleVoice;
  private audio: AudioContext | null = null;
  private meters = new Map<string, Meter>();
  private readonly sinkHost: HTMLElement;
  private mutedBeforeDeaf = false;
  private refreshQueued = false;
  /** Set while asking the server to move us, which also removes us from the old room. */
  private moving = false;
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

  /** Joins a room's voice. The server moves the visitor out of any other room. */
  async join(roomId: string): Promise<void> {
    if (this.snap.status === 'joining') return;
    // In the click's gesture, so that browsers let it start.
    this.audio ??= new AudioContext({ latencyHint: 'interactive' });
    void this.audio.resume();
    const deafened = this.snap.deafened;
    const startMuted = this.snap.status !== 'idle' && this.snap.muted && !this.snap.listenOnly;
    this.set({ status: 'joining', joiningRoomId: roomId });
    this.moving = true;
    this.removedWhileMoving = false;
    let creds;
    try {
      creds = await api.joinVoice(roomId);
    } catch (err) {
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
    this.moving = false;
    this.teardownRoom();

    const speakerId = this.host.speakerId();
    const micId = this.host.micId();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: micId || undefined },
      audioOutput: speakerId ? { deviceId: speakerId } : undefined,
      // Through Web Audio, because an audio element cannot play above 100%.
      webAudioMix: { audioContext: this.audio },
    });
    this.room = room;
    this.bind(room);
    try {
      await room.connect(creds.url, creds.token);
    } catch {
      if (this.room === room) {
        this.close();
        this.host.onProblem('media_failed');
      }
      return;
    }
    if (this.room !== room) return;
    await room.startAudio().catch(() => {});
    this.knownShares.clear();
    this.set({ status: 'connected', roomId, joiningRoomId: null, joinedAt: performance.now(), deafened, listenOnly: false });
    this.host.onSound('join');
    if (deafened) {
      this.applyVolumes();
      void room.localParticipant.setAttributes({ deafened: 'true' }).catch(() => {});
    }
    if (!deafened && !startMuted) await this.enableMic(room);
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
      await room.localParticipant.setScreenShareEnabled(on, { audio: true });
    } catch (err) {
      // Backing out of the browser's picker is not a failure.
      if ((err as Error).name !== 'NotAllowedError') this.host.onProblem('share_failed');
    }
    this.refresh();
  }

  /** The screen a participant shows, to attach to a video element. */
  shareTrack(visitorId: string): VideoTrack | null {
    const room = this.room;
    if (!room) return null;
    const p: LkParticipant | undefined = room.localParticipant.identity === visitorId ? room.localParticipant : room.remoteParticipants.get(visitorId);
    return (p?.getTrackPublication(Track.Source.ScreenShare)?.track as VideoTrack | undefined) ?? null;
  }

  /** How loud a participant is now, from 0 to 1. */
  level(visitorId: string): number {
    const meter = this.meters.get(visitorId);
    if (!meter) return 0;
    meter.analyser.getFloatTimeDomainData(meter.buf);
    let sum = 0;
    for (const v of meter.buf) sum += v * v;
    // Speech sits low on a linear scale; two roots spread it across the range.
    return Math.max(0, Math.min(1, Math.sqrt(Math.sqrt(sum / meter.buf.length)) * 1.75 - 0.12));
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

  private async enableMic(room: Room): Promise<void> {
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      this.set({ listenOnly: false });
    } catch (err) {
      this.set({ listenOnly: true });
      this.host.onProblem((err as Error).name === 'NotFoundError' ? 'mic_missing' : 'mic_denied');
    }
  }

  private bind(room: Room): void {
    const refresh = () => this.queueRefresh();
    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === Track.Kind.Audio) {
          if (track instanceof RemoteAudioTrack) this.addBoost(track);
          const el = track.attach();
          this.sinkHost.append(el);
          this.applyVolumesFor(participant);
        }
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
        refresh();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        this.host.onSound('join');
        refresh();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        this.host.onSound('leave');
        refresh();
      })
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.ParticipantNameChanged, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ConnectionQualityChanged, (_q, p) => {
        if (p.isLocal) refresh();
      })
      .on(RoomEvent.Reconnecting, () => this.set({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.set({ status: 'connected' });
        refresh();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== this.room) return;
        if (this.moving) {
          this.removedWhileMoving = true;
          return;
        }
        const closingInStatus = this.snap.status;
        this.close();
        if (closingInStatus === 'joining') return;
        if (reason === DisconnectReason.DUPLICATE_IDENTITY) this.host.onProblem('tab_taken');
        else if (reason === DisconnectReason.PARTICIPANT_REMOVED) this.host.onProblem('removed');
        else if (reason !== DisconnectReason.CLIENT_INITIATED) this.host.onProblem('lost');
      });
  }

  private applyVolumesFor(p: RemoteParticipant): void {
    const v = this.snap.deafened ? 0 : this.host.volumeOf(p.identity);
    p.setVolume(Math.min(v, 1), Track.Source.Microphone);
    p.setVolume(Math.min(v, 1), Track.Source.ScreenShareAudio);
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
        name: p.name || p.identity,
        local: p === local,
        muted: !p.isMicrophoneEnabled,
        deafened: isDeafened(p),
        sharing: p.isScreenShareEnabled,
        shareTrackId: p.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack.id ?? '',
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
      quality: q === ConnectionQuality.Excellent || q === ConnectionQuality.Good ? 'good' : q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'unknown',
    });
  }

  /** One level meter per audible microphone, replaced when its track changes. */
  private syncMeters(everyone: LkParticipant[]): void {
    const ctx = this.audio;
    if (!ctx) return;
    const wanted = new Map<string, MediaStreamTrack>();
    for (const p of everyone) {
      const pub = p.getTrackPublication(Track.Source.Microphone) as LocalTrackPublication | undefined;
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

  private teardownRoom(): void {
    const room = this.room;
    this.room = null;
    for (const meter of this.meters.values()) meter.source.disconnect();
    this.meters.clear();
    this.sinkHost.replaceChildren();
    if (room) {
      room.removeAllListeners();
      void room.disconnect();
    }
  }

  private close(): void {
    this.moving = false;
    this.teardownRoom();
    this.knownShares.clear();
    this.snap = idleVoice;
    this.host.onChange(this.snap);
  }

  private set(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.host.onChange(this.snap);
  }
}
