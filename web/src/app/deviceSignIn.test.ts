import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';

const session = vi.hoisted(() => ({ epoch: 1, value: null as { kind: string; visitor: { id: string } } | null, paused: false }));
vi.mock('./store', () => ({ getState: () => ({ sessionPaused: session.paused, accountSession: session.value }) }));
vi.mock('./controller', () => ({ currentSessionEpoch: () => session.epoch,
  subscribeSessionEpoch: () => () => {}, handleAccountError() {}, beginSessionChange: () => ++session.epoch,
  adoptSession: vi.fn(async (value) => { session.value = value; }), resumeSession: vi.fn(),
  reconcileSession: vi.fn(async () => session.value),
}));
beforeEach(() => { session.epoch = 1; session.value = null; vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

it('retains server Retry-After and sends QR bearers only in JSON bodies', async () => {
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/accounts/qr-signins/preview');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'secret' });
    return Response.json({ code: 'rate_limited', message: 'Wait' }, { status: 429, headers: { 'Retry-After': '7' } });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(api.previewQRSignIn('secret')).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 7000 });
});

const request = { id: 'request', type: 'qr', state: 'pending', version: 1, requesterUserAgent: 'Browser', createdAt: '2026-11-11T00:00:00Z', expiresAt: '2099-11-11T00:05:00Z' };
it('deduplicates allocation, ignores a late result after exit, and never cancels a link on the server', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  const first = candidate.beginLink('bearer');
  const second = candidate.beginLink('bearer');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  candidate.dispose();
  resolve(Response.json({ request: { ...request, type: 'link' }, code: '0007' }));
  await Promise.allSettled([first, second]);
  expect(candidate.getSnapshot().phase).toBe('idle');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('finishes using the bound request and adopts only the authoritative cookie session', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const { adoptSession } = await import('./controller');
  let delivered = false;
  const actual = { kind: 'account', visitor: { id: 'approved-account' }, expiresAt: '2099-12-01T00:00:00Z' };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/accounts/session') return delivered ? Response.json(actual) : Response.json({ code: 'visitor_required', message: 'Sign in' }, { status: 401 });
    if (path.endsWith('/finish')) { expect(JSON.parse(String(init?.body))).toEqual({}); delivered = true; return Response.json(actual); }
    return Response.json({ request: { ...request, state: 'approved' }, url: `${location.origin}/#qr-signin=qr` });
  });
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  await candidate.beginQR();
  await candidate.finish();
  expect(adoptSession).toHaveBeenCalledWith(actual, 2);
  expect(candidate.getSnapshot()).toMatchObject({ phase: 'complete', busy: false });
  candidate.dispose();
});

it('fails closed after binding loss and respects server cooldown without allocating a replacement', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let mode = 'begin';
  const fetcher = vi.fn(async () => mode === 'begin' ? Response.json({ request, url: `${location.origin}/#qr-signin=qr` })
    : Response.json({ code: mode, message: 'Refused' }, { status: mode === 'rate_limited' ? 429 : 403, headers: { 'Retry-After': '9' } }));
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  await candidate.beginQR(); mode = 'rate_limited';
  await expect(candidate.refresh()).rejects.toMatchObject({ code: 'rate_limited' });
  const calls = fetcher.mock.calls.length;
  await expect(candidate.beginQR(true)).rejects.toMatchObject({ code: 'rate_limited' });
  expect(fetcher).toHaveBeenCalledTimes(calls);
  mode = 'invalid_proof'; await vi.advanceTimersByTimeAsync(9000);
  expect(candidate.getSnapshot().problem?.code).toBe('invalid_proof');
  expect(candidate.getSnapshot().phase).toBe('unavailable');
  expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
  candidate.dispose();
});

it('recovers sanitized issuer state from a private initial request without inventing a copyable link', async () => {
  const { deviceIssuer } = await import('./deviceSignIn');
  const { retainSignInHint } = await import('./signInHints');
  session.value = { kind: 'account', visitor: { id: 'owner' } };
  const link = { id: 'link', state: 'open', version: 1, createdAt: request.createdAt, expiresAt: request.expiresAt, approvalGrantsRecentProof: false, requests: [{ ...request, type: 'link', linkId: 'link' }] };
  vi.stubGlobal('fetch', async (path: string) => path.endsWith('/session') ? Response.json(session.value) : Response.json(link));
  retainSignInHint({ ...request, type: 'link', linkId: 'link' } as never);
  await deviceIssuer.refresh();
  expect(deviceIssuer.getSnapshot().links).toEqual([link]);
  expect(deviceIssuer.getSnapshot().urls).toEqual({});
  deviceIssuer.clear();
});

it('recovers a lost finish response from the actual cookie session without allocating or issuing again', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const { adoptSession } = await import('./controller');
  let delivered = false;
  const actual = { kind: 'account', visitor: { id: 'real-cookie-account' }, expiresAt: '2099-12-01T00:00:00Z' };
  const fetcher = vi.fn(async (path: string) => {
    if (path.endsWith('/session')) return delivered ? Response.json(actual) : Response.json({ code: 'visitor_required', message: 'Sign in' }, { status: 401 });
    if (path.endsWith('/finish')) { delivered = true; throw new TypeError('Lost response'); }
    return Response.json({ request: { ...request, type: 'link', state: 'approved' }, code: '0007' });
  });
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  await candidate.beginLink('bearer');
  await candidate.finish();
  expect(candidate.getSnapshot().phase).toBe('complete');
  expect(adoptSession).toHaveBeenCalledWith(actual, 2);
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith('/finish'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/accounts/signin-requests')).toHaveLength(1);
  candidate.dispose();
});

it('reuses the same request and link proof when uncertain finish did not deliver a cookie', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith('/session')) return Response.json({ code: 'visitor_required', message: 'Sign in' }, { status: 401 });
    if (path.endsWith('/finish')) throw new TypeError('Lost before delivery');
    return Response.json({ request: { ...request, type: 'link', state: 'approved' }, code: '0007' });
  });
  const candidate = createDeviceCandidate();
  await candidate.beginLink('same-bearer');
  await expect(candidate.finish()).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(candidate.getSnapshot().phase).toBe('waiting');
  await expect(candidate.finish()).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(calls.filter(call => call.path.endsWith('/finish'))).toEqual([
    { path: '/api/accounts/signin-requests/request/finish', body: { token: 'same-bearer' } },
    { path: '/api/accounts/signin-requests/request/finish', body: { token: 'same-bearer' } },
  ]);
  candidate.dispose();
});

it('keeps the current QR request after a rate-limited explicit replacement', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let replacing = false;
  vi.stubGlobal('fetch', async () => replacing ? Response.json({ code: 'rate_limited', message: 'Wait' }, { status: 429, headers: { 'Retry-After': '5' } }) : Response.json({ request, url: `${location.origin}/#qr-signin=old` }));
  const candidate = createDeviceCandidate();
  await candidate.beginQR(); replacing = true;
  await expect(candidate.beginQR(true)).rejects.toMatchObject({ code: 'rate_limited' });
  expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request, url: `${location.origin}/#qr-signin=old`, problem: { code: 'rate_limited' } });
  candidate.dispose();
});

it('preview is read-only, and a disposed approver ignores a late preview response', async () => {
  const { createQRApprover } = await import('./deviceSignIn');
  session.value = { kind: 'account', visitor: { id: 'owner' } };
  const calls: string[] = [];
  let release!: (value: Response) => void;
  const reached = new Promise<void>(resolve => {
    vi.stubGlobal('fetch', (path: string) => {
      calls.push(path);
      if (path.endsWith('/session')) return Promise.resolve(Response.json(session.value));
      resolve();
      return new Promise<Response>(done => { release = done; });
    });
  });
  const approver = createQRApprover();
  const loading = approver.preview('qr-bearer');
  await reached;
  expect(calls.some(path => path.endsWith('/approve'))).toBe(false);
  approver.dispose();
  release(Response.json({ request, approvalGrantsRecentProof: false }));
  await expect(loading).rejects.toMatchObject({ code: 'stale' });
  expect(approver.getSnapshot()).toEqual({ phase: 'idle', busy: false });
});

it('serializes fallback allocations but fails closed when another no-cookie tab wins the shared binding cookie', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let allocated = 0;
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', async (path: string) => {
    if (path === '/api/accounts/qr-signins') {
      allocated++;
      if (allocated === 1) return new Promise<Response>(done => { release = done; });
      return Response.json({ request: { ...request, id: 'winner' }, url: `${location.origin}/#qr-signin=winner` });
    }
    // A different initial tab may have raced before Web Locks/fallback could coordinate.
    if (path.endsWith('/orphan')) return Response.json({ code: 'invalid_proof', message: 'Unavailable' }, { status: 403 });
    return Response.json({ ...request, id: 'winner' });
  });
  const first = createDeviceCandidate(), second = createDeviceCandidate();
  const firstBegin = first.beginQR(), secondBegin = second.beginQR();
  await Promise.resolve(); await Promise.resolve();
  expect(allocated).toBe(1);
  release(Response.json({ request: { ...request, id: 'orphan' }, url: `${location.origin}/#qr-signin=orphan` }));
  await Promise.all([firstBegin, secondBegin]);
  expect(allocated).toBe(2);
  await expect(first.refresh()).rejects.toMatchObject({ code: 'invalid_proof' });
  await second.refresh();
  expect(first.getSnapshot().phase).toBe('unavailable');
  expect(second.getSnapshot().phase).toBe('waiting');
  expect(allocated).toBe(2);
  first.dispose(); second.dispose();
});
