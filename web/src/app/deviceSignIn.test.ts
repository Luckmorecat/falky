import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';

const session = vi.hoisted(() => ({ epoch: 1, value: null as { kind: string; visitor: { id: string } } | null, paused: false, listeners: new Set<() => void>() }));
vi.mock('./store', () => ({ getState: () => ({ sessionPaused: session.paused, accountSession: session.value }) }));
vi.mock('./controller', () => ({ currentSessionEpoch: () => session.epoch,
  subscribeSessionEpoch: (listener: () => void) => { session.listeners.add(listener); return () => session.listeners.delete(listener); },
  handleAccountError() {}, beginSessionChange: () => { session.paused = true; ++session.epoch; session.listeners.forEach(listener => listener()); return session.epoch; },
  adoptSession: vi.fn(async (value) => { session.value = value; session.paused = false; }), resumeSession: vi.fn(() => { session.paused = false; }),
  reconcileSession: vi.fn(async () => { ++session.epoch; session.listeners.forEach(listener => listener()); return session.value; }),
}));
beforeEach(() => { session.epoch = 1; session.value = null; session.paused = false; vi.useFakeTimers(); });
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
it('retries an initial QR allocation without requiring a bound request', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const replacements: boolean[] = [];
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    replacements.push(JSON.parse(String(init.body)).replace);
    if (replacements.length === 1) throw new TypeError('Offline before allocation');
    return Response.json({ request, url: `${location.origin}/#qr-signin=qr` });
  });
  const candidate = createDeviceCandidate();
  try {
    await expect(candidate.beginQR()).rejects.toMatchObject({ code: 'network' });
    await candidate.retryQR();
    expect(replacements).toEqual([false, false]);
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request });
  } finally { candidate.dispose(); }
});

it('recovers a lost QR binding without looping replacement requests', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const replacements: boolean[] = [];
  const replacement = { ...request, id: 'new-bound-request' };
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path !== '/api/accounts/qr-signins') return Response.json({ code: 'invalid_proof', message: 'Binding lost' }, { status: 403 });
    const replace = JSON.parse(String(init?.body)).replace;
    replacements.push(replace);
    if (replace) return Response.json({ code: 'invalid_proof', message: 'No bound request to replace' }, { status: 403 });
    return Response.json({ request: replacements.length === 1 ? request : replacement, url: `${location.origin}/#qr-signin=qr` });
  });
  const candidate = createDeviceCandidate();
  try {
    await candidate.beginQR();
    await expect(candidate.refresh()).rejects.toMatchObject({ code: 'invalid_proof' });
    await candidate.retryQR();
    expect(replacements).toEqual([false, true, false]);
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request: replacement });
  } finally { candidate.dispose(); }
});

it('replaces an existing terminal QR after reopening without local request metadata', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const replacements: boolean[] = [];
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    const replace = JSON.parse(String(init.body)).replace;
    replacements.push(replace);
    return replace ? Response.json({ request, url: `${location.origin}/#qr-signin=qr` })
      : Response.json({ code: 'invalid_proof', message: 'Previous QR was denied' }, { status: 403 });
  });
  const candidate = createDeviceCandidate();
  try {
    await expect(candidate.beginQR()).rejects.toMatchObject({ code: 'invalid_proof' });
    await candidate.retryQR();
    expect(replacements).toEqual([false, false, true]);
    expect(candidate.getSnapshot().phase).toBe('waiting');
  } finally { candidate.dispose(); }
});

it('does not retry a rejected QR allocation after the receiver is disposed', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let release!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  const retry = candidate.retryQR();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  candidate.dispose();
  release(Response.json({ code: 'invalid_proof', message: 'Unavailable' }, { status: 403 }));
  await expect(retry).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('bounds explicit QR binding recovery to one fallback request', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const fetcher = vi.fn(async () => Response.json({ code: 'invalid_proof', message: 'Unavailable' }, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  try {
    await expect(candidate.retryQR()).rejects.toMatchObject({ code: 'invalid_proof' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(candidate.getSnapshot().phase).toBe('unavailable');
  } finally { candidate.dispose(); }
});

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

it.each(['success', 'failure'])('allocates the replacement link after a superseded begin returns %s', async outcome => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let release!: (response: Response) => void;
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const bearers: string[] = [];
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    const bearer = JSON.parse(String(init.body)).token;
    bearers.push(bearer);
    if (bearer === 'first') {
      started();
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return Response.json({ request: { ...request, id: bearer, type: 'link' }, code: '0012' });
  });
  const candidate = createDeviceCandidate();
  const snapshots: string[] = [];
  candidate.subscribe(() => { if (candidate.getSnapshot().request) snapshots.push(candidate.getSnapshot().request!.id); });
  try {
    const first = candidate.beginLink('first').catch(error => error);
    await reached;
    const replacement = candidate.beginLink('replacement');
    release(outcome === 'success' ? Response.json({ request: { ...request, id: 'first', type: 'link' }, code: '0007' })
      : Response.json({ code: 'invalid_proof', message: 'Unavailable' }, { status: 403 }));
    await Promise.all([first, replacement]);
    expect(bearers).toEqual(['first', 'replacement']);
    expect(snapshots).not.toContain('first');
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request: { id: 'replacement' }, code: '0012', busy: false });
    expect(candidate.getSnapshot().problem).toBeUndefined();
  } finally { candidate.dispose(); }
});

it.each(['complete', 'cancel', 'dispose'])('keeps only the latest queued link allocation on %s', async action => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  let release!: (response: Response) => void;
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const bearers: string[] = [];
  let latestStarted!: () => void;
  const latestReached = new Promise<void>(resolve => { latestStarted = resolve; });
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    const bearer = JSON.parse(String(init.body)).token;
    bearers.push(bearer);
    if (bearer === 'first') started(); else latestStarted();
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const candidate = createDeviceCandidate();
  try {
    const first = candidate.beginLink('first').catch(error => error);
    await reached;
    const middle = candidate.beginLink('middle').catch(error => error);
    const latest = candidate.beginLink('latest');
    const settledLatest = latest.catch(error => error);
    if (action === 'cancel') await candidate.cancel();
    if (action === 'dispose') candidate.dispose();
    release(Response.json({ request: { ...request, id: 'first', type: 'link' }, code: '0007' }));
    await Promise.all([first, middle]);
    if (action === 'complete') {
      await latestReached;
      expect(candidate.beginLink('latest')).toBe(latest);
      release(Response.json({ request: { ...request, id: 'latest', type: 'link' }, code: '0012' }));
      await latest;
      expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request: { id: 'latest' }, code: '0012' });
    } else {
      await settledLatest;
      expect(candidate.getSnapshot()).toEqual({ phase: 'idle', busy: false });
    }
    expect(bearers).toEqual(action === 'complete' ? ['first', 'latest'] : ['first']);
  } finally { candidate.dispose(); }
});

it('does not restore the old request or code when a different link fails to allocate', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    if (JSON.parse(String(init.body)).token !== 'first') throw new TypeError('Offline');
    return Response.json({ request: { ...request, type: 'link' }, code: '0007' });
  });
  const candidate = createDeviceCandidate();
  try {
    await candidate.beginLink('first');
    await expect(candidate.beginLink('replacement')).rejects.toMatchObject({ code: 'network' });
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'unavailable', busy: false });
    expect(candidate.getSnapshot().request).toBeUndefined();
    expect(candidate.getSnapshot().code).toBeUndefined();
  } finally { candidate.dispose(); }
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


it.each(['before-delivery', 'lost-response', 'lost-session-read'] as const)('retains an uncertain link through offline reconciliation (%s)', async failure => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const { reconcileSession } = await import('./controller');
  const approved = { ...request, type: 'link', state: 'approved' };
  const actual = { kind: 'account', visitor: { id: 'approved-account' }, expiresAt: '2099-12-01T00:00:00Z' };
  let offline = false, delivered = false, finishes = 0, allocations = 0;
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path.endsWith('/session')) {
      if (offline) throw new TypeError('Offline');
      return delivered ? Response.json(actual) : Response.json({ code: 'visitor_required' }, { status: 401 });
    }
    if (path.endsWith('/finish')) {
      expect(JSON.parse(String(init?.body))).toEqual({ token: 'same-link' });
      if (++finishes === 1) {
        offline = true; delivered = failure !== 'before-delivery';
        if (failure !== 'lost-session-read') throw new TypeError('Offline');
      }
      delivered = true; return Response.json(actual);
    }
    allocations++;
    return Response.json({ request: approved, code: '0007' });
  });
  const candidate = createDeviceCandidate();
  try {
    await candidate.beginLink('same-link');
    await expect(candidate.finish()).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request: approved, code: '0007', problem: { code: 'outcome_unknown' } });
    expect(reconcileSession).not.toHaveBeenCalled();
    offline = false;
    await candidate.finish();
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'complete', busy: false });
    expect(session.value).toEqual(actual);
    expect(finishes).toBe(failure === 'before-delivery' ? 2 : 1);
    expect(allocations).toBe(1);
  } finally { candidate.dispose(); }
});

it.each([
  ['link', 'lost-response', 'before-error'], ['qr', 'lost-response', 'after-error'],
  ['link', 'lost-session-read', 'after-error'], ['qr', 'lost-session-read', 'before-error'],
  ['link', 'before-delivery', 'after-error'], ['qr', 'before-delivery', 'before-error'],
] as const)('reconciles uncertain %s %s delivery after expiry %s', async (type, failure, expiry) => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const approved = { ...request, type, state: 'approved', expiresAt: new Date(Date.now() + 1000).toISOString() };
  const actual = { kind: 'account', visitor: { id: 'approved-account' }, expiresAt: '2099-12-01T00:00:00Z' };
  let offline = false, delivered = false, finishes = 0, allocations = 0, polls = 0;
  vi.stubGlobal('fetch', async (path: string) => {
    if (path.endsWith('/session')) {
      if (offline) throw new TypeError('Offline');
      return delivered ? Response.json(actual) : Response.json({ code: 'visitor_required' }, { status: 401 });
    }
    if (path.endsWith('/finish')) {
      finishes++; offline = true; delivered = failure !== 'before-delivery';
      if (expiry === 'before-error') vi.setSystemTime(Date.now() + 2000);
      if (failure !== 'lost-session-read') throw new TypeError('Offline');
      return Response.json(actual);
    }
    if (path === '/api/accounts/signin-requests' || path === '/api/accounts/qr-signins') {
      allocations++;
      return Response.json({ request: approved, code: '0007', url: `${location.origin}/#qr-signin=qr` });
    }
    polls++;
    return Response.json({ code: 'invalid_proof' }, { status: 403 });
  });
  const candidate = createDeviceCandidate();
  try {
    await (type === 'link' ? candidate.beginLink('same-link') : candidate.beginQR());
    await expect(candidate.finish()).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(session.paused).toBe(true);
    await candidate.refresh();
    expect(polls).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(candidate.finish()).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'waiting', request: approved, problem: { code: 'outcome_unknown' } });
    offline = false;
    await candidate.finish();
    expect(candidate.getSnapshot()).toMatchObject({ phase: delivered ? 'complete' : 'expired', busy: false });
    expect(session.value).toEqual(delivered ? actual : null);
    expect(session.paused).toBe(false);
    expect(finishes).toBe(1);
    expect(allocations).toBe(1);
    expect(polls).toBe(0);
  } finally { candidate.dispose(); }
});

it('still abandons an uncertain link when the session changes externally, and reconciles on exit', async () => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const { beginSessionChange, reconcileSession } = await import('./controller');
  for (const exit of ['session-change', 'dispose'] as const) {
    let finishing = false;
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.endsWith('/session') && !finishing) return Response.json({ code: 'visitor_required' }, { status: 401 });
      if (path.endsWith('/finish')) finishing = true;
      if (finishing) throw new TypeError('Offline');
      return Response.json({ request: { ...request, type: 'link', state: 'approved' }, code: '0007' });
    });
    const candidate = createDeviceCandidate();
    await candidate.beginLink('same-link');
    await expect(candidate.finish()).rejects.toMatchObject({ code: 'outcome_unknown' });
    if (exit === 'session-change') {
      beginSessionChange();
      expect(candidate.getSnapshot()).toMatchObject({ phase: 'unavailable', problem: { code: 'stale' } });
      expect(candidate.getSnapshot().request).toBeUndefined();
      await expect(candidate.finish()).rejects.toMatchObject({ code: 'stale' });
    }
    candidate.dispose();
  }
  expect(reconcileSession).toHaveBeenCalledOnce();
});

it.each(['response', 'error'])('ignores a poll %s arriving after successful finish', async result => {
  const { createDeviceCandidate } = await import('./deviceSignIn');
  const approved = { ...request, state: 'approved' };
  let release!: (response: Response) => void, reject!: (error: Error) => void;
  let pollSignal: AbortSignal | undefined;
  let delivered = false;
  const actual = { kind: 'account', visitor: { id: 'approved-account' }, expiresAt: '2099-12-01T00:00:00Z' };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/session')) return delivered ? Response.json(actual) : Response.json({ code: 'visitor_required' }, { status: 401 });
    if (path.endsWith('/finish')) { delivered = true; return Response.json(actual); }
    if (path === '/api/accounts/qr-signins') return Response.json({ request: approved, url: `${location.origin}/#qr-signin=qr` });
    pollSignal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve, fail) => { release = resolve; reject = fail; });
  });
  vi.stubGlobal('fetch', fetcher);
  const candidate = createDeviceCandidate();
  try {
    await candidate.beginQR();
    const polling = candidate.refresh().catch(() => {});
    await candidate.finish();
    expect(pollSignal?.aborted).toBe(true);
    if (result === 'response') release(Response.json(approved)); else reject(new TypeError('late failure'));
    await polling;
    expect(candidate.getSnapshot()).toMatchObject({ phase: 'complete', busy: false, problem: undefined });
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    await candidate.refresh();
    expect(fetcher).toHaveBeenCalledTimes(calls);
  } finally { candidate.dispose(); }
});

it('replaces an in-flight QR preview without allowing its late result to authorize another request', async () => {
  const { createQRApprover } = await import('./deviceSignIn');
  session.value = { kind: 'account', visitor: { id: 'owner' } };
  let release!: (response: Response) => void;
  let reached!: () => void;
  const firstReached = new Promise<void>(resolve => { reached = resolve; });
  const approved: string[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path.endsWith('/session')) return Response.json(session.value);
    const token = JSON.parse(String(init?.body)).token;
    if (path.endsWith('/approve')) { approved.push(token); return Response.json({}); }
    if (token === 'first') { reached(); return new Promise<Response>(resolve => { release = resolve; }); }
    return Response.json({ request: { ...request, id: token }, approvalGrantsRecentProof: false });
  });
  const approver = createQRApprover();
  try {
    const first = approver.preview('first').catch(() => {});
    await firstReached;
    const second = approver.preview('second');
    release(Response.json({ request: { ...request, id: 'first' }, approvalGrantsRecentProof: false }));
    await Promise.all([first, second]);
    expect(approver.getSnapshot()).toMatchObject({ phase: 'preview', preview: { request: { id: 'second' } } });
    await approver.approve();
    expect(approved).toEqual(['second']);
  } finally { approver.dispose(); }
});

it('does not restore a rejected issuer link from retained hints when polling a new link', async () => {
  const { deviceIssuer } = await import('./deviceSignIn');
  const { clearSignInHints, retainSignInHint } = await import('./signInHints');
  clearSignInHints(); deviceIssuer.clear();
  session.value = { kind: 'account', visitor: { id: 'owner' } };
  const oldRequest = { ...request, type: 'link' as const, state: 'pending' as const, linkId: 'old-link' };
  const oldLink = { id: 'old-link', state: 'open', version: 1, createdAt: request.createdAt, expiresAt: request.expiresAt, approvalGrantsRecentProof: false, requests: [oldRequest] };
  const newLink = { ...oldLink, id: 'new-link', requests: [] };
  let expiredOnServer = false;
  let oldReads = 0, newReads = 0;
  vi.stubGlobal('fetch', async (path: string) => {
    if (path.endsWith('/session')) return Response.json(session.value);
    if (path.endsWith('/old-link')) {
      oldReads++;
      return expiredOnServer ? Response.json({ code: 'invalid_proof' }, { status: 403 }) : Response.json(oldLink);
    }
    if (path.endsWith('/new-link')) { newReads++; return Response.json(newLink); }
    return Response.json({ link: newLink, url: `${location.origin}/#signin=new-link` });
  });
  try {
    retainSignInHint(oldRequest);
    await deviceIssuer.refresh();
    expiredOnServer = true;
    await deviceIssuer.refresh();
    expect(oldReads).toBe(2);
    expect(deviceIssuer.getSnapshot().urls['old-link']).toBeUndefined();
    await deviceIssuer.create();
    retainSignInHint({ ...oldRequest, version: 2 });
    await deviceIssuer.refresh();
    await vi.advanceTimersByTimeAsync(6000);
    expect(newReads).toBeGreaterThanOrEqual(2);
    expect(oldReads).toBe(2);
    expect(deviceIssuer.getSnapshot()).toMatchObject({ problem: undefined, urls: { 'new-link': `${location.origin}/#signin=new-link` } });

    clearSignInHints(); deviceIssuer.clear(); expiredOnServer = false;
    retainSignInHint(oldRequest);
    await deviceIssuer.refresh();
    expect(oldReads).toBe(3);
  } finally { clearSignInHints(); deviceIssuer.clear(); }
});

it.each(['revoke', 'poll'] as const)('stops polling revoked issuer links discovered through %s, including after expiry and retained hints', async discovery => {
  const { deviceIssuer } = await import('./deviceSignIn');
  const { clearSignInHints, retainSignInHint } = await import('./signInHints');
  clearSignInHints(); deviceIssuer.clear();
  session.value = { kind: 'account', visitor: { id: 'owner' } };
  const start = Date.now();
  const oldRequest = { ...request, type: 'link' as const, state: 'pending' as const, linkId: 'old-link' };
  const oldLink = { id: 'old-link', state: 'open', version: 1, createdAt: new Date(start).toISOString(), expiresAt: new Date(start + 300000).toISOString(), requests: [oldRequest], approvalGrantsRecentProof: false };
  const newLink = { ...oldLink, id: 'new-link', expiresAt: request.expiresAt, requests: [] };
  let revoked = false, creations = 0, oldReads = 0, newReads = 0;
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path.endsWith('/session')) return Response.json(session.value);
    if (init?.method === 'DELETE') { revoked = true; return Response.json({}); }
    if (path.endsWith('/signin-links') && init?.method === 'POST') {
      const link = creations++ === 0 ? oldLink : newLink;
      return Response.json({ link, url: `${location.origin}/#signin=${link.id}` });
    }
    if (path.endsWith('/old-link')) {
      oldReads++;
      if (Date.now() >= start + 300000) return Response.json({ code: 'invalid_proof' }, { status: 403 });
      return Response.json(revoked ? { ...oldLink, state: 'revoked', version: 2, requests: [{ ...oldRequest, state: 'cancelled', version: 2 }] } : oldLink);
    }
    if (path.endsWith('/new-link')) { newReads++; return Response.json(newLink); }
    throw new Error(`Unexpected request: ${path}`);
  });
  try {
    await deviceIssuer.create();
    retainSignInHint(oldRequest);
    await deviceIssuer.refresh();
    if (discovery === 'revoke') await deviceIssuer.revoke(oldLink.id);
    else { revoked = true; await vi.advanceTimersByTimeAsync(3000); }
    expect(deviceIssuer.getSnapshot()).toMatchObject({ links: [{ state: 'revoked' }], problem: undefined });
    const readsAtRevocation = oldReads;
    await vi.advanceTimersByTimeAsync(303000);
    retainSignInHint({ ...oldRequest, state: 'cancelled', version: 2 });
    await deviceIssuer.refresh();
    await deviceIssuer.create();
    await vi.advanceTimersByTimeAsync(6000);
    expect(oldReads).toBe(readsAtRevocation);
    expect(newReads).toBeGreaterThanOrEqual(2);
    expect(deviceIssuer.getSnapshot().problem).toBeUndefined();
  } finally { clearSignInHints(); deviceIssuer.clear(); }
});

it('keeps issuer links retryable after a transient read failure', async () => {
  const { deviceIssuer } = await import('./deviceSignIn');
  const { clearSignInHints, retainSignInHint } = await import('./signInHints');
  clearSignInHints(); deviceIssuer.clear();
  session.value = { kind: 'account', visitor: { id: 'owner' } };
  let offline = true, reads = 0;
  const hint = { ...request, type: 'link' as const, state: 'pending' as const, linkId: 'retryable-link' };
  const link = { id: hint.linkId, state: 'open', version: 1, createdAt: hint.createdAt, expiresAt: hint.expiresAt, requests: [hint], approvalGrantsRecentProof: false };
  vi.stubGlobal('fetch', async () => {
    reads++;
    if (offline) throw new TypeError('Offline');
    return Response.json(link);
  });
  try {
    retainSignInHint(hint);
    await expect(deviceIssuer.refresh()).rejects.toMatchObject({ code: 'network' });
    offline = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(2);
    expect(deviceIssuer.getSnapshot().links).toEqual([link]);
  } finally { clearSignInHints(); deviceIssuer.clear(); }
});
