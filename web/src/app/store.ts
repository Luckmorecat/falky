import { useSyncExternalStore } from 'react';
import type { Room, Visitor } from '../api/client';
import type { RoomChat } from '../chat/timeline';
import { type PaletteName, pickFavorite } from '../fx/palette';
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
  rooms: Room[];
  viewedRoomId: string | null;
  /** The live-update connection, as far as the person needs to know. */
  live: 'off' | 'open' | 'reconnecting';
  chats: Record<string, RoomChat>;
  /** Where the viewed room's "new messages" line goes. */
  newAfterId: string | null;
  chatOpen: boolean;
  roomsOpen: boolean;
  voice: VoiceSnapshot;
  notice: Notice | null;
  settings: Settings;
  /** The favourite colour worn since the app opened: chance decides once, so it never changes mid-talk. */
  ownColor: PaletteName | null;
}

let state: AppState = {
  phase: 'loading',
  visitor: null,
  rooms: [],
  viewedRoomId: null,
  live: 'off',
  chats: {},
  newAfterId: null,
  chatOpen: false,
  roomsOpen: false,
  voice: idleVoice,
  notice: null,
  settings: prefs.settings(),
  ownColor: pickFavorite(prefs.settings().favoriteColors),
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
