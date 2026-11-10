import { useSyncExternalStore } from 'react';
import type { Room, Visitor, VisitorColour } from '../api/client';
import type { ComposerUpload, RoomChat } from '../chat/timeline';
import type { PaletteName } from '../fx/palette';
import { idleVoice, type VoiceSnapshot } from '../voice/types';
import { prefs, type Settings } from './prefs';

export interface Notice {
  id: number;
  title: string;
  body?: string;
}

/** Where someone is on the way in: the access password, then their account. */
export type AuthStep = 'access' | 'signin' | 'register' | 'recover';

export interface AuthState {
  step: AuthStep;
  /** A guest from before accounts, whose browser may register without the access password. */
  guestName: string | null;
  /** Why someone is signing in again, said once above the form. */
  reason: 'signedOut' | 'ended' | null;
  /** From an operator's recovery link: the account and its one-time code. */
  recovery: { account: string; code: string } | null;
}

export interface AppState {
  /** `unset`: the operator has not set the access password, so no one can come in yet. */
  phase: 'loading' | 'auth' | 'unset' | 'ready';
  auth: AuthState;
  visitor: Visitor | null;
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
  /** A room name being typed in the room list: `new` for a new room, or the ID of the room being renamed. */
  roomEdit: string | null;
  voice: VoiceSnapshot;
  notice: Notice | null;
  settings: Settings;
  /** Only server-confirmed assignments; missing IDs render without a visitor colour. */
  colours: Record<string, VisitorColour>;
  colourSave: { palette: PaletteName; pending: boolean; failed: boolean } | null;
}

let state: AppState = {
  phase: 'loading',
  auth: { step: 'access', guestName: null, reason: null, recovery: null },
  visitor: null,
  rooms: [],
  viewedRoomId: null,
  live: 'off',
  chats: {},
  uploads: {},
  attachmentLimits: { maxAttachments: 4, maxFileBytes: 25 * 1024 * 1024 },
  newAfterId: null,
  chatOpen: false,
  roomsOpen: false,
  roomEdit: null,
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
