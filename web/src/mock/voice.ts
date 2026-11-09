import { PendingLeaves } from '../voice/pendingLeaves';
import { api, ApiError } from '../api/client';
import { idleVoice, type VoiceHost, type VoiceSnapshot, type VoiceClient, type ShareTrack } from '../voice/types';
import { SyntheticShare } from './share';
import { mockAction, mockState, refreshMockState, subscribeMockState } from './state';

/** Mock media needs no SDK download. */
export async function preloadVoice(): Promise<void> {}

/** Simulates media only. Joining and room moves still use the public HTTP API. */
export class VoiceSession implements VoiceClient {
  private grantId: string | null = null;
  private joining: { leaveRequested: boolean } | null = null;
  private readonly leaves: PendingLeaves;
  private tracks = new Map<string, SyntheticShare>();
  private cameraPicture: SyntheticShare | null = null;
  private snap: VoiceSnapshot = idleVoice;
  private mutedBeforeDeaf = false;
  private operation = 0;
  private pending = false;
  private generation: number | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly host: VoiceHost) {
    this.leaves = new PendingLeaves(() => this.set({ pendingLeave: this.leaves.count }));
    this.unsubscribe = subscribeMockState(() => this.refresh());
  }
  get snapshot(): VoiceSnapshot { return this.snap; }

  async join(roomId: string): Promise<void> {
    if (this.pending) return;
    const initial = mockState();
    if (!initial) { this.host.onProblem('join_failed'); return; }
    const operation = ++this.operation;
    const intent = { leaveRequested: false };
    this.joining = intent;
    const generation = initial.generation;
    const previous = this.snap;
    const startMuted = previous.status === 'idle' ? this.host.joinMuted() : previous.muted && !previous.listenOnly;
    this.pending = true;
    this.set({ status: 'joining', joiningRoomId: roomId });
    try {
      const creds = await api.joinVoice(roomId);
      if (operation === this.operation) this.grantId = creds.grantId;
      if (operation !== this.operation) {
        if (intent.leaveRequested) await this.leaves.add(creds.grantId);
        else await this.release(generation, creds.grantId);
        return;
      }
      const state = await refreshMockState();
      if (operation !== this.operation) {
        if (intent.leaveRequested) await this.leaves.add(creds.grantId);
        else await this.release(generation, creds.grantId);
        return;
      }
      if (state.instanceId !== initial.instanceId || state.generation !== generation) return;
      this.joining = null;
      this.generation = generation;
      this.set({ status: 'connected', roomId, joiningRoomId: null, joinedAt: performance.now(), muted: startMuted || previous.deafened, deafened: previous.deafened, listenOnly: false, sharing: false });
      if (!startMuted && !previous.deafened) this.enableMic();
      this.host.onSound('join');
      this.refresh();
    } catch (error) {
      if (operation !== this.operation) return;
      this.snap = { ...previous, pendingLeave: this.leaves.count };
      this.host.onChange(this.snap);
      const code = error instanceof ApiError ? error.code : 'network';
      this.host.onProblem(code === 'room_full' || code === 'voice_unavailable' || code === 'name_taken' || code === 'visitor_required' ? code : 'join_failed');
    } finally {
      this.pending = false;
    }
  }

  async leave(): Promise<void> {
    if (this.snap.status !== 'idle') this.host.onSound('leave');
    if (this.joining) this.joining.leaveRequested = true;
    const pending = this.grantId ? this.leaves.add(this.grantId) : Promise.resolve();
    this.close();
    await pending;
  }
  end(): void {
    const generation = this.generation;
    const grantId = this.grantId;
    this.close();
    if (generation !== null && grantId) void this.release(generation, grantId);
  }
  dispose(): void { this.end(); this.unsubscribe(); this.leaves.dispose(); }

  async toggleMute(): Promise<void> {
    if (!this.snap.roomId) return;
    if (this.snap.deafened) await this.toggleDeafen();
    if (!this.snap.muted) this.set({ muted: true });
    else this.enableMic();
    this.refresh();
  }
  async toggleDeafen(): Promise<void> {
    if (!this.snap.roomId) return;
    if (!this.snap.deafened) {
      this.mutedBeforeDeaf = this.snap.muted;
      this.set({ deafened: true, muted: true });
    } else {
      this.set({ deafened: false });
      if (!this.mutedBeforeDeaf) this.enableMic();
    }
    this.refresh();
  }
  async toggleShare(): Promise<void> {
    if (!this.snap.roomId) return;
    if (!this.snap.sharing && mockState()?.faults.shareFailure) { this.host.onProblem('share_failed'); return; }
    this.set({ sharing: !this.snap.sharing });
    this.refresh();
  }
  shareTrack(visitorId: string): ShareTrack | null { return this.tracks.get(visitorId) ?? null; }
  async toggleCamera(): Promise<void> {
    if (!this.snap.roomId) return;
    this.set({ camera: !this.snap.camera });
    this.refresh();
  }
  async restartCamera(): Promise<void> {}
  async setCamera(_deviceId: string): Promise<void> {}
  cameraTrack(visitorId: string): ShareTrack | null {
    return visitorId === mockState()?.visitor?.id ? this.cameraPicture : null;
  }
  applyVolumes(): void {}
  async setMic(_deviceId: string): Promise<void> {}
  async setSpeaker(_deviceId: string): Promise<void> {}
  async applyMicProcessing(): Promise<void> {}

  level(visitorId: string): number {
    const person = this.snap.people.find((person) => person.id === visitorId);
    if (!person || person.muted || (!person.local && this.snap.deafened) || this.snap.status !== 'connected') return 0;
    const phase = [...visitorId].reduce((n, c) => n + c.charCodeAt(0), 0);
    return Math.max(0, Math.sin(performance.now() / 800 + phase)) * (0.4 + 0.2 * Math.sin(performance.now() / 90 + phase));
  }

  private enableMic(): void {
    const denied = mockState()?.faults.micDenied ?? false;
    this.set({ muted: denied, listenOnly: denied });
    if (denied) this.host.onProblem('mic_denied');
  }
  private refresh(): void {
    const state = mockState();
    if (!state || !this.snap.roomId || this.snap.status === 'joining') return;
    if (state.generation !== this.generation || !state.visitor || state.voiceRoomId !== this.snap.roomId) { this.close(); return; }
    const self = state.visitor;
    const people = [
      { id: self.id, name: self.name, local: true, muted: this.snap.muted, deafened: this.snap.deafened, sharing: this.snap.sharing, shareTrackId: '', camera: this.snap.camera, cameraTrackId: '' },
      ...(state.peers[this.snap.roomId] ?? []).map((p) => ({ id: p.visitorId, name: p.name, local: false, muted: p.muted, deafened: p.deafened, sharing: p.sharing, shareTrackId: '', camera: false, cameraTrackId: '' })),
    ];
    const sharing = new Set(people.filter((p) => p.sharing).map((p) => p.id));
    for (const [id, track] of this.tracks) {
      if (!sharing.has(id)) { track.stop(); this.tracks.delete(id); }
    }
    for (const person of people) {
      if (!person.sharing) continue;
      let track = this.tracks.get(person.id);
      if (!track) {
        track = new SyntheticShare(person.name);
        this.tracks.set(person.id, track);
        if (!person.local) this.host.onSound('share');
      }
      person.shareTrackId = track.id;
    }
    if (this.snap.camera) {
      this.cameraPicture ??= new SyntheticShare(self.name);
      people[0]!.cameraTrackId = this.cameraPicture.id;
    } else this.stopCamera();
    this.set({ people, status: state.faults.voiceReconnecting ? 'reconnecting' : 'connected', quality: 'unknown' });
    this.set({ speakers: people.filter((p) => this.level(p.id) > 0.1).map((p) => p.id) });
  }
  private async release(generation: number, grantId: string): Promise<void> {
    await mockAction({ type: 'voice-leave', generation, grantId }).catch(() => {});
  }
  private close(): void {
    this.operation++;
    this.generation = null;
    this.grantId = null;
    this.joining = null;
    for (const track of this.tracks.values()) track.stop();
    this.tracks.clear();
    this.stopCamera();
    this.snap = { ...idleVoice, pendingLeave: this.leaves.count };
    this.host.onChange(this.snap);
  }
  private stopCamera(): void {
    this.cameraPicture?.stop();
    this.cameraPicture = null;
  }
  private set(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.host.onChange(this.snap);
  }
}
