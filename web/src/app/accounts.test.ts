import { afterEach, expect, it, vi } from 'vitest';
import { addPasskey } from './accounts';

const session = vi.hoisted(() => ({ epoch: 1, owner: 'owner' }));
vi.mock('./store', () => ({ getState: () => ({ sessionPaused: false, accountSession: { kind: 'account', visitor: { id: session.owner } } }) }));
vi.mock('./controller', () => ({ currentSessionEpoch: () => session.epoch, handleAccountError() {}, beginSessionChange: () => ++session.epoch, adoptSession: vi.fn(), resumeSession: vi.fn(), reconcileSession: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it('restarts add enrollment with fresh server verification when proof expires at finish', async () => {
  const calls: string[] = [];
  let added = false;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/session')) return Response.json({ visitor: { id: 'owner' }, kind: 'account' });
    calls.push(path);
    expect(JSON.parse(init.body as string)).toBeTypeOf('object');
    if (path.endsWith('/passkeys/finish')) {
      if (!added) { added = true; return new Response(JSON.stringify({ code: 'recent_proof_required', message: 'verify' }), { status: 403 }); }
      return Response.json({ id: 'key', label: 'Laptop', createdAt: '2026-11-11T00:00:00Z' });
    }
    if (path.endsWith('/reauthentication/finish')) return Response.json({ visitor: { id: 'owner' }, kind: 'account' });
    return Response.json({ id: `ceremony-${calls.length}`, expiresAt: '2026-11-11T00:05:00Z', options: { publicKey: { challenge: 'AQ', user: { id: 'AQ', name: 'Alex', displayName: 'Alex' }, rp: { name: 'Falky' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } } });
  });
  const credential = { id: 'key', rawId: new Uint8Array([1]).buffer, type: 'public-key', response: { clientDataJSON: new Uint8Array([2]).buffer, attestationObject: new Uint8Array([3]).buffer }, getClientExtensionResults: () => ({}) };
  const create = vi.fn(async () => credential);
  const get = vi.fn(async () => ({ ...credential, response: { clientDataJSON: new Uint8Array([2]).buffer, authenticatorData: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: null } }));
  vi.stubGlobal('navigator', { credentials: { create, get } });
  expect(await addPasskey('Laptop')).toMatchObject({ id: 'key' });
  expect(calls).toEqual(['/api/accounts/passkeys/begin', '/api/accounts/passkeys/finish', '/api/accounts/reauthentication/begin', '/api/accounts/reauthentication/finish', '/api/accounts/passkeys/begin', '/api/accounts/passkeys/finish']);
  expect(create).toHaveBeenCalledTimes(2);
});

it('does not repeat phrase regeneration when a response is lost after a possible commit', async () => {
  const { regenerateRecovery } = await import('./accounts');
  const request = vi.fn(async (path: string) => { if (path.endsWith('/session')) return Response.json({ visitor: { id: 'owner' }, kind: 'account' }); throw new TypeError('connection lost'); });
  vi.stubGlobal('fetch', request);
  await expect(regenerateRecovery()).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(request.mock.calls.filter(([path]) => path.endsWith('/recovery-codes'))).toHaveLength(1);
});

it('cancellation during registration leaves the invitation retryable and never sends finish', async () => {
  const { register } = await import('./accounts');
  const { getEntryLinks, captureEntryLinks } = await import('./entryLinks');
  history.replaceState(null, '', '/#invite=ExactInvitation'); captureEntryLinks();
  const request = vi.fn(async () => Response.json({ id: 'ceremony', options: { publicKey: { challenge: 'AQ', user: { id: 'AQ' } } } }));
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('navigator', { credentials: { create: async () => { throw new DOMException('cancel', 'NotAllowedError'); } } });
  await expect(register('ExactInvitation', 'Alex')).rejects.toMatchObject({ code: 'cancelled' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(getEntryLinks().invitation).toBe('ExactInvitation');
});

it('uses exact operator recovery fields and stages the genuine phrase before identity adoption', async () => {
  const { recover, completeEnrollment } = await import('./accounts');
  const { adoptSession } = await import('./controller');
  const request = vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/begin')) {
      expect(JSON.parse(init.body as string)).toEqual({ accountId: ' ExactId ', proof: ' Mixed+Bearer ' });
      return Response.json({ id: 'ceremony', options: { publicKey: { challenge: 'AQ', user: { id: 'AQ' } } } });
    }
    if (path.endsWith('/session')) return Response.json({ visitor: { id: 'owner' }, kind: 'account' });
    return Response.json({ session: { visitor: { id: 'owner' }, kind: 'account' }, recoveryCodes: ['acid acorn acre acts afar affix aged agent agile aging agony ahead'] });
  });
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('navigator', { credentials: { create: async () => ({ id: 'key', rawId: new Uint8Array([1]).buffer, type: 'public-key', response: { clientDataJSON: new Uint8Array([2]).buffer, attestationObject: new Uint8Array([3]).buffer }, getClientExtensionResults: () => ({}) }) } });
  // This controller seam advances only when a cookie-changing finish is sent.
  session.epoch = 1;
  const result = await recover(' ExactId ', ' Mixed+Bearer ');
  expect(result.recoveryCodes).toEqual(['acid acorn acre acts afar affix aged agent agile aging agony ahead']);
  expect(adoptSession).not.toHaveBeenCalled();
  await completeEnrollment(result);
  expect(adoptSession).toHaveBeenCalledWith(result.session, 2);
  session.epoch = 1;
});

it('accepts twelve server-issued words including hyphenated words without dictionary assumptions', async () => {
  const { recoveryPhrase } = await import('./accounts');
  expect(recoveryPhrase(['yo-yo acorn acre acts afar affix aged agent agile aging agony ahead'])).toBe('yo-yo acorn acre acts afar affix aged agent agile aging agony ahead');
  expect(() => recoveryPhrase(['old-code', 'other-code'])).toThrow();
});

it('checks the authoritative cookie session at acknowledgement and reconciles a changed owner instead of adopting the captured enrollment', async () => {
  const { completeEnrollment } = await import('./accounts');
  const { adoptSession, reconcileSession } = await import('./controller');
  vi.mocked(adoptSession).mockClear();
  vi.stubGlobal('fetch', async () => Response.json({ visitor: { id: 'other' }, kind: 'account' }));
  await completeEnrollment({ session: { visitor: { id: 'captured' } as never, kind: 'account' }, recoveryCodes: ['acorn actor adapt aerial affair agent agile agony ahead aisle alarm yo-yo'], sessionEpoch: session.epoch });
  expect(adoptSession).not.toHaveBeenCalled();
  expect(reconcileSession).toHaveBeenCalled();
});

it('reconciles a stale enrollment acknowledgement instead of stranding the save gate on a stale error', async () => {
  const { completeEnrollment } = await import('./accounts');
  const { reconcileSession } = await import('./controller');
  vi.mocked(reconcileSession).mockClear();
  await expect(completeEnrollment({ session: { visitor: { id: 'captured' } as never, kind: 'account' }, recoveryCodes: [], sessionEpoch: session.epoch - 1 })).resolves.toBeUndefined();
  expect(reconcileSession).toHaveBeenCalledOnce();
});


it('does not regenerate a different cookie account and reconcile its phrase under the captured account ID', async () => {
  const { regenerateRecovery } = await import('./accounts');
  const { reconcileSession } = await import('./controller');
  vi.mocked(reconcileSession).mockClear();
  const request = vi.fn(async () => Response.json({ visitor: { id: 'other' }, kind: 'account' }));
  vi.stubGlobal('fetch', request);
  await expect(regenerateRecovery()).rejects.toMatchObject({ code: 'stale' });
  expect(request.mock.calls).toHaveLength(1);
  expect(reconcileSession).toHaveBeenCalledOnce();
});

it('does not return a recovery phrase for pairing with a captured ID if the cookie owner changed during mutation', async () => {
  const { regenerateRecovery } = await import('./accounts');
  let reads = 0;
  vi.stubGlobal('fetch', async (path: string) => {
    if (path.endsWith('/session')) return Response.json({ visitor: { id: ++reads === 1 ? 'owner' : 'other' }, kind: 'account' });
    return Response.json({ recoveryCodes: ['acid acorn acre acts afar affix aged agent agile aging agony yo-yo'] });
  });
  await expect(regenerateRecovery()).rejects.toMatchObject({ code: 'stale' });
});
