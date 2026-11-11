import { api, ApiError, type AccountSession, type SignInBegin, type SignInLink, type SignInPreview, type SignInRequest } from '../api/client';
import { AccountFlowError, runAccountSessionAction, runSessionAction } from './accounts';
import { adoptSession, beginSessionChange, currentSessionEpoch, reconcileSession, resumeSession, subscribeSessionEpoch } from './controller';
import { getState } from './store';
import { getSignInHints, subscribeSignInHints } from './signInHints';

export type DeviceProblem = { code: string; retryAt?: number };
function problem(error: unknown): DeviceProblem {
  return { code: error instanceof ApiError || error instanceof AccountFlowError ? error.code : 'network',
    ...(error instanceof ApiError && error.retryAfterMs !== undefined ? { retryAt: Date.now() + error.retryAfterMs } : {}) };
}
function cooldown(retryAt?: number): void {
  if (retryAt && retryAt > Date.now()) throw new ApiError(429, 'rate_limited', 'Wait before retrying', retryAt - Date.now());
}
function unknownOutcome(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response';
}
function expired(request: { expiresAt: string }): boolean { return Date.parse(request.expiresAt) <= Date.now(); }
function stale(): never { throw new AccountFlowError('stale'); }

// Web Locks also serialize the first allocation before any binding cookie exists.
let allocating: Promise<unknown> = Promise.resolve();
function allocate<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const run = () => { if (signal.aborted) return Promise.reject(new AccountFlowError('stale')); return action(); };
  if (navigator.locks?.request) return navigator.locks.request('falky-device-signin-allocation', { signal }, async () => await run()) as Promise<T>;
  const result = allocating.then(run, run);
  allocating = result.catch(() => {});
  return result;
}

export interface CandidateState {
  phase: 'idle' | 'starting' | 'waiting' | 'finishing' | 'complete' | 'expired' | 'denied' | 'cancelled' | 'unavailable';
  request?: SignInRequest;
  url?: string;
  code?: string;
  busy: boolean;
  problem?: DeviceProblem;
  retryAt?: number;
}

/** One mounted receiver owns one controller. Dispose erases all local authority. */
export function createDeviceCandidate() {
  let state: CandidateState = { phase: 'idle', busy: false };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CandidateState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  let token: string | undefined;
  let epoch = currentSessionEpoch();
  let generation = 0;
  let control = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let ownSessionChange = false;
  let deliveryUncertain = false;
  let disposed = false;
  function stop() { clearTimeout(timer); control.abort(); control = new AbortController(); generation++; refreshing = undefined; }
  function check(version: number) {
    if (disposed || generation !== version || epoch !== currentSessionEpoch() || control.signal.aborted) stale();
  }
  const unsubscribe = subscribeSessionEpoch(() => {
    if (ownSessionChange || disposed) return;
    stop(); token = undefined;
    state = { phase: 'unavailable', busy: false, problem: { code: 'stale' } };
    listeners.forEach(listener => listener());
  });
  function errorState(error: unknown) {
    const reason = problem(error);
    update({ busy: false, problem: reason, retryAt: reason.retryAt,
      ...(state.request && expired(state.request) ? { phase: 'expired' as const }
        : reason.code === 'invalid_proof' ? { phase: 'unavailable' as const } : {}) });
  }
  function accept(request: SignInRequest) {
    if (state.request && state.request.id === request.id && state.request.version > request.version) return;
    update({ request, phase: expired(request) ? 'expired' : request.state === 'denied' || request.state === 'cancelled' ? request.state : 'waiting', problem: undefined });
  }
  function schedule() {
    clearTimeout(timer);
    if (disposed || state.phase !== 'waiting') return;
    timer = setTimeout(() => { void refresh().catch(() => {}); }, Math.max(1000, (state.retryAt ?? 0) - Date.now(), 2000));
  }
  function begin(type: 'qr' | 'link', bearer?: string, replace = false, recoverBinding = false): Promise<void> {
    if (pending) return pending;
    if (disposed) return Promise.reject(new AccountFlowError('stale'));
    try { cooldown(state.retryAt); } catch (error) { return Promise.reject(error); }
    const previous = state;
    stop(); epoch = currentSessionEpoch(); token = type === 'link' ? bearer : undefined;
    const version = generation;
    update({ phase: 'starting', busy: true, problem: undefined });
    const signal = control.signal;
    pending = allocate(async () => {
      check(version);
      let result: SignInBegin;
      try { result = await (type === 'qr' ? api.beginQRSignIn(replace, signal) : api.beginSignInRequest(bearer!, signal)); }
      catch (error) {
        if (type !== 'qr' || !recoverBinding || !(error instanceof ApiError) || error.code !== 'invalid_proof') throw error;
        // Binding cookies may be lost, or outlive a request from a previous visit.
        check(version);
        result = await api.beginQRSignIn(!replace, signal);
      }
      check(version);
      if (result.request.type !== type || !result.request.id || !Number.isFinite(Date.parse(result.request.expiresAt)) || (type === 'link' ? !/^[0-9]{4}$/.test(result.code ?? '') : !result.url)) throw new AccountFlowError('invalid_response');
      state = { phase: 'waiting', busy: false, request: result.request, ...(type === 'qr' ? { url: result.url } : { code: result.code }) };
      accept(result.request);
      schedule();
    }, signal).catch(error => {
      if (generation === version && !disposed) {
        state = previous.request ? previous : { phase: 'unavailable', busy: false };
        errorState(error); schedule();
      }
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    if (!state.request || disposed || state.phase !== 'waiting') return Promise.resolve();
    const version = generation;
    const id = state.request.id;
    if (expired(state.request)) { update({ phase: 'expired' }); return Promise.resolve(); }
    try { cooldown(state.retryAt); } catch (error) { schedule(); return Promise.reject(error); }
    refreshing = api.signInRequest(id, control.signal).then(request => { check(version); accept(request); })
      .catch(error => { if (generation === version && !disposed) errorState(error); throw error; })
      .finally(() => { if (generation === version) { refreshing = undefined; schedule(); } });
    return refreshing;
  }
  function finish(): Promise<void> {
    if (finishing) return finishing;
    if (!state.request || disposed || !['approved', 'consumed'].includes(state.request.state)) return Promise.reject(new AccountFlowError('stale'));
    try { cooldown(state.retryAt); } catch (error) { return Promise.reject(error); }
    stop();
    const version = generation;
    const id = state.request.id;
    update({ phase: 'finishing', busy: true, problem: undefined });
    finishing = runSessionAction(async (context) => {
      check(version);
      // This read detects a cookie changed in another tab before cookie delivery.
      let before: AccountSession | null = null;
      try { before = await api.accountSession(context.signal); }
      catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
      check(version);
      if (deliveryUncertain && before?.kind === 'account') {
        await complete(before, version);
        return;
      }
      const local = getState().accountSession;
      if (before?.visitor.id !== local?.visitor.id || before?.kind !== local?.kind || before?.expiresAt !== local?.expiresAt) {
        await reconcileSession(); stale();
      }
      ownSessionChange = true;
      context.epoch = epoch = beginSessionChange();
      ownSessionChange = false;
      let delivered: AccountSession;
      deliveryUncertain = true;
      try { delivered = await api.finishSignInRequest(id, token); }
      catch (error) {
        if (unknownOutcome(error) && epoch === currentSessionEpoch()) {
          let actual: AccountSession | null;
          try { actual = await api.accountSession(); }
          catch (restoreError) {
            if (!(restoreError instanceof ApiError && restoreError.status === 401)) {
              throw new AccountFlowError('outcome_unknown');
            }
            actual = null;
          }
          if (epoch !== currentSessionEpoch()) stale();
          if (actual?.kind === 'account') {
            if (disposed || generation !== version) { await reconcileSession(); stale(); }
            await complete(actual, version);
            return;
          }
          deliveryUncertain = false;
          const previous = getState().accountSession;
          if (actual?.visitor.id !== previous?.visitor.id || actual?.kind !== previous?.kind) await reconcileSession();
          else resumeSession(epoch);
          if (!disposed && generation === version) { update({ phase: 'waiting', busy: false, problem: { code: 'outcome_unknown' } }); schedule(); }
          throw new AccountFlowError('outcome_unknown');
        }
        deliveryUncertain = false;
        if (epoch === currentSessionEpoch()) resumeSession(epoch);
        check(version);
        throw error;
      }
      if (disposed || generation !== version || epoch !== currentSessionEpoch()) {
        if (epoch === currentSessionEpoch()) await reconcileSession();
        stale();
      }
      const actual = await api.accountSession();
      check(version);
      if (actual.kind !== 'account' || actual.visitor.id !== delivered.visitor.id || actual.expiresAt !== delivered.expiresAt) {
        await reconcileSession(); stale();
      }
      await complete(actual, version);
    }, control.signal).catch(error => {
      if (generation === version && !disposed) {
        if (deliveryUncertain && unknownOutcome(error)) error = new AccountFlowError('outcome_unknown', error);
        if (state.phase === 'finishing') update({ phase: 'waiting' });
        errorState(error); schedule();
      }
      throw error;
    }).finally(() => {
      ownSessionChange = false; finishing = undefined;
      if (disposed || generation !== version) reconcileAfterExit();
    });
    return finishing;
  }
  async function complete(actual: AccountSession, version: number) {
    await adoptSession(actual, epoch);
    check(version);
    deliveryUncertain = false; token = undefined;
    update({ phase: 'complete', busy: false, code: undefined, url: undefined });
  }
  function reconcileAfterExit() {
    if (!deliveryUncertain || finishing || epoch !== currentSessionEpoch()) return;
    deliveryUncertain = false;
    void reconcileSession().catch(() => {});
  }
  async function cancel(): Promise<void> {
    const request = state.request;
    stop(); token = undefined;
    state = { phase: 'idle', busy: false }; listeners.forEach(listener => listener());
    try {
      if (request?.type === 'qr' && epoch === currentSessionEpoch() && !['consumed', 'denied', 'cancelled'].includes(request.state)) await api.cancelQRSignIn(request.id);
    } finally { reconcileAfterExit(); }
  }
  async function resend(): Promise<void> {
    if (!state.request || state.request.type !== 'link' || !token || state.busy) throw new AccountFlowError('stale');
    cooldown(state.retryAt);
    const version = generation;
    update({ busy: true, problem: undefined });
    try { await api.resendSignInRequest(state.request.id, token, control.signal); check(version); update({ busy: false }); }
    catch (error) { if (generation === version && !disposed) errorState(error); throw error; }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    beginQR: (replace = false) => begin('qr', undefined, replace),
    retryQR: () => begin('qr', undefined, state.request?.type === 'qr', true),
    beginLink: (bearer: string) => begin('link', bearer), refresh, finish, resend, cancel,
    dispose() { disposed = true; stop(); token = undefined; state = { phase: 'idle', busy: false }; unsubscribe(); listeners.clear(); reconcileAfterExit(); },
  };
}

export interface IssuerState {
  links: readonly SignInLink[];
  /** Only newly created URLs are copyable; sanitized reads cannot restore them. */
  urls: Readonly<Record<string, string>>;
  busy: boolean;
  problem?: DeviceProblem;
  retryAt?: number;
}
function createIssuer() {
  let state: IssuerState = { links: [], urls: {}, busy: false };
  const ids = new Set<string>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let control = new AbortController();
  let generation = 0;
  const update = (patch: Partial<IssuerState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  function check(version: number) { if (version !== generation || control.signal.aborted) stale(); }
  function merge(link: SignInLink) {
    const previous = state.links.find(value => value.id === link.id);
    if (!previous || previous.version <= link.version) update({ links: [...state.links.filter(value => value.id !== link.id), link] });
  }
  function schedule() {
    clearTimeout(timer);
    if (ids.size && getState().accountSession?.kind === 'account') timer = setTimeout(() => { void refresh().catch(() => {}); }, Math.max(3000, (state.retryAt ?? 0) - Date.now()));
  }
  function clear() {
    generation++; control.abort(); control = new AbortController(); clearTimeout(timer); ids.clear();
    state = { links: [], urls: {}, busy: false }; listeners.forEach(listener => listener());
  }
  subscribeSessionEpoch(clear);
  async function read(id: string, version: number) {
    try { const link = await api.signInLink(id, control.signal); check(version); merge(link); }
    catch (error) {
      check(version);
      if (error instanceof ApiError && error.code === 'invalid_proof') { ids.delete(id); update({ urls: Object.fromEntries(Object.entries(state.urls).filter(([key]) => key !== id)), problem: problem(error) }); }
      else throw error;
    }
  }
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    try { cooldown(state.retryAt); } catch (error) { schedule(); return Promise.reject(error); }
    const version = generation;
    getSignInHints().forEach(request => { if (request.linkId) ids.add(request.linkId); });
    refreshing = Promise.all([...ids].map(id => read(id, version))).then(() => {})
      .catch(error => { if (generation === version) update({ problem: problem(error), retryAt: problem(error).retryAt }); throw error; })
      .finally(() => { refreshing = undefined; schedule(); });
    return refreshing;
  }
  subscribeSignInHints(() => { if (getSignInHints().length) void refresh().catch(() => {}); });
  async function action<T>(execute: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    if (state.busy) throw new AccountFlowError('busy');
    cooldown(state.retryAt);
    const version = generation;
    update({ busy: true, problem: undefined });
    try { const value = await runAccountSessionAction(signal => execute(signal, () => check(version)), control.signal); check(version); return value; }
    catch (error) {
      if (generation === version) update({ problem: problem(error), retryAt: problem(error).retryAt });
      throw error;
    } finally { if (generation === version) update({ busy: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, clear,
    create: () => action(async (signal, check) => {
      const result = await api.createSignInLink(signal); check();
      ids.add(result.link.id);
      update({ urls: { [result.link.id]: result.url } }); merge(result.link);
      await Promise.all([...ids].filter(id => id !== result.link.id).map(id => read(id, generation)));
      schedule();
      return result.link;
    }),
    revoke: (id: string) => action(async (signal, check) => { await api.revokeSignInLink(id, signal); check(); await read(id, generation); update({ urls: Object.fromEntries(Object.entries(state.urls).filter(([key]) => key !== id)) }); }),
    approve: (id: string, code: string) => {
      if (!/^[0-9]{4}$/.test(code)) return Promise.reject(new ApiError(400, 'invalid_request', 'Enter four digits'));
      return action(async (signal, check) => {
        try { const result = await api.approveSignInLink(id, code, signal); check(); return result; }
        finally { check(); await read(id, generation); }
      });
    },
    deny: (linkId: string, requestId: string) => action(async (signal, check) => { await api.denySignInRequest(linkId, requestId, signal); check(); await read(linkId, generation); }),
  };
}
export const deviceIssuer = createIssuer();

export interface ApproverState {
  phase: 'idle' | 'preview' | 'approved' | 'denied';
  preview?: SignInPreview;
  busy: boolean;
  problem?: DeviceProblem;
  retryAt?: number;
}
export function createQRApprover() {
  let previewing: Promise<void> | undefined;
  let state: ApproverState = { phase: 'idle', busy: false };
  let disposed = false;
  let token: string | undefined;
  let generation = 0;
  let control = new AbortController();
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ApproverState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  function clear() { generation++; control.abort(); control = new AbortController(); token = undefined; state = { phase: 'idle', busy: false }; listeners.forEach(listener => listener()); }
  const unsubscribe = subscribeSessionEpoch(clear);
  async function action<T>(execute: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    if (disposed) throw new AccountFlowError('stale');
    if (state.busy) throw new AccountFlowError('busy');
    cooldown(state.retryAt);
    const version = generation;
    update({ busy: true, problem: undefined });
    try {
      const result = await runAccountSessionAction(signal => execute(signal, () => { if (generation !== version) stale(); }), control.signal);
      if (generation !== version) stale();
      return result;
    } catch (error) {
      if (generation === version) update({ problem: problem(error), retryAt: problem(error).retryAt });
      throw error;
    } finally { if (generation === version) update({ busy: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    preview: async (bearer: string) => {
      if (disposed) stale();
      cooldown(state.retryAt);
      const previous = previewing;
      clear();
      const version = generation;
      const operation = (async () => {
        await previous?.catch(() => {});
        if (disposed || generation !== version) stale();
        await action(async (signal, check) => {
          const preview = await api.previewQRSignIn(bearer, signal); check();
          token = bearer; update({ preview, phase: 'preview' });
        });
      })();
      previewing = operation;
      return operation.finally(() => { if (previewing === operation) previewing = undefined; });
    },
    approve: () => action(async (signal, check) => {
      if (!token || state.phase !== 'preview') stale();
      await api.approveQRSignIn(token, signal); check(); token = undefined; update({ phase: 'approved' });
    }),
    deny: () => action(async (signal, check) => {
      if (!token || state.phase !== 'preview') stale();
      await api.denyQRSignIn(token, signal); check(); token = undefined; update({ phase: 'denied' });
    }),
    clear,
    dispose() { disposed = true; clear(); unsubscribe(); listeners.clear(); },
  };
}
