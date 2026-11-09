import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { startMockServer } from './server.ts';

const running: Awaited<ReturnType<typeof startMockServer>>[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });
async function client(scenario = 'populated') {
  const server = await startMockServer({ scenario });
  running.push(server);
  let cookie = '';
  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(server.url + path, {
      method, headers: { cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0]!;
    return response;
  };
  const bootstrap = await (await call('/__mock/bootstrap', { scenario })).json();
  return { server, call, bootstrap, cookie: () => cookie };
}

test('populated bootstrap enters a visitor and pages the room history in contract order', async () => {
  const { call } = await client();
  assert.equal((await (await call('/api/me')).json()).name, 'Alex');
  const { rooms } = await (await call('/api/rooms')).json();
  assert.deepEqual(rooms.map((r: { name: string }) => r.name), ['Lounge', 'Games', 'Quiet']);
  const path = `/api/rooms/${rooms[0].id}/messages`;
  const { messages: newest } = await (await call(`${path}?limit=100`)).json();
  assert.equal(newest.length, 100);
  assert.equal(newest[0].body, 'Welcome back! Try sending a message or joining voice.');
  assert.match(newest[0].id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const { messages: older } = await (await call(`${path}?before=${newest.at(-1).id}&limit=100`)).json();
  assert.equal(older.length, 25);
  assert.ok(older[0].id < newest.at(-1).id);
  const { messages: caughtUp } = await (await call(`${path}?after=${older[0].id}&limit=100`)).json();
  assert.deepEqual(caughtUp, [...newest].reverse());
  for (const query of ['limit=101', 'limit=0', 'limit=1.5', 'before=nope', `before=${older[0].id}&after=${newest[0].id}`]) {
    assert.equal((await call(`${path}?${query}`)).status, 400);
  }
  assert.equal((await call(`${path}?before=&after=&limit=1`)).status, 200);
});

test('entry, rename and retried sends keep historical names and publish exactly one event', async () => {
  const { call, server, cookie } = await client('entry');
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/enter', { secret: 'wrong', name: 'Taylor' })).status, 403);
  assert.equal((await call('/api/enter', { secret: 'mock-access-link', name: '\u202e' })).status, 400);
  assert.equal((await call('/api/enter', { secret: 'mock-access-link', name: ' sam ' })).status, 409);
  const entered = await call('/api/enter', { secret: 'mock-access-link', name: ' Taylor ' });
  assert.equal(entered.status, 201);
  assert.equal((await entered.json()).name, 'Taylor');
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(server.url.replace('http', 'ws') + '/api/live', { origin: server.url, headers: { cookie: cookie() } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const events: { type: string; payload: { id: string; authorName: string }; v: number }[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  const { rooms } = await (await call('/api/rooms')).json();
  const path = `/api/rooms/${rooms[0].id}/messages`;
  const first = await call(path, { requestKey: 'repeat', body: '  Keep my spaces  ' });
  assert.equal(first.status, 201);
  const posted = await first.json();
  await call('/api/me', { name: 'New Name' }, 'PATCH');
  const repeated = await call(path, { requestKey: 'repeat', body: '  Keep my spaces  ' });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), posted);
  assert.equal(posted.authorName, 'Taylor');
  assert.equal((await call(path, { requestKey: 'repeat', body: 'different' })).status, 409);
  assert.equal((await call(`/api/rooms/${rooms[1].id}/messages`, { requestKey: 'repeat', body: '  Keep my spaces  ' })).status, 409);
  assert.equal((await call(path, { requestKey: '*', body: 'valid' })).status, 400);
  assert.equal((await call(path, { requestKey: 'empty', body: '  ' })).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event.type === 'message.created').length, 1);
  assert.equal(events[0]?.v, 1);
  assert.equal(events[0]?.payload.id, posted.id);
  ws.close();
});

test('controls preserve reload state, isolate sessions, reset identity and reject delayed old-generation work', async () => {
  const a = await client();
  const b = await client();
  assert.notEqual(a.bootstrap.instanceId, b.bootstrap.instanceId);
  assert.equal((await fetch(b.server.url + '/api/me', { headers: { cookie: a.cookie() } })).status, 401);
  assert.equal((await fetch(a.server.url + '/api/me', { headers: { cookie: 'falky_visitor=real-session' } })).status, 401);
  const state = a.bootstrap;
  const path = `/api/rooms/${state.rooms[0].id}/messages`;
  await a.call(path, { requestKey: 'persist', body: 'Kept on reload' });
  const reloaded = await (await a.call('/__mock/bootstrap', { scenario: 'populated' })).json();
  assert.equal(reloaded.generation, state.generation);
  assert.equal((await (await a.call(path + '?limit=1')).json()).messages[0].body, 'Kept on reload');
  await a.call('/__mock/action', { type: 'faults', faults: { delayMs: 100 } });
  const delayed = a.call(path, { requestKey: 'stale', body: 'Must not cross reset' });
  // Poll the public control state until the one-shot delay is consumed.
  for (let i = 0; i < 50; i++) {
    if ((await (await a.call('/__mock/state')).json()).faults.delayMs === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const reset = await (await a.call('/__mock/reset', {})).json();
  assert.equal(reset.generation, state.generation + 1);
  assert.notEqual(reset.visitor.id, state.visitor.id);
  assert.equal((await delayed).status, 409);
  await a.call('/__mock/bootstrap', {});
  const history = await (await a.call(path + '?limit=100')).json();
  assert.equal(history.messages[0].body, 'Welcome back! Try sending a message or joining voice.');
  assert.ok(history.messages.every((message: { body: string }) => !['Must not cross reset', 'Kept on reload'].includes(message.body)));
  assert.equal((await (await b.call('/api/me')).json()).id, b.bootstrap.visitor.id);
  const entry = await (await a.call('/__mock/bootstrap', { scenario: 'entry' })).json();
  assert.equal(entry.scenario, 'entry');
  assert.equal(entry.visitor, null);
  assert.equal((await a.call('/api/me')).status, 401);
  assert.equal((await fetch(a.server.url + '/__mock/reset', { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});

test('scripted failures and lost responses retry once while WebSocket outages catch up through HTTP', async () => {
  const { call, bootstrap, server, cookie } = await client();
  const roomId = bootstrap.rooms[0].id;
  const path = `/api/rooms/${roomId}/messages`;
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(server.url.replace('http', 'ws') + '/api/live', { origin: server.url, headers: { cookie: cookie() } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const events: { type: string; payload: { id: string } }[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  await call('/__mock/action', { type: 'faults', faults: { send: 'fail' } });
  assert.equal((await call(path, { requestKey: 'retry', body: 'Retry me' })).status, 503);
  assert.equal((await call(path, { requestKey: 'retry', body: 'Retry me' })).status, 201);
  await call('/__mock/action', { type: 'faults', faults: { send: 'lost-response' } });
  await assert.rejects(call(path, { requestKey: 'lost', body: 'Response lost' }));
  const repeated = await call(path, { requestKey: 'lost', body: 'Response lost' });
  assert.equal(repeated.status, 200);
  const lost = await repeated.json();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event.type === 'message.created').length, 2);
  const closed = new Promise((resolve) => ws.once('close', resolve));
  await call('/__mock/action', { type: 'faults', faults: { liveDisconnected: true } });
  await closed;
  await call('/__mock/action', { type: 'message', roomId, body: 'While disconnected' });
  await call('/__mock/action', { type: 'faults', faults: { liveDisconnected: false } });
  const reconnected = new WebSocket(server.url.replace('http', 'ws') + '/api/live', { origin: server.url, headers: { cookie: cookie() } });
  await new Promise<void>((resolve, reject) => { reconnected.once('open', resolve); reconnected.once('error', reject); });
  const { messages } = await (await call(path + '?after=' + lost.id)).json();
  assert.deepEqual(messages.map((message: { body: string }) => message.body), ['While disconnected']);
  reconnected.close();
});

test('voice moves retain the old room on failure and scripted peers, rename, leave and revocation agree with occupancy', async () => {
  const { call, bootstrap, server, cookie } = await client();
  const [lounge, games] = bootstrap.rooms;
  const visitorId = bootstrap.visitor.id;
  const roomState = async () => (await (await call('/api/rooms')).json()).rooms as { id: string; occupancy: { visitorId: string; name: string }[] }[];
  assert.equal((await call(`/api/rooms/${lounge.id}/voice`, {})).status, 200);
  assert.ok((await roomState())[0]!.occupancy.some((peer) => peer.visitorId === visitorId));
  await call('/__mock/action', { type: 'faults', faults: { roomFull: games.id } });
  assert.equal((await call(`/api/rooms/${games.id}/voice`, {})).status, 409);
  assert.equal((await (await call('/__mock/state')).json()).voiceRoomId, lounge.id);
  assert.ok((await roomState())[0]!.occupancy.some((peer) => peer.visitorId === visitorId));
  await call('/__mock/action', { type: 'faults', faults: { roomFull: lounge.id } });
  assert.equal((await call(`/api/rooms/${lounge.id}/voice`, {})).status, 409);
  await call('/api/me', { name: 'Voice Name' }, 'PATCH');
  assert.equal((await roomState())[0]!.occupancy.find((peer) => peer.visitorId === visitorId)?.name, 'Voice Name');
  await call('/__mock/action', { type: 'participants', roomId: lounge.id, participants: [{ connectionId: 'casey.connection', visitorId: '01JBX6Z8Q3M5W2K7R9T4V1C0DE', name: 'Casey', muted: false, deafened: false, sharing: true }] });
  assert.deepEqual((await roomState())[0]!.occupancy.map((peer) => peer.name), ['Casey', 'Voice Name']);
  await call('/__mock/action', { type: 'voice-leave', generation: bootstrap.generation });
  assert.deepEqual((await roomState())[0]!.occupancy.map((peer) => peer.name), ['Casey']);
  assert.equal((await call('/__mock/action', { type: 'voice-leave', generation: 0 })).status, 409);
  await call('/__mock/action', { type: 'name-conflict', active: true });
  assert.equal((await (await call('/api/me')).json()).nameTaken, true);
  assert.equal((await call(`/api/rooms/${games.id}/voice`, {})).status, 409);
  assert.equal((await call(`/api/rooms/${lounge.id}/messages`, { requestKey: 'conflict-chat', body: 'Chat remains available' })).status, 201);
  await call('/api/me', { name: 'Free Name' }, 'PATCH');
  const { WebSocket } = await import('ws');
  const denied = new WebSocket(server.url.replace('http', 'ws') + '/api/live', { origin: 'https://foreign.example', headers: { cookie: cookie() } });
  denied.on('error', () => {});
  assert.equal(await new Promise<number>((resolve) => denied.once('unexpected-response', (_, response) => { resolve(response.statusCode!); response.resume(); denied.terminate(); })), 403);
  const ws = new WebSocket(server.url.replace('http', 'ws') + '/api/live', { origin: server.url, headers: { cookie: cookie() } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await call(`/api/rooms/${games.id}/voice`, {});
  const revoked = new Promise<{ type: string }>((resolve) => ws.on('message', (raw) => { const event = JSON.parse(String(raw)); if (event.type === 'access.revoked') resolve(event); }));
  const closed = new Promise<number>((resolve) => ws.once('close', resolve));
  await call('/__mock/action', { type: 'revoke' });
  assert.equal((await revoked).type, 'access.revoked');
  assert.equal(await closed, 4001);
  assert.equal((await call('/api/me')).status, 401);
  const state = await (await call('/__mock/state')).json();
  assert.equal(state.voiceRoomId, null);
  assert.ok(state.rooms.every((room: { occupancy: { visitorId: string }[] }) => room.occupancy.every((peer) => peer.visitorId !== visitorId)));
  await call('/__mock/reset', {});
  await call('/__mock/bootstrap', {});
  assert.equal((await call('/api/me')).status, 200);
});

test('live upgrades require the instance session and enforce the public frame-size contract', async () => {
  const { server, cookie } = await client();
  const { WebSocket } = await import('ws');
  const endpoint = server.url.replace('http', 'ws') + '/api/live';
  const denied = new WebSocket(endpoint, { origin: server.url });
  denied.on('error', () => {});
  assert.equal(await new Promise<number>((resolve) => denied.once('unexpected-response', (_, response) => { resolve(response.statusCode!); response.resume(); denied.terminate(); })), 401);
  const ws = new WebSocket(endpoint, { origin: server.url, headers: { cookie: cookie() } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise<number>((resolve) => ws.once('close', resolve));
  ws.send('x'.repeat(32 * 1024 + 1));
  assert.equal(await closed, 1009);
});

test('a restarted instance at the same origin has fresh identity and room history', async () => {
  const first = await client();
  const oldOrigin = first.server.url;
  const oldCookie = first.cookie();
  await first.call(`/api/rooms/${first.bootstrap.rooms[0].id}/messages`, { requestKey: 'restart', body: 'Not on disk' });
  await first.server.close();
  running.splice(running.indexOf(first.server), 1);
  const restarted = await startMockServer({ port: Number(new URL(oldOrigin).port) });
  running.push(restarted);
  assert.equal(restarted.url, oldOrigin);
  // A new connection models a restarted browser request rather than reusing
  // undici's still-closing pooled socket from the terminated server.
  const { get } = await import('node:http');
  const fresh = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(oldOrigin + path, { agent: false, headers: { cookie: oldCookie } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    }).on('error', reject);
  });
  assert.equal((await fresh('/api/me')).status, 401);
  const state = JSON.parse((await fresh('/__mock/state')).body);
  assert.notEqual(state.instanceId, first.bootstrap.instanceId);
  assert.notEqual(state.visitor.id, first.bootstrap.visitor.id);
  assert.equal(state.generation, 1);
});

test('malformed name and message field types are invalid_request while missing or blank values keep their domain errors', async () => {
  const { call, bootstrap } = await client();
  const messages = `/api/rooms/${bootstrap.rooms[0].id}/messages`;
  async function expectError(path: string, input: unknown, code: string, method = 'POST') {
    const response = await call(path, input, method);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
  }
  for (const value of [42, false, null, [], {}]) {
    await expectError('/api/enter', { secret: 'mock-access-link', name: value }, 'invalid_request');
    await expectError('/api/me', { name: value }, 'invalid_request', 'PATCH');
    await expectError(messages, { requestKey: 'shape-check', body: value }, 'invalid_request');
  }
  for (const value of [undefined, '', '   ']) {
    await expectError('/api/enter', { secret: 'mock-access-link', name: value }, 'invalid_name');
    await expectError('/api/me', { name: value }, 'invalid_name', 'PATCH');
    await expectError(messages, { requestKey: 'shape-check', body: value }, 'invalid_message');
  }
});

test('colour routes confirm exact duplicate choices, validate bounded explicit lookup and recover historical revisions without a roster', async () => {
  const { call, bootstrap, server } = await client();
  const me = await (await call('/api/me')).json();
  assert.equal(me.colour.visitorId, me.id); assert.equal(me.colour.revision, 1);
  const samId = bootstrap.rooms[0].occupancy[0].visitorId;
  const initial = await (await call('/api/visitor-colours', { visitorIds: [samId, me.id, samId, 'unknown'] })).json();
  assert.deepEqual(initial.colours.map((c: { visitorId: string }) => c.visitorId), [samId, me.id]);
  assert.equal((await fetch(server.url + '/api/me/colour', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"palette":"moss"}' })).status, 401);
  for (const input of [{}, { palette: 'plaid' }, { palette: null }]) assert.equal((await call('/api/me/colour', input, 'PUT')).status, 400);
  assert.deepEqual((await (await call('/api/me')).json()).colour, me.colour);
  const duplicate = await (await call('/api/me/colour', { palette: initial.colours[0].palette, visitorId: samId }, 'PUT')).json();
  assert.equal(duplicate.visitorId, me.id); assert.equal(duplicate.palette, initial.colours[0].palette); assert.equal(duplicate.revision, 2);
  assert.deepEqual((await (await call('/api/visitor-colours', { visitorIds: [samId] })).json()).colours[0], initial.colours[0]);
  const same = await (await call('/api/me/colour', { palette: duplicate.palette }, 'PUT')).json(); assert.equal(same.revision, 3);
  assert.deepEqual((await (await call('/api/me', { name: 'Colour owner' }, 'PATCH')).json()).colour, same);
  for (const input of [{}, { visitorIds: null }, { visitorIds: Array(101).fill(samId) }]) assert.equal((await call('/api/visitor-colours', input)).status, 400);
  assert.deepEqual(await (await call('/api/visitor-colours', { visitorIds: [] })).json(), { colours: [] });
  await call('/__mock/action', { type: 'participants', roomId: bootstrap.rooms[0].id, participants: [] });
  await call('/__mock/action', { type: 'colour', visitorId: samId, palette: 'ruby' });
  assert.deepEqual(await (await call('/api/visitor-colours', { visitorIds: [samId] })).json(), { colours: [{ visitorId: samId, palette: 'ruby', revision: 2 }] });
  const reload = await (await call('/__mock/bootstrap', {})).json(); assert.deepEqual(reload.visitor.colour, same);
});

test('after palette exhaustion automatic historical assignments avoid connected-held colours when offline-only colours exist', async () => {
  const { call, bootstrap } = await client();
  const roomId = bootstrap.rooms[0].id;
  const peerIds = bootstrap.rooms[0].occupancy.map((p: { visitorId: string }) => p.visitorId);
  const held = new Set((await (await call('/api/visitor-colours', { visitorIds: peerIds })).json()).colours.map((c: { palette: string }) => c.palette));
  // Scripted voice peers remain connected; these new historical authors never join.
  for (let i = 0; i < 22; i++) await call('/__mock/action', { type: 'message', roomId, authorName: `Offline ${i}`, body: `History ${i}` });
  const history = (await (await call(`/api/rooms/${roomId}/messages?limit=100`)).json()).messages;
  const authorIds = history.filter((m: { authorName: string }) => m.authorName.startsWith('Offline ')).reverse().map((m: { authorId: string }) => m.authorId);
  const colours = (await (await call('/api/visitor-colours', { visitorIds: authorIds })).json()).colours;
  for (const colour of colours.slice(16)) assert.ok(!held.has(colour.palette), 'Exhausted allocations must not reuse a connected-held colour while offline-only choices remain');
});

test('colour saves broadcast to both tabs, fail without changing state and delayed old responses retain their accepted revision', async () => {
  const { call, server, cookie } = await client();
  const { WebSocket } = await import('ws');
  const tabs = [0, 1].map(() => new WebSocket(server.url.replace('http', 'ws') + '/api/live', { origin: server.url, headers: { cookie: cookie() } }));
  try {
    await Promise.all(tabs.map((ws) => new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); })));
    const events: { type: string; payload: { visitorId: string; palette: string; revision: number } }[][] = [[], []];
    tabs.forEach((ws, i) => ws.on('message', (raw) => events[i]!.push(JSON.parse(String(raw)))));
    const original = (await (await call('/api/me')).json()).colour;
    await call('/__mock/action', { type: 'faults', faults: { colourSave: 'fail' } });
    assert.equal((await call('/api/me/colour', { palette: 'rose' }, 'PUT')).status, 503);
    assert.deepEqual((await (await call('/api/me')).json()).colour, original);
    await call('/__mock/action', { type: 'faults', faults: { colourResponseDelayMs: 150 } });
    const delayed = call('/api/me/colour', { palette: 'rose' }, 'PUT');
    for (let i = 0; i < 100; i++) {
      if ((await (await call('/api/me')).json()).colour.revision === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const latest = await (await call('/api/me/colour', { palette: 'moss' }, 'PUT')).json();
    const older = await (await delayed).json();
    assert.equal(older.revision, 2); assert.equal(older.palette, 'rose'); assert.equal(latest.revision, 3);
    assert.deepEqual((await (await call('/api/me')).json()).colour, latest);
    for (const received of events) assert.deepEqual(received.filter((e) => e.type === 'visitor.colour.changed').map((e) => e.payload), [older, latest]);
    const closed = Promise.all(tabs.map((ws) => new Promise((resolve) => ws.once('close', resolve))));
    await call('/__mock/action', { type: 'faults', faults: { liveDisconnected: true } }); await closed;
    await call('/__mock/action', { type: 'colour', visitorId: latest.visitorId, palette: 'ruby' });
    assert.deepEqual((await (await call('/api/visitor-colours', { visitorIds: [latest.visitorId] })).json()).colours, [{ visitorId: latest.visitorId, palette: 'ruby', revision: 4 }]);
  } finally { tabs.forEach((ws) => ws.terminate()); }
});

test('independent grants list same-person connections and exact Leave preserves the others', async () => {
  const { call, bootstrap } = await client('same-person');
  const roomId = bootstrap.rooms[0].id;
  const first = await (await call(`/api/rooms/${roomId}/voice`, {})).json();
  const second = await (await call(`/api/rooms/${roomId}/voice`, {})).json();
  assert.notEqual(first.grantId, second.grantId);
  const occupants = async () => (await (await call('/api/rooms')).json()).rooms[0].occupancy;
  assert.deepEqual((await occupants()).map((p: { visitorId: string }) => p.visitorId), [bootstrap.visitor.id, bootstrap.visitor.id, bootstrap.visitor.id, bootstrap.visitor.id]);
  await call('/api/voice/leave', { grantId: first.grantId });
  assert.deepEqual((await occupants()).map((p: { connectionId: string }) => p.connectionId), [bootstrap.peers[roomId][0].connectionId, bootstrap.peers[roomId][1].connectionId, second.grantId]);
});
