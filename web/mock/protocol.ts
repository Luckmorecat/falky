/** Dev-only simulator protocol. Public API responses retain the generated contract. */
import type { components } from '../src/api/schema.gen';
export type Schema = components['schemas'];
export const scenarios = ['populated', 'entry', 'quiet', 'remote-share'] as const;
export type Scenario = (typeof scenarios)[number];
export interface MockPeer {
  visitorId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
}
export interface MockFaults {
  send: 'none' | 'fail' | 'lost-response';
  delayMs: number;
  liveDisconnected: boolean;
  roomFull: string | null;
  micDenied: boolean;
  shareFailure: boolean;
  voiceReconnecting: boolean;
}
export interface MockState {
  instanceId: string;
  generation: number;
  revision: number;
  scenario: Scenario;
  scenarios: readonly Scenario[];
  visitor: Schema['Visitor'] | null;
  voiceRoomId: string | null;
  rooms: Schema['Room'][];
  peers: Record<string, MockPeer[]>;
  faults: MockFaults;
  accessLink: string;
}
/** Generation is required for asynchronous browser voice operations. */
export type MockAction =
  | { type: 'message'; roomId: string; body: string; authorName?: string }
  | { type: 'participants'; roomId: string; participants: MockPeer[] }
  | { type: 'faults'; faults: Partial<MockFaults> }
  | { type: 'name-conflict'; active: boolean }
  | { type: 'revoke' }
  | { type: 'voice-leave'; generation: number };
