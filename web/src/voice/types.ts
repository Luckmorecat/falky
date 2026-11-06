import type { CameraSettings } from './camera';
import type { ShareSettings } from './share';
import type { ShareStatsTrack } from './shareStats';

export interface VoicePerson {
  id: string;
  name: string;
  local: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  /** The shared screen's track once it can be shown; it arrives after `sharing`. */
  shareTrackId: string;
  camera: boolean;
  /** Their camera's track once it can be shown; it arrives after `camera`. */
  cameraTrackId: string;
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
  camera: boolean;
  quality: 'good' | 'poor' | 'lost' | 'unknown';
}

export const idleVoice: VoiceSnapshot = {
  status: 'idle', roomId: null, joiningRoomId: null, joinedAt: 0, people: [], speakers: [],
  muted: false, deafened: false, listenOnly: false, sharing: false, camera: false, quality: 'unknown',
};

export type VoiceProblem =
  | 'room_full' | 'voice_unavailable' | 'name_taken' | 'visitor_required' | 'join_failed' | 'media_failed'
  | 'tab_taken' | 'removed' | 'lost' | 'mic_denied' | 'mic_missing' | 'share_failed'
  | 'camera_denied' | 'camera_missing' | 'camera_failed';

export type VoiceSound = 'join' | 'leave' | 'share';

export interface VoiceHost {
  onChange(snapshot: VoiceSnapshot): void;
  onProblem(problem: VoiceProblem): void;
  onSound(sound: VoiceSound): void;
  micId(): string;
  speakerId(): string;
  micProcessing(): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
  joinMuted(): boolean;
  shareSettings(): ShareSettings;
  cameraSettings(): CameraSettings;
  volumeOf(visitorId: string): number;
}

/** Only the presentation and diagnostics surface used by Stage. */
export interface ShareTrack extends ShareStatsTrack {
  attach(element: HTMLVideoElement): unknown;
  detach(element: HTMLVideoElement): unknown;
}

export interface VoiceClient {
  readonly snapshot: VoiceSnapshot;
  join(roomId: string): Promise<void>;
  leave(): Promise<void>;
  end(): void;
  toggleMute(): Promise<void>;
  toggleDeafen(): Promise<void>;
  toggleShare(): Promise<void>;
  shareTrack(visitorId: string): ShareTrack | null;
  toggleCamera(): Promise<void>;
  restartCamera(): Promise<void>;
  setCamera(deviceId: string): Promise<void>;
  cameraTrack(visitorId: string): ShareTrack | null;
  level(visitorId: string): number;
  applyVolumes(): void;
  setMic(deviceId: string): Promise<void>;
  setSpeaker(deviceId: string): Promise<void>;
  applyMicProcessing(): Promise<void>;
}
