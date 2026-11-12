import type { SignInLink, SignInRequest } from '../../src/api/client';
import type { IssuerState } from '../../src/app/deviceSignIn';
import type { DeviceLinkIssuer } from '../../src/ui/DeviceLinkFlow';

export const scenarios = ['idle', 'creating', 'ready', 'enter-code', 'multiple-requests', 'wrong-code', 'approved', 'complete', 'expired', 'expiring-soon', 'revoked', 'lost-link', 'create-error', 'revoke-error', 'rate-limited'] as const;
export type Scenario = typeof scenarios[number];
const url = 'https://falky.example/#signin=storybook-example';

export function createFixture(scenario: Scenario, responseDelay = 500) {
  const listeners = new Set<() => void>();
  let sequence = 0;
  const makeLink = (): SignInLink => ({ id: `link-${++sequence}`, state: 'open', version: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), approvalGrantsRecentProof: false, requests: [] });
  const request = (link: SignInLink, browser = 'Safari on iPhone'): SignInRequest => ({ id: `request-${++sequence}`, linkId: link.id, type: 'link', state: 'pending', version: 1, createdAt: new Date().toISOString(), expiresAt: link.expiresAt, requesterUserAgent: browser });
  const link = makeLink();
  if (['enter-code', 'multiple-requests', 'wrong-code', 'approved', 'complete'].includes(scenario)) link.requests = [request(link)];
  if (scenario === 'multiple-requests') link.requests.push(request(link, 'Chrome on Windows'));
  if (scenario === 'approved' || scenario === 'complete') {
    link.state = scenario === 'approved' ? 'approved' : 'consumed';
    link.requests = link.requests.map(value => ({ ...value, state: scenario === 'approved' ? 'approved' : 'consumed' }));
  }
  if (scenario === 'expired') link.expiresAt = new Date(Date.now() - 1000).toISOString();
  if (scenario === 'expiring-soon') link.expiresAt = new Date(Date.now() + 10_000).toISOString();
  if (scenario === 'revoked') link.state = 'revoked';
  const empty = ['idle', 'creating', 'create-error', 'rate-limited'].includes(scenario);
  let state: IssuerState = {
    links: empty ? [] : [link], urls: empty || scenario === 'lost-link' || scenario === 'revoked' ? {} : { [link.id]: url }, busy: scenario === 'creating',
    ...(scenario === 'wrong-code' ? { problem: { code: 'invalid_code' } } : {}),
    ...(['create-error', 'revoke-error'].includes(scenario) ? { problem: { code: 'network' } } : {}),
    ...(scenario === 'rate-limited' ? { problem: { code: 'rate_limited', retryAt: Date.now() + 30_000 }, retryAt: Date.now() + 30_000 } : {}),
  };
  const update = (patch: Partial<IssuerState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const replace = (next: SignInLink) => update({ links: [next] });
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, responseDelay));
  let rejectRevoke = scenario === 'revoke-error';
  const issuer: DeviceLinkIssuer = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: async () => {},
    create: async () => {
      update({ busy: true, problem: undefined });
      await delay();
      const next = makeLink();
      update({ links: [next], urls: { [next.id]: url }, busy: false, retryAt: undefined });
      return next;
    },
    revoke: async () => {
      update({ busy: true, problem: undefined }); await delay();
      if (rejectRevoke) { rejectRevoke = false; update({ busy: false, problem: { code: 'network' } }); throw new Error('Simulated network failure'); }
      const current = state.links[0];
      if (current) replace({ ...current, state: 'revoked', version: current.version + 1 });
      update({ urls: {}, busy: false });
    },
    approve: async (_id, code) => {
      update({ busy: true, problem: undefined }); await delay();
      const current = state.links[0];
      const candidate = current?.requests.find(value => value.state === 'pending');
      if (!current || !candidate || code !== '1234') { update({ busy: false, problem: { code: 'invalid_proof' } }); throw new Error('Incorrect code'); }
      const approved = { ...candidate, state: 'approved' as const, version: candidate.version + 1 };
      replace({ ...current, state: 'approved', version: current.version + 1, requests: current.requests.map(value => value.id === candidate.id ? approved : { ...value, state: 'cancelled' }) });
      update({ busy: false }); return approved;
    },
    deny: async (_id, requestId) => {
      const current = state.links[0];
      if (current) replace({ ...current, requests: current.requests.map(value => value.id === requestId ? { ...value, state: 'denied' } : value) });
    },
  };
  return {
    issuer,
    receive() { const current = state.links[0]; if (current?.state === 'open' && Date.parse(current.expiresAt) > Date.now()) replace({ ...current, requests: [...current.requests, request(current)] }); },
    expire() { const current = state.links[0]; if (current) replace({ ...current, expiresAt: new Date(Date.now() - 1000).toISOString(), requests: [] }); },
    finish() { const current = state.links[0]; if (current?.state === 'approved') replace({ ...current, state: 'consumed', requests: current.requests.map(value => value.state === 'approved' ? { ...value, state: 'consumed' } : value) }); },
  };
}
