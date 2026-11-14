import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { startMockServer } from './server.ts';

function browser(origin: string) {
  const cookies = new Map<string, string>();
  const call = async (path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, { method, headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'Content-Type': 'application/json', origin }, body: input === undefined ? undefined : JSON.stringify(input) });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0]!.split('='); cookies.set(name!, value!);
    }
    return response;
  };
  return Object.assign(call, { cookie: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') });
}
async function register(call: ReturnType<typeof browser>, origin: string) {
  const ceremony = await (await call('/api/accounts/registration/begin', { invitation: 'mock-invitation', name: 'Issuer' })).json();
  const key = 'fixture-key';
  return (await call('/api/accounts/registration/finish', { ceremonyId: ceremony.id, credential: { id: key, rawId: key, type: 'public-key', response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ceremony.options.publicKey.challenge, origin })).toString('base64url'), attestationObject: 'YXR0ZXN0YXRpb24' } } })).json();
}

test('QR fixture requires explicit approval, bound cookie delivery and receiving-session passkey proof', async () => {
  const server = await startMockServer({ scenario: 'signed-out' });
  try {
    const issuer = browser(server.url), candidate = browser(server.url), stranger = browser(server.url);
    const enrolled = await register(issuer, server.url);
    const beginResponse = await candidate('/api/accounts/qr-signins', {});
    assert.equal(beginResponse.status, 200);
    const begin = await beginResponse.json();
    assert.equal(begin.url, `${server.url}/#qr-signin=${begin.token}`);
    assert.equal((await stranger(`/api/accounts/signin-requests/${begin.request.id}`)).status, 403);
    assert.equal((await candidate(`/api/accounts/signin-requests/${begin.request.id}/finish`, {})).status, 403);
    const preview = await (await issuer('/api/accounts/qr-signins/preview', { token: begin.token })).json();
    assert.equal(preview.request.state, 'pending');
    assert.equal((await candidate(`/api/accounts/signin-requests/${begin.request.id}`)).status, 200);
    assert.equal((await issuer('/api/accounts/qr-signins/approve', { token: begin.token })).status, 200);
    const finished = await (await candidate(`/api/accounts/signin-requests/${begin.request.id}/finish`, {})).json();
    assert.equal(finished.visitor.id, enrolled.session.visitor.id);
    assert.deepEqual(await (await candidate(`/api/accounts/signin-requests/${begin.request.id}/finish`, {})).json(), finished);
    assert.equal((await candidate('/api/accounts/recovery-codes', {})).status, 403);
    assert.equal((await (await issuer('/api/accounts/session')).json()).visitor.id, enrolled.session.visitor.id);
  } finally { await server.close(); }
});

test('link fixture preserves exact issuer scope, three candidates, leading zeroes, and server lockout', async () => {
  const server = await startMockServer({ scenario: 'signed-out' });
  try {
    const issuer = browser(server.url), otherSession = browser(server.url);
    const enrolled = await register(issuer, server.url);
    const created = await (await issuer('/api/accounts/signin-links', {})).json();
    const ceremony = await (await otherSession('/api/accounts/authentication/begin', {})).json();
    await otherSession('/api/accounts/authentication/finish', { ceremonyId: ceremony.id, credential: { id: 'fixture-key', rawId: 'fixture-key', type: 'public-key', response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ceremony.options.publicKey.challenge, origin: server.url })).toString('base64url'), signature: 'signature', authenticatorData: 'auth-data' } } });
    assert.equal((await (await otherSession('/api/accounts/session')).json()).visitor.id, enrolled.session.visitor.id);
    assert.equal((await otherSession(`/api/accounts/signin-links/${created.link.id}`)).status, 403);
    const candidates = Array.from({ length: 4 }, () => browser(server.url));
    const pending = [];
    for (const candidate of candidates.slice(0, 3)) pending.push(await (await candidate('/api/accounts/signin-requests', { token: created.token })).json());
    assert.equal(pending[0].code, '0000');
    assert.equal((await candidates[3]!('/api/accounts/signin-requests', { token: created.token })).status, 409);
    const recovered = await (await issuer(`/api/accounts/signin-links/${created.link.id}`)).json();
    assert.equal(recovered.requests.length, 3);
    assert.equal('token' in recovered, false);
    assert.equal('attempts' in recovered, false);
    const socket = new WebSocket(server.url.replace('http:', 'ws:') + '/api/live', { headers: { Cookie: issuer.cookie(), Origin: server.url } });
    const initial: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Missing private initial snapshots')); }, 1000);
      socket.on('error', reject);
      socket.on('message', data => { initial.push(JSON.parse(data.toString())); if (initial.length === 3) { clearTimeout(timeout); resolve(); } });
    });
    socket.terminate();
    assert.ok(initial.every(event => (event as { type: string }).type === 'account.signin.requested'));
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await issuer(`/api/accounts/signin-links/${created.link.id}/approve`, { code: '9999' })).status, 403);
    const revoked = await (await issuer(`/api/accounts/signin-links/${created.link.id}`)).json();
    assert.equal(revoked.state, 'revoked');
    assert.ok(revoked.requests.every((request: { state: string }) => request.state === 'cancelled'));
    assert.equal((await candidates[0]!(`/api/accounts/signin-requests/${pending[0].request.id}/finish`, { token: created.token })).status, 403);
  } finally { await server.close(); }
});

test('link approval cancels competitors, lost finish redelivers one cookie session, and expiry never renews', async () => {
  const server = await startMockServer({ scenario: 'signed-out' });
  try {
    const issuer = browser(server.url), candidate = browser(server.url), competitor = browser(server.url);
    await register(issuer, server.url);
    const created = await (await issuer('/api/accounts/signin-links', {})).json();
    const pending = await (await candidate('/api/accounts/signin-requests', { token: created.token })).json();
    const other = await (await competitor('/api/accounts/signin-requests', { token: created.token })).json();
    const resend = await candidate(`/api/accounts/signin-requests/${pending.request.id}/resend`, { token: created.token });
    assert.equal(resend.status, 429);
    assert.ok(Number(resend.headers.get('Retry-After')) > 0);
    assert.equal((await issuer(`/api/accounts/signin-links/${created.link.id}/approve`, { code: pending.code })).status, 200);
    assert.equal((await (await competitor(`/api/accounts/signin-requests/${other.request.id}`)).json()).state, 'cancelled');
    await issuer('/__mock/action', { type: 'device-fault', fault: 'finish-lost' });
    const lost = await candidate(`/api/accounts/signin-requests/${pending.request.id}/finish`, { token: created.token });
    await assert.rejects(lost.json());
    const first = await (await candidate('/api/accounts/session')).json();
    const repeated = await (await candidate(`/api/accounts/signin-requests/${pending.request.id}/finish`, { token: created.token })).json();
    assert.deepEqual(repeated, first);
    assert.equal((await (await issuer(`/api/accounts/signin-links/${created.link.id}`)).json()).expiresAt, created.link.expiresAt);
    await issuer('/__mock/action', { type: 'device-expire', linkId: created.link.id });
    assert.equal((await candidate(`/api/accounts/signin-requests/${pending.request.id}/finish`, { token: created.token })).status, 403);
    assert.equal((await candidate('/api/accounts/session')).status, 200);
  } finally { await server.close(); }
});
