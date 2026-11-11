import { api, ApiError, type AccountCeremony, type AccountEnrollment, type AccountSession } from '../api/client';
import { createCredential, getCredential, CredentialError } from '../api/webauthn';
import { adoptSession, beginSessionChange, currentSessionEpoch, handleAccountError, reconcileSession, resumeSession } from './controller';
import { clearEntryLinks } from './entryLinks';
import { getState } from './store';

export class AccountFlowError extends Error {
  constructor(readonly code: 'busy' | 'stale' | 'invalid_response' | 'outcome_unknown', readonly cause?: unknown) {
    super(code);
    this.name = 'AccountFlowError';
  }
}

export type PendingEnrollment = AccountEnrollment & { sessionEpoch: number };

interface Flow {
  signal: AbortSignal;
  epoch: number;
  owner: string | undefined;
  check(): void;
}
let active: AbortController | null = null;

/** Abort on flow exit/unmount. Once finish was sent, reconcile a possible committed result. */
export function cancelAccountFlow(): void { active?.abort(); }

async function flow<T>(signal: AbortSignal | undefined, action: (context: Flow) => Promise<T>): Promise<T> {
  if (active) throw new AccountFlowError('busy');
  const control = new AbortController();
  active = control;
  const context: Flow = {
    signal: signal ? AbortSignal.any([signal, control.signal]) : control.signal,
    epoch: currentSessionEpoch(),
    owner: getState().accountSession?.visitor.id,
    check() {
      if (this.epoch !== currentSessionEpoch()) throw new AccountFlowError('stale');
      if (this.signal.aborted) throw new CredentialError('cancelled');
    },
  };
  try { context.check(); return await action(context); }
  catch (error) { handleAccountError(error, context.epoch); throw error; }
  finally { if (active === control) active = null; }
}

function unknownOutcome(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'invalid_response';
}

export function recoveryPhrase(codes: unknown): string {
  if (!Array.isArray(codes) || codes.length !== 1 || typeof codes[0] !== 'string' || !/^\S+(?: \S+){11}$/.test(codes[0])) throw new AccountFlowError('invalid_response');
  return codes[0];
}

function validateEnrollment(value: AccountEnrollment, hasPhrase: boolean): AccountEnrollment {
  if (!value?.session?.visitor?.id || value.session.kind !== 'account' || !Array.isArray(value.recoveryCodes)) throw new AccountFlowError('invalid_response');
  if (hasPhrase) recoveryPhrase(value.recoveryCodes);
  else if (value.recoveryCodes.length !== 0) throw new AccountFlowError('invalid_response');
  return value;
}

async function enroll(context: Flow, begin: () => Promise<AccountCeremony>, finish: (body: { ceremonyId: string; credential: Record<string, unknown>; label?: string }) => Promise<AccountEnrollment>, create: boolean, label?: string): Promise<PendingEnrollment> {
  const ceremony = await begin();
  context.check();
  const credential = await (create ? createCredential : getCredential)(ceremony.options, context.signal);
  context.check();
  context.epoch = beginSessionChange();
  let result: AccountEnrollment;
  try {
    // Do not abort finish in flight: a lost once-only response can contain the only recovery phrase.
    result = validateEnrollment(await finish({ ceremonyId: ceremony.id, credential, ...(label ? { label } : {}) }), create);
  } catch (error) {
    if (unknownOutcome(error)) throw new AccountFlowError('outcome_unknown', error);
    resumeSession(context.epoch);
    throw error;
  }
  if (context.epoch !== currentSessionEpoch()) throw new AccountFlowError('stale');
  if (context.signal.aborted) throw new AccountFlowError('outcome_unknown');
  if (!create) await adoptSession(result.session, context.epoch);
  return { ...result, sessionEpoch: context.epoch };
}

export function authenticate(signal?: AbortSignal): Promise<AccountEnrollment> {
  return flow(signal, (context) => enroll(context, () => api.beginAuthentication(context.signal), (body) => api.finishAuthentication(body), false));
}
export function register(invitation: string, name: string, label?: string, signal?: AbortSignal): Promise<PendingEnrollment> {
  return flow(signal, async (context) => {
    const result = await enroll(context, () => api.beginRegistration(invitation, name, context.signal), (body) => api.finishRegistration(body), true, label);
    clearEntryLinks('invitation');
    return result;
  });
}
export function recover(accountId: string, proof: string, label?: string, signal?: AbortSignal): Promise<PendingEnrollment> {
  return flow(signal, async (context) => {
    const result = await enroll(context, () => api.beginRecovery(accountId, proof, context.signal), (body) => api.finishRecovery(body), true, label);
    clearEntryLinks('recovery');
    return result;
  });
}

async function verify(context: Flow): Promise<AccountSession> {
  if (getState().sessionPaused) throw new AccountFlowError('busy');
  const ceremony = await api.beginReauthentication(context.signal);
  context.check();
  const credential = await getCredential(ceremony.options, context.signal);
  context.check();
  const result = await api.finishReauthentication({ ceremonyId: ceremony.id, credential }, context.signal);
  context.check();
  return result;
}
/** Call only after the person acknowledges saving both permanent ID and phrase. */
export async function completeEnrollment(result: PendingEnrollment): Promise<void> {
  if (result.sessionEpoch !== currentSessionEpoch()) { await reconcileSession(); return; }
  let confirmed: AccountSession;
  try { confirmed = await api.accountSession(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) { await reconcileSession(); return; }
    throw error;
  }
  if (result.sessionEpoch !== currentSessionEpoch() || confirmed.kind !== result.session.kind || confirmed.visitor.id !== result.session.visitor.id) {
    await reconcileSession();
    return;
  }
  await adoptSession(confirmed, result.sessionEpoch);
}

export function reauthenticate(signal?: AbortSignal): Promise<AccountSession> { return flow(signal, verify); }

async function confirmAccount(context: Flow): Promise<void> {
  context.check();
  let confirmed: AccountSession;
  try { confirmed = await api.accountSession(context.signal); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) { await reconcileSession(); throw new AccountFlowError('stale'); }
    throw error;
  }
  context.check();
  if (confirmed.kind !== 'account' || confirmed.visitor.id !== context.owner) {
    await reconcileSession();
    throw new AccountFlowError('stale');
  }
}

/** Server errors, never client clocks, decide whether verification is required. */
async function withProof<T>(context: Flow, action: () => Promise<T>): Promise<T> {
  if (getState().sessionPaused) throw new AccountFlowError('busy');
  await confirmAccount(context);
  let result: T;
  try { result = await action(); }
  catch (error) {
    context.check();
    if (!(error instanceof ApiError && error.code === 'recent_proof_required')) throw error;
    await verify(context);
    await confirmAccount(context);
    result = await action();
  }
  try { await confirmAccount(context); }
  catch (error) {
    if (error instanceof AccountFlowError && error.code === 'stale') throw error;
    throw new AccountFlowError('outcome_unknown', error);
  }
  return result;
}

export function listPasskeys(signal?: AbortSignal) {
  if (getState().sessionPaused) return Promise.reject(new AccountFlowError('busy'));
  return flow(signal, async (context) => { await confirmAccount(context); const result = await api.passkeys(context.signal); await confirmAccount(context); return result; });
}
export function addPasskey(label?: string, signal?: AbortSignal) {
  return flow(signal, (context) => withProof(context, async () => {
    context.check();
    const ceremony = await api.beginAddPasskey(context.signal);
    context.check();
    const credential = await createCredential(ceremony.options, context.signal);
    context.check();
    try {
      const result = await api.finishAddPasskey({ ceremonyId: ceremony.id, credential, ...(label ? { label } : {}) });
      context.check();
      return result;
    } catch (error) {
      if (unknownOutcome(error)) throw new AccountFlowError('outcome_unknown', error);
      throw error;
    }
  }));
}
export function removePasskey(id: string, signal?: AbortSignal): Promise<void> {
  return flow(signal, (context) => withProof(context, async () => {
    context.check();
    try { await api.removePasskey(id); }
    catch (error) { if (unknownOutcome(error)) throw new AccountFlowError('outcome_unknown', error); throw error; }
    context.check();
  }));
}
export function regenerateRecovery(signal?: AbortSignal): Promise<string> {
  return flow(signal, (context) => withProof(context, async () => {
    context.check();
    try {
      const result = await api.regenerateRecovery();
      if (context.epoch !== currentSessionEpoch()) throw new AccountFlowError('stale');
      return recoveryPhrase(result.recoveryCodes);
    } catch (error) {
      if (unknownOutcome(error)) throw new AccountFlowError('outcome_unknown', error);
      throw error;
    }
  }));
}
