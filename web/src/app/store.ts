import { useSyncExternalStore } from 'react';
import type { AccountSession, Room, Visitor, VisitorColour } from '../api/client';
import type { ComposerUpload, RoomChat } from '../chat/timeline';
import type { PaletteName } from '../fx/palette';
import { idleVoice, type VoiceSnapshot } from '../voice/types';
import { prefs, type Settings } from './prefs';

export interface Notice {
  id: number;
  title: string;
  body?: string;
}

export interface AppState {
  phase: 'loading' | 'entry' | 'noaccess' | 'revoked' | 'ready';
  visitor: Visitor | null;
  accountSession: AccountSession | null;
  /** Changes only when the owner changes, for resetting owner-local UI state. */
  ownerRevision: number;
  /** Cookie transition/save gate: identity-bound actions remain paused. */
  sessionPaused: boolean;
  rooms: Room[];
  viewedRoomId: string | null;
  /** The live-update connection, as far as the person needs to know. */
  live: 'off' | 'open' | 'reconnecting';
  chats: Record<string, RoomChat>;
  /** Pictures waiting in each room's composer. */
  uploads: Record<string, ComposerUpload[]>;
  /** What the server takes per message, from its limits; defaults until they are read. */
  attachmentLimits: { maxAttachments: number; maxFileBytes: number };
  /** Where the viewed room's "new messages" line goes. */
  newAfterId: string | null;
  chatOpen: boolean;
  roomsOpen: boolean;
  voice: VoiceSnapshot;
  notice: Notice | null;
  settings: Settings;
  /** Only server-confirmed assignments; missing IDs render without a visitor colour. */
  colours: Record<string, VisitorColour>;
  colourSave: { palette: PaletteName; pending: boolean; failed: boolean } | null;
}

let state: AppState = {
  phase: 'loading',
  visitor: null,
  accountSession: null,
  ownerRevision: 0,
  sessionPaused: false,
  rooms: [],
  viewedRoomId: null,
  live: 'off',
  chats: {},
  uploads: {},
  attachmentLimits: { maxAttachments: 4, maxFileBytes: 25 * 1024 * 1024 },
  newAfterId: null,
  chatOpen: false,
  roomsOpen: false,
  voice: idleVoice,
  notice: null,
  settings: prefs.settings(),
  colours: {},
  colourSave: null,
};

const listeners = new Set<() => void>();

export const getState = (): AppState => state;

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
