/** Dev-only simulator protocol. Public API responses retain the generated contract. */
import type { components } from '../src/api/schema.gen';
export type Schema = components['schemas'];
export const scenarios = ['populated', 'entry', 'quiet', 'remote-share', 'same-person', 'signed-out'] as const;
export type Scenario = (typeof scenarios)[number];
export interface MockPeer {
  connectionId: string;
  camera?: boolean;
  visitorId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
}
export interface MockFaults {
  send: 'none' | 'fail' | 'lost-response';
  colourSave: 'none' | 'fail';
  colourDelayMs: number;
  colourResponseDelayMs: number;
  delayMs: number;
  liveDisconnected: boolean;
  roomFull: string | null;
  micDenied: boolean;
  scannerError?: 'NotAllowedError' | 'NotFoundError' | 'NotReadableError' | 'DecodeError' | '';
  scannerDelayMs?: number;
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
  /** Connected mock media, independent of production grant authorization. */
  voiceConnections: Record<string, string>;
  rooms: Schema['Room'][];
  peers: Record<string, MockPeer[]>;
  faults: MockFaults;
  accessLink: string;
}
/** Generation is required for asynchronous browser voice operations. */
export type MockAction =
  | { type: 'device-fault'; fault: 'none' | 'rate-limited' | 'finish-lost' }
  | { type: 'device-expire'; requestId?: string; linkId?: string }
  | { type: 'account-fault'; fault: 'none' | 'finish-expired' | 'finish-lost' | 'regenerate-lost' | 'last-passkey' | 'invalid-proof' }
  | { type: 'expire-proof' }
  | { type: 'colour'; visitorId: string; palette: Schema['PaletteName'] }
  | { type: 'message'; roomId: string; body?: string; authorName?: string; images?: number }
  | { type: 'expire-attachments'; roomId: string }
  | { type: 'participants'; roomId: string; participants: MockPeer[] }
  | { type: 'faults'; faults: Partial<MockFaults> }
  | { type: 'name-conflict'; active: boolean }
  | { type: 'revoke' }
  | { type: 'voice-disconnect'; generation: number; connectionId: string };
