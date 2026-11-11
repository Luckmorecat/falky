import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMockServer } from './server.ts';

test('account registration upgrades a guest and binds one-use ceremonies to their session', async () => {
  const server = await startMockServer();
  try {
    let cookie = '';
    const call = async (path: string, data?: unknown, foreign = false) => {
      const response = await fetch(server.url + path, { method: data === undefined ? 'GET' : 'POST', headers: { cookie: foreign ? 'foreign=1' : cookie, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (!foreign && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return response;
    };
    const initial = await (await call('/__mock/bootstrap', {})).json();
    assert.equal((await (await call('/api/accounts/session')).json()).kind, 'guest');
    const begin = await call('/api/accounts/registration/begin', { invitation: 'mock-invitation', name: 'Alex' });
    assert.equal(begin.status, 200);
    const ceremony = await begin.json();
    const credential = { id: 'fixture-key', rawId: 'fixture-key', type: 'public-key', response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ceremony.options.publicKey.challenge, origin: server.url })).toString('base64url'), attestationObject: 'YXR0ZXN0YXRpb24' } };
    const finish = { ceremonyId: ceremony.id, credential };
    assert.equal((await call('/api/accounts/registration/finish', finish, true)).status, 403);
    const result = await call('/api/accounts/registration/finish', finish);
    assert.equal(result.status, 201);
    const enrollment = await result.json();
    assert.equal(enrollment.session.kind, 'account');
    assert.equal(enrollment.session.visitor.id, initial.visitor.id);
    assert.equal(enrollment.recoveryCodes[0].split(' ').length, 12);
    assert.equal((await call('/api/accounts/registration/finish', finish)).status, 403);
    assert.equal((await call('/api/accounts/logout', {})).status, 200);
    assert.equal((await call('/api/accounts/session')).status, 401);
  } finally { await server.close(); }
});

test('invitation consumption, account recovery rotation and session context remain isolated across browser cookies', async () => {
  const server = await startMockServer({ scenario: 'signed-out' });
  try {
    let cookie = '';
    const call = async (path: string, data?: unknown, selected = cookie) => {
      const response = await fetch(server.url + path, { method: data === undefined ? 'GET' : 'POST', headers: { cookie: selected, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return response;
    };
    const credential = (ceremony: { options: { publicKey: { challenge: string } } }, key: string) => ({ id: key, rawId: key, type: 'public-key', response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ceremony.options.publicKey.challenge, origin: server.url })).toString('base64url'), attestationObject: 'YXR0ZXN0YXRpb24' } });
    await call('/__mock/bootstrap', {});
    const begin = await (await call('/api/accounts/registration/begin', { invitation: 'mock-invitation', name: 'Taylor' })).json();
    const first = await (await call('/api/accounts/registration/finish', { ceremonyId: begin.id, credential: credential(begin, 'first-key') })).json();
    const oldCookie = cookie;
    assert.equal((await call('/api/accounts/registration/begin', { invitation: 'mock-invitation', name: 'Other' })).status, 403);
    const staged = await (await call('/api/accounts/recovery/begin', { accountId: first.session.visitor.id, proof: first.recoveryCodes[0] })).json();
    await call('/api/accounts/recovery-codes', {});
    assert.equal((await call('/api/accounts/recovery/finish', { ceremonyId: staged.id, credential: credential(staged, 'stale-phrase') })).status, 403);
    const proof = '  Mock-Operator-Proof+EXACT  ';
    assert.equal((await call('/api/accounts/recovery/begin', { accountId: first.session.visitor.id, proof: proof.trim() })).status, 403);
    const operator = await (await call('/api/accounts/recovery/begin', { accountId: first.session.visitor.id, proof })).json();
    await call('/api/accounts/recovery-codes', {});
    const recovered = await call('/api/accounts/recovery/finish', { ceremonyId: operator.id, credential: credential(operator, 'replacement-key') });
    assert.equal(recovered.status, 201);
    const kit = await recovered.json();
    assert.equal(kit.session.visitor.id, first.session.visitor.id);
    assert.notEqual(kit.recoveryCodes[0], first.recoveryCodes[0]);
    assert.equal((await call('/api/accounts/session', undefined, oldCookie)).status, 401);
    const list = await (await call('/api/accounts/passkeys')).json();
    assert.deepEqual(list.passkeys.map((key: { id: string }) => key.id), ['replacement-key']);
  } finally { await server.close(); }
});

test('an in-flight upload stays owned by the session that started it when another identity enters', async () => {
  const server = await startMockServer();
  try {
    const bootstrap = await fetch(server.url + '/__mock/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const state = await bootstrap.json();
    const oldCookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const form = new FormData(); form.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], { type: 'image/svg+xml' }), 'private.svg');
    const uploading = fetch(`${server.url}/api/rooms/${state.rooms[0].id}/attachments`, { method: 'POST', headers: { cookie: oldCookie }, body: form });
    await new Promise(resolve => setTimeout(resolve, 30));
    const entered = await fetch(server.url + '/api/enter', { method: 'POST', headers: { cookie: oldCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'mock-access-link', name: 'Jordan' }) });
    const nextCookie = entered.headers.get('set-cookie')!.split(';')[0]!;
    const attachment = await (await uploading).json();
    assert.equal((await fetch(`${server.url}/api/attachments/${attachment.id}`, { headers: { cookie: nextCookie } })).status, 404);
    assert.equal((await fetch(`${server.url}/api/attachments/${attachment.id}`, { headers: { cookie: oldCookie } })).status, 200);
  } finally { await server.close(); }
});
