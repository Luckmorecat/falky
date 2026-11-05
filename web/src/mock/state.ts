import type { MockAction, MockState } from '../../mock/protocol';

let state: MockState | null = null;
const listeners = new Set<(state: MockState) => void>();
export const mockState = (): MockState | null => state;
export function subscribeMockState(listener: (state: MockState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function request(path: string, body?: unknown): Promise<MockState> {
  const response = await fetch(`/__mock/${path}`, {
    cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Mock control ${path}: ${response.status}`);
  const next = await response.json() as MockState;
  // A concurrent poll may complete after a newer action/voice response.
  if (state?.instanceId === next.instanceId && (next.generation < state.generation || next.revision < state.revision)) return state;
  state = next;
  listeners.forEach((listener) => listener(next));
  return next;
}

export const refreshMockState = (): Promise<MockState> => request('state');
export const bootstrapState = (scenario?: string): Promise<MockState> => request('bootstrap', scenario ? { scenario } : {});
export const mockAction = (action: MockAction): Promise<MockState> => request('action', action);
