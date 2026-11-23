import type {
  AudioCaptureOptions,
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
import { JoinAttempt } from './join';
import { loudness } from './meter';
import { NativeAudio, usesNativeAudio } from './nativeAudio';
import { emitReaction, encodeReaction, parseReaction, REACTION_ATTRIBUTE, type ReactionId } from './reactions';
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

interface JoiningMic {
  attempt: JoinAttempt;
  problem?: 'mic_missing' | 'mic_denied';
}

interface MicIntent {
  room: Room;
  enabled: boolean;
  revision: number;
  pending?: Promise<void>;
  startingTrack?: LocalTrack;
  track?: LocalTrack;
  deviceConstraint?: ConstrainDOMString;
  selectedDeviceId?: string;
  replace?: boolean;
  joining?: JoiningMic;
}

let sdk: Pick<typeof import('livekit-client'), 'ConnectionQuality' | 'DisconnectReason' | 'LocalTrack' | 'RemoteAudioTrack' | 'Room' | 'RoomEvent' | 'Track' | 'TrackEvent'>;
let loading: Promise<void> | null = null;

/** Warm the SDK after the interface paints; joining can also start or await it. */
export function preloadVoice(): Promise<void> {
  return loading ??= import('livekit-client').then(
    ({ ConnectionQuality, DisconnectReason, LocalTrack, RemoteAudioTrack, Room, RoomEvent, Track, TrackEvent }) => {
      sdk = { ConnectionQuality, DisconnectReason, LocalTrack, RemoteAudioTrack, Room, RoomEvent, Track, TrackEvent };
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
  private readonly nativePlayback = usesNativeAudio();
  private playback: NativeAudio | null = null;
  private mutedBeforeDeaf = false;
  private mic: MicIntent | null = null;
  private refreshQueued = false;
  /** A refused admission keeps the current room intact. */
  private moveFrom: 'connected' | 'reconnecting' | 'disconnected' | null = null;
  private pendingJoin: JoinAttempt | null = null;
  private knownShares = new Set<string>();
  private cameraStarts = 0;
  /** What each remote track is raised by above 100%. */
  private boosts = new WeakMap<RemoteAudioTrack, GainNode>();
  private reactionSeq = 0;

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
    if (this.pendingJoin) return;
    const attempt = new JoinAttempt();
    this.pendingJoin = attempt;
    const previous = this.snap;
    const firstJoin = previous.roomId === null;
    this.moveFrom = previous.status === 'connected' || previous.status === 'reconnecting' ? previous.status : null;
    try {
      this.set({ status: 'joining', joiningRoomId: roomId });
      const connected = await attempt.waitFor(this.connect(attempt, roomId));
      if (!connected || this.pendingJoin !== attempt) return;
      const { room, startMuted, keepCamera } = connected;
      let joiningMic: JoiningMic | undefined;
      if (firstJoin && !this.snap.deafened && !startMuted && !this.host.pushToTalk()) {
        joiningMic = { attempt };
        // The connection deadline does not include the browser permission prompt.
        await attempt.waitFor(this.requestMic(room, true, joiningMic));
        if (this.pendingJoin !== attempt || this.room !== room) return;
      }
      const deafened = this.snap.deafened;
      this.knownShares.clear();
      const reconnecting = room.state === 'reconnecting' || room.state === 'signalReconnecting';
      const micProblem = joiningMic?.problem;
      const joined = {
        status: reconnecting ? 'reconnecting' : 'connected', roomId, joiningRoomId: null, joinedAt: performance.now(),
        muted: !room.localParticipant.isMicrophoneEnabled, listenOnly: micProblem !== undefined,
      } as const;
      if (firstJoin) this.refresh(joined);
      else this.set(joined);
      if (this.pendingJoin !== attempt) return;
      this.pendingJoin = null;
      if (deafened || (firstJoin && this.nativePlayback)) this.applyVolumes();
      if (firstJoin && !deafened) this.playback?.start();
      this.host.onSound('join');
      if (micProblem) this.host.onProblem(micProblem);
      if (deafened) {
        void room.localParticipant.setAttributes({ deafened: 'true' }).catch(() => {});
      }
      if (firstJoin) return;
      if (!deafened && !startMuted && !this.host.pushToTalk()) await this.requestMic(room, true);
      if (this.room !== room) return;
      // A first join never starts the camera.
      if (keepCamera) await this.enableCamera(room);
      this.refresh();
    } catch (err) {
      if (this.pendingJoin !== attempt) return;
      const timedOut = attempt.signal.aborted;
      this.finishFailedJoin();
      const code = err instanceof ApiError ? err.code : 'network';
      if (code === 'room_full' || code === 'voice_unavailable' || code === 'name_taken' || code === 'visitor_required') this.host.onProblem(code);
      else this.host.onProblem(code === 'media_failed' && !timedOut ? 'media_failed' : 'join_failed');
    }
  }

  private async connect(attempt: JoinAttempt, roomId: string) {
    // In the click's gesture, so that browsers let it start.
    this.audio ??= new AudioContext({ latencyHint: 'interactive' });
    void this.audio.resume().catch(() => {});
    await preloadVoice();
    if (attempt.signal.aborted) return null;
    const creds = await api.joinVoice(roomId, attempt.signal);
    if (attempt.signal.aborted) return null;
    const startMuted = this.host.pushToTalk() || (this.moveFrom ? this.snap.muted && !this.snap.listenOnly : this.host.joinMuted());
    const keepCamera = this.snap.camera;
    this.moveFrom = null;
    this.teardownRoom();
    if (this.snap.audioBlocked) this.set({ audioBlocked: false });

    let room: Room | null = null;
    try {
      const speakerId = this.host.speakerId();
      room = new sdk.Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: this.micOptions(),
        audioOutput: speakerId ? { deviceId: speakerId } : undefined,
        // On iOS an interrupted AudioContext must not gate voice playback.
        webAudioMix: this.nativePlayback ? false : { audioContext: this.audio ?? undefined },
      });
      this.room = room;
      this.bind(room);
      await room.connect(creds.url, creds.token);
      if (this.room === room) {
        // A native element may leave play() pending until it receives media or a tap.
        if (this.nativePlayback) {
          if (this.snap.roomId !== null && !this.snap.deafened) this.playback?.start();
        } else {
          await room.startAudio().catch(() => {});
        }
      }
    } catch (error) {
      if (room && this.room !== room) this.disconnectRoom(room);
      throw new ApiError(0, 'media_failed', String(error));
    }
    if (this.room === room) return { room, startMuted, keepCamera };
    this.disconnectRoom(room);
    return null;
  }

  cancelJoin(): void {
    if (!this.pendingJoin) return;
    this.finishFailedJoin();
  }

  private finishFailedJoin(): void {
    if (this.room && this.moveFrom && this.moveFrom !== 'disconnected') {
      const previous = this.moveFrom;
      this.pendingJoin?.cancel();
      this.pendingJoin = null;
      this.moveFrom = null;
      this.set({ status: previous, joiningRoomId: null });
    } else {
      this.close();
    }
  }

  async leave(): Promise<void> {
    if (this.snap.status === 'idle') return;
    if (this.snap.roomId !== null) this.host.onSound('leave');
    this.close();
  }

  /** Ends voice without a sound: the access ended. */
  end(): void {
    this.close();
  }

  setMuted(muted: boolean): Promise<void> {
    return this.room ? this.requestMic(this.room, !muted) : Promise.resolve();
  }

  async toggleMute(): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (this.snap.deafened) await this.setDeafened(false);
    const enabled = this.mic?.pending ? this.mic.enabled : room.localParticipant.isMicrophoneEnabled;
    await this.requestMic(room, !enabled);
  }

  react(id: ReactionId): void {
    const room = this.room;
    if (!room || this.snap.status !== 'connected') return;
    const local = room.localParticipant;
    if (!emitReaction(local.identity, id)) return;
    void local.setAttributes({ [REACTION_ATTRIBUTE]: encodeReaction(id, ++this.reactionSeq) }).catch(() => {});
  }

  async toggleDeafen(): Promise<void> {
    await this.setDeafened(!this.snap.deafened);
  }

  private async setDeafened(on: boolean): Promise<void> {
    const room = this.room;
    if (!room || on === this.snap.deafened) return;
    const local = room.localParticipant;
    if (on) this.mutedBeforeDeaf = !(this.mic?.pending ? this.mic.enabled : local.isMicrophoneEnabled);
    this.set({ deafened: on, audioBlocked: on ? false : this.snap.audioBlocked });
    if (on) this.playback?.resetRoomBlock();
    this.applyVolumes();
    void local.setAttributes({ deafened: on ? 'true' : 'false' }).catch(() => {});
    if (on || (!this.mutedBeforeDeaf && !this.host.pushToTalk())) await this.requestMic(room, !on);
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
    if (this.snap.camera) {
      await this.disableCamera(room);
      if (this.room === room) this.refresh();
    } else await this.enableCamera(room);
  }

  /** Puts changed camera quality to use: encodings are fixed when a track is published. */
  async restartCamera(): Promise<void> {
    const room = this.room;
    if (!room || !this.snap.camera) return;
    await this.enableCamera(room, true);
  }

  async setCamera(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('videoinput', deviceId).catch(() => {});
  }

  private async enableCamera(room: Room, restart = false): Promise<void> {
    if (this.room !== room) return;
    this.cameraStarts++;
    try {
      if (this.cameraStarts === 1) this.set({ cameraStarting: true });
      if (restart) await this.disableCamera(room);
      if (this.room !== room) return;
      const { capture, publish } = cameraOptions(this.host.cameraSettings());
      await room.localParticipant.setCameraEnabled(true, capture, publish);
      if (this.room !== room) this.stopTracks(room);
    } catch (err) {
      if (this.room !== room) { this.stopTracks(room); return; }
      const name = (err as Error).name;
      this.host.onProblem(name === 'NotAllowedError' ? 'camera_denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'camera_missing' : 'camera_failed');
    } finally {
      if (this.room === room && --this.cameraStarts === 0) this.refresh();
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

  setMic(deviceId: string): Promise<void> {
    const room = this.room;
    if (!room) return Promise.resolve();
    this.micIntent(room).selectedDeviceId = deviceId;
    if (this.snap.listenOnly) this.set({ listenOnly: false });
    return this.replaceMic();
  }

  async setSpeaker(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audiooutput', deviceId).catch(() => {});
  }

  applyMicProcessing(): Promise<void> {
    return this.replaceMic();
  }

  private micOptions(): AudioCaptureOptions {
    const selected = this.mic?.selectedDeviceId;
    const deviceId = selected ? { exact: selected } : { ideal: (selected ?? this.host.micId()) || 'default' };
    return { ...this.host.micProcessing(), deviceId };
  }

  private micIntent(room: Room): MicIntent {
    return this.mic ??= { room, enabled: room.localParticipant.isMicrophoneEnabled, revision: 0 };
  }

  private replaceMic(): Promise<void> {
    const room = this.room;
    if (!room) return Promise.resolve();
    const intent = this.micIntent(room);
    if (!intent.pending) intent.enabled = room.localParticipant.isMicrophoneEnabled;
    intent.replace = true;
    intent.revision++;
    this.stopStartingMic(intent);
    return this.queueMic(intent);
  }

  private requestMic(room: Room, enabled: boolean, joining?: JoiningMic): Promise<void> {
    if (this.room !== room || (enabled && !this.canEnableMic(room, joining))) return Promise.resolve();
    const intent = this.micIntent(room);
    if (joining) intent.joining = joining;
    if (intent.enabled !== enabled) {
      intent.enabled = enabled;
      intent.revision++;
    }
    if (!enabled) {
      this.stopStartingMic(intent);
      if (intent.track && !intent.track.isMuted) void this.setMicTrackMuted(intent.track, true).catch(() => {});
    }
    return this.queueMic(intent);
  }

  private queueMic(intent: MicIntent): Promise<void> {
    return intent.pending ??= Promise.resolve().then(() => this.settleMic(intent));
  }

  private canStartMic(intent: MicIntent, revision: number): boolean {
    return this.room === intent.room && intent.enabled && intent.revision === revision
      && this.canEnableMic(intent.room, intent.joining);
  }

  private canEnableMic(room: Room, joining?: JoiningMic): boolean {
    return !this.snap.deafened && (this.snap.status === 'connected'
      || (joining?.attempt === this.pendingJoin && room.state === 'connected'));
  }

  private stopStartingMic(intent: MicIntent): void {
    const track = intent.startingTrack;
    intent.startingTrack = undefined;
    track?.stop();
  }

  private setMicTrackMuted(track: LocalTrack, muted: boolean): Promise<LocalTrack> {
    // The base methods update the capture and emit LiveKit's mute events synchronously.
    // LocalAudioTrack.unmute can wait on its lock and reopen capture after a release.
    return (muted ? sdk.LocalTrack.prototype.mute : sdk.LocalTrack.prototype.unmute).call(track);
  }

  private async startMic(intent: MicIntent, revision: number, previous?: LocalTrack): Promise<void> {
    const local = intent.room.localParticipant;
    const options = this.micOptions();
    if (previous) {
      const deviceId = previous.constraints.deviceId;
      // LiveKit may have selected another device. A string would give it a
      // second getUserMedia attempt without checking the current intent.
      if (!intent.replace && deviceId) options.deviceId = typeof deviceId === 'string' ? { ideal: deviceId } : deviceId;
      await this.setMicTrackMuted(previous, true);
      previous.stop();
      intent.track = undefined;
      await local.unpublishTrack(previous, false);
      if (!this.canStartMic(intent, revision)) return;
    }
    const [track] = await local.createTracks({ audio: options });
    if (!track) throw new Error('Microphone track unavailable');
    if (!this.canStartMic(intent, revision)) { track.stop(); return; }

    intent.startingTrack = track;
    let keepTrack = false;
    try {
      // LiveKit can start sending before publishTrack resolves. Signal and send mute
      // until both publication and the original request are confirmed.
      await this.setMicTrackMuted(track, true);
      if (!this.canStartMic(intent, revision)) return;
      await local.publishTrack(track);
      if (!this.canStartMic(intent, revision)) return;
      if (track.mediaStreamTrack.readyState !== 'live') throw new Error('Microphone track ended during publication');
      await this.setMicTrackMuted(track, false);
      keepTrack = this.canStartMic(intent, revision);
      if (keepTrack) {
        intent.track = track;
        intent.deviceConstraint = track.constraints.deviceId;
        intent.replace = false;
      }
    } finally {
      if (intent.startingTrack === track) {
        if (keepTrack) intent.startingTrack = undefined;
        else this.stopStartingMic(intent);
      }
      if (!keepTrack && this.room === intent.room && local.getTrackPublication(sdk.Track.Source.Microphone)?.track === track) {
        await local.unpublishTrack(track, false);
      }
    }
  }

  private async settleMic(intent: MicIntent): Promise<void> {
    const { room } = intent;
    const local = room.localParticipant;
    try {
      while (this.room === room) {
        const { enabled, revision } = intent;
        const track = local.getTrackPublication(sdk.Track.Source.Microphone)?.track;
        if (enabled && !this.canStartMic(intent, revision)) break;
        try {
          if (!enabled) {
            if (track && !track.isMuted) await this.setMicTrackMuted(track, true);
          } else if (!track || intent.replace || track.mediaStreamTrack.readyState !== 'live' || track.constraints.deviceId !== intent.deviceConstraint) {
            await this.startMic(intent, revision, track);
          } else if (track.isMuted) {
            await this.setMicTrackMuted(track, false);
          }
          if (this.room !== room) { this.stopTracks(room); return; }
          if (this.canStartMic(intent, revision) && local.isMicrophoneEnabled && this.snap.listenOnly) this.set({ listenOnly: false });
        } catch (err) {
          if (this.room !== room) { this.stopTracks(room); return; }
          if (enabled && this.canStartMic(intent, revision)) {
            intent.enabled = false;
            const problem = (err as Error | undefined)?.name === 'NotFoundError' ? 'mic_missing' : 'mic_denied';
            if (intent.joining) intent.joining.problem = problem;
            else {
              this.set({ listenOnly: true });
              this.host.onProblem(problem);
            }
          }
        }
        if (revision === intent.revision) break;
      }
    } finally {
      intent.pending = undefined;
      intent.joining = undefined;
    }
    if (this.room === room) this.refresh();
  }

  retryAudio(): void {
    this.playback?.retry(false, true);
  }

  private bind(room: Room): void {
    const refresh = () => this.queueRefresh();
    const reconnecting = () => {
      if (room !== this.room) return;
      if (this.host.pushToTalk() || (this.mic?.pending && this.mic.enabled && !room.localParticipant.isMicrophoneEnabled)) {
        void this.requestMic(room, false);
      }
      if (this.moveFrom) this.moveFrom = 'reconnecting';
      else if (!this.pendingJoin) this.set({ status: 'reconnecting' });
    };
    if (this.nativePlayback) {
      const canRecover = () => this.room === room
        && (this.snap.status === 'connected' || this.moveFrom === 'connected')
        && !document.hidden && !this.snap.deafened;
      this.playback = new NativeAudio(room, this.sinkHost, canRecover, (blocked) => {
        const audioBlocked = blocked && !this.snap.deafened;
        if (this.snap.audioBlocked !== audioBlocked) this.set({ audioBlocked });
      });
    }
    room
      .on(sdk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (room !== this.room) return;
        if (track.kind === sdk.Track.Kind.Audio) {
          if (!this.nativePlayback) {
            if (track instanceof sdk.RemoteAudioTrack) this.addBoost(track);
            this.sinkHost.append(track.attach());
          }
          this.applyVolumesFor(participant);
        }
        refresh();
      })
      .on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
        if (room !== this.room) return;
        if (track.kind === sdk.Track.Kind.Audio) this.detachAudio(track);
        refresh();
      })
      .on(sdk.RoomEvent.AudioPlaybackStatusChanged, (playing) => {
        if (room === this.room) this.playback?.sdkStatus(playing);
      })
      .on(sdk.RoomEvent.ParticipantConnected, () => {
        if (this.snap.roomId !== null) this.host.onSound('join');
        refresh();
      })
      .on(sdk.RoomEvent.ParticipantDisconnected, () => {
        if (this.snap.roomId !== null) this.host.onSound('leave');
        refresh();
      })
      .on(sdk.RoomEvent.TrackPublished, refresh)
      .on(sdk.RoomEvent.TrackUnpublished, refresh)
      .on(sdk.RoomEvent.TrackMuted, refresh)
      .on(sdk.RoomEvent.TrackUnmuted, refresh)
      .on(sdk.RoomEvent.LocalTrackPublished, refresh)
      .on(sdk.RoomEvent.LocalTrackUnpublished, refresh)
      .on(sdk.RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
        const reaction = !participant.isLocal && REACTION_ATTRIBUTE in changed && parseReaction(changed[REACTION_ATTRIBUTE]);
        if (reaction) emitReaction(participant.identity, reaction);
        refresh();
      })
      .on(sdk.RoomEvent.ParticipantNameChanged, refresh)
      .on(sdk.RoomEvent.ActiveSpeakersChanged, refresh)
      .on(sdk.RoomEvent.ConnectionQualityChanged, (_q, p) => {
        if (p.isLocal) refresh();
      })
      .on(sdk.RoomEvent.Reconnecting, reconnecting)
      .on(sdk.RoomEvent.SignalReconnecting, reconnecting)
      .on(sdk.RoomEvent.Reconnected, () => {
        if (room !== this.room) return;
        if (this.moveFrom) this.moveFrom = 'connected';
        else if (!this.pendingJoin) this.set({ status: 'connected' });
        this.playback?.retry();
        if (this.mic?.replace && room.localParticipant.isMicrophoneEnabled) void this.requestMic(room, true);
        refresh();
      })
      .on(sdk.RoomEvent.Disconnected, (reason) => {
        if (room !== this.room) return;
        if (this.moveFrom) {
          this.moveFrom = 'disconnected';
          return;
        }
        const joining = this.pendingJoin !== null;
        this.close();
        if (joining) { this.host.onProblem('media_failed'); return; }
        if (reason === sdk.DisconnectReason.DUPLICATE_IDENTITY) this.host.onProblem('tab_taken');
        else if (reason === sdk.DisconnectReason.PARTICIPANT_REMOVED) this.host.onProblem('removed');
        else if (reason !== sdk.DisconnectReason.CLIENT_INITIATED) this.host.onProblem('lost');
      });
  }

  private applyVolumesFor(p: RemoteParticipant): void {
    const v = this.snap.deafened ? 0 : this.host.volumeOf(p.identity);
    const trackVolume = this.nativePlayback && v > 0 ? 1 : Math.min(v, 1);
    p.setVolume(trackVolume, sdk.Track.Source.Microphone);
    p.setVolume(trackVolume, sdk.Track.Source.ScreenShareAudio);
    for (const pub of p.audioTrackPublications.values()) {
      const track = pub.track;
      if (!track) continue;
      if (this.nativePlayback) {
        // iOS ignores element volume. LiveKit's foreground recovery can also unmute
        // attached elements, so detach them altogether at zero/deafened.
        if (v === 0) this.detachAudio(track);
        // First-join capture can interrupt Safari's audio output while routing switches.
        else if (this.snap.roomId !== null && !track.attachedElements.length) {
          const element = track.attach();
          const playback = this.playback;
          playback?.watch(element, (retry) => {
            const detached = (sink: HTMLMediaElement) => {
              if (sink !== element) return;
              playback.unwatch(element);
              element.remove();
            };
            track.on(sdk.TrackEvent.AudioPlaybackFailed, retry);
            track.on(sdk.TrackEvent.ElementDetached, detached);
            return () => {
              track.off(sdk.TrackEvent.AudioPlaybackFailed, retry);
              track.off(sdk.TrackEvent.ElementDetached, detached);
            };
          });
          this.sinkHost.append(element);
        }
        continue;
      }
      const boost = this.boosts.get(track as RemoteAudioTrack);
      if (boost) boost.gain.value = Math.max(v, 1);
    }
  }

  private detachAudio(track: Track): void {
    for (const element of track.attachedElements) this.playback?.unwatch(element);
    track.detach().forEach((el) => el.remove());
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

  private refresh(joined?: Partial<VoiceSnapshot>): void {
    const room = this.room;
    if (!room || (this.snap.roomId === null && !joined)) return;
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
    if (!joined) {
      for (const id of shares) {
        if (!this.knownShares.has(id)) this.host.onSound('share');
      }
    }
    this.knownShares = shares;

    this.syncMeters(everyone);
    const q = local.connectionQuality;
    this.set({
      people,
      speakers: room.activeSpeakers.map((p) => p.identity),
      muted: !local.isMicrophoneEnabled,
      sharing: local.isScreenShareEnabled,
      camera: local.isCameraEnabled,
      cameraStarting: this.cameraStarts > 0,
      quality: q === sdk.ConnectionQuality.Excellent || q === sdk.ConnectionQuality.Good ? 'good' : q === sdk.ConnectionQuality.Poor ? 'poor' : q === sdk.ConnectionQuality.Lost ? 'lost' : 'unknown',
      ...joined,
    });
  }

  /** One level meter per audible microphone, replaced when its track changes. */
  private syncMeters(everyone: LkParticipant[]): void {
    const ctx = this.audio;
    if (!ctx) return;
    const wanted = new Map<string, MediaStreamTrack>();
    for (const p of everyone) {
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
    const room = this.room;
    this.room = null;
    this.cameraStarts = 0;
    if (this.mic) this.stopStartingMic(this.mic);
    this.mic = null;
    this.playback?.close();
    this.playback = null;
    for (const meter of this.meters.values()) meter.source.disconnect();
    this.meters.clear();
    if (room && this.nativePlayback) {
      // Removing an audio element from the DOM doesn't stop it. LiveKit disconnects asynchronously.
      for (const participant of room.remoteParticipants.values()) {
        for (const { track } of participant.audioTrackPublications.values()) track?.detach();
      }
    }
    this.sinkHost.replaceChildren();
    if (room) this.disconnectRoom(room);
  }

  private disconnectRoom(room: Room): void {
    this.stopTracks(room);
    room.removeAllListeners();
    void room.disconnect();
  }

  private close(): void {
    this.pendingJoin?.cancel();
    this.pendingJoin = null;
    this.moveFrom = null;
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
