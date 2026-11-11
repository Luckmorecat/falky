import { test, expect } from '@playwright/test';
import { launchMock } from './launcher';
import { virtualAuthenticator, authPreferences, registerFixture, acknowledgeKit, accountSettings } from './account-browser';
import { devicePage, requestQR, previewQR, createLink, receiveLink, session } from './device-browser';

let app: Awaited<ReturnType<typeof launchMock>>;
test.beforeAll(async () => { app = await launchMock(); app.url = app.url.replace('127.0.0.1', 'localhost'); });
test.afterAll(async () => { await app?.close(); });

async function issuer(page: Parameters<typeof authPreferences>[0]) {
  const state = await authPreferences(page, app.url);
  const authenticator = await virtualAuthenticator(page);
  await registerFixture(page, app.url); await acknowledgeKit(page); await accountSettings(page);
  return { state, authenticator, identity: await session(page, app.url) };
}

test('QR retry recovers an initial network failure and a lost browser binding', async ({ page, browser }) => {
  const state = await authPreferences(page, app.url);
  const receiver = await devicePage(browser, state);
  const replacements: boolean[] = [];
  try {
    await receiver.route('**/api/accounts/qr-signins', async route => {
      replacements.push(route.request().postDataJSON().replace);
      if (replacements.length === 1) await route.abort('failed');
      else await route.continue();
    });
    await receiver.goto(app.url);
    await receiver.getByRole('button', { name: 'Use another device', exact: false }).click();
    await expect(receiver.getByRole('heading', { name: /unavailable/i })).toBeVisible();
    const allocation = receiver.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/qr-signins') && r.status() === 200);
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    const original = await (await allocation).json();
    await expect(receiver.getByRole('img', { name: 'QR code for this sign-in request', exact: true })).toBeVisible();
    expect(replacements).toEqual([false, false]);

    await receiver.context().clearCookies({ name: `falky_mock_signin_${state.instanceId}` });
    await expect(receiver.getByRole('heading', { name: /unavailable/i })).toBeVisible();
    const recovery = receiver.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/qr-signins') && r.status() === 200);
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    const recovered = await (await recovery).json();
    await expect(receiver.getByRole('img', { name: 'QR code for this sign-in request', exact: true })).toBeVisible();
    expect(recovered.request.id).not.toBe(original.request.id);
    expect(replacements).toEqual([false, false, true, false]);
  } finally { await receiver.context().close(); }
});

test('QR detection only previews; explicit approval delivers the candidate cookie and preserves exact issuer session', async ({ page, browser, context }) => {
  const { state, identity } = await issuer(page);
  await expect(page.getByRole('tab', { name: 'Account', exact: true })).toBeFocused();
  const before = await context.cookies();
  const receiver = await devicePage(browser, state);
  try {
    const qr = await requestQR(receiver, app.url);
    await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
    await expect(page.locator('.device-scanner-identity')).toContainText('Taylor');
    await expect(page.getByRole('textbox', { name: 'Paste QR link', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Use camera', exact: true }).click();
    await page.evaluate(url => dispatchEvent(new CustomEvent('falky:mock-qr', { detail: url })), qr.url);
    await expect(page.getByRole('button', { name: 'Approve sign-in', exact: true })).toBeVisible();
    await expect(receiver.getByText('Waiting for approval', { exact: false })).toBeVisible();
    expect((await session(receiver, app.url)).kind).not.toBe('account');
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    expect((await session(receiver, app.url)).visitor.id).toBe(identity.visitor.id);
    expect(await session(page, app.url)).toEqual(identity);
    expect(await context.cookies()).toEqual(before);
    let releasePasskeys!: () => void;
    const passkeyRefresh = new Promise<void>(resolve => { releasePasskeys = resolve; });
    await page.route('**/api/accounts/passkeys', async route => {
      if (route.request().method() === 'GET') await passkeyRefresh;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeDisabled();
    releasePasskeys();
    await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
    await page.getByRole('button', { name: 'Create a sign-in link instead', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Sign-in link', exact: true })).toBeVisible();
    await expect(page.locator('.device-scanner')).toHaveCount(0);
  } finally { await receiver.context().close(); }
});

test('link requests recover after issuer reload without copy authority; leading-zero code picks one of three and preserves issuer ownership', async ({ page, browser, context }) => {
  const { state, identity } = await issuer(page);
  const cookies = await context.cookies();
  const linkResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/signin-links'));
  const link = await createLink(page);
  const record = await (await linkResponse).json();
  const candidates = await Promise.all([devicePage(browser, state), devicePage(browser, state), devicePage(browser, state)]);
  try {
    const codes = [];
    for (const candidate of candidates) codes.push(await receiveLink(candidate, link));
    expect(codes[0]).toBe('0000'); expect(new Set(codes).size).toBe(3);
    await expect(page.locator('.device-pending')).toHaveCount(3);
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill('9999');
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That code was not accepted');
    await page.reload(); await accountSettings(page);
    await expect(page.locator('.device-pending')).toHaveCount(3);
    await expect(page.getByRole('textbox', { name: 'Sign-in link', exact: true })).toHaveCount(0);
    await expect(page.getByText('This link can no longer be copied.', { exact: false })).toBeVisible();
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(codes[0]!);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(candidates[0]!.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    for (const candidate of candidates.slice(1)) await expect(candidate.getByRole('heading', { name: /cancelled|unavailable/i })).toBeVisible();
    expect((await session(candidates[0]!, app.url)).visitor.id).toBe(identity.visitor.id);
    expect(await session(page, app.url)).toEqual(identity);
    expect(await context.cookies()).toEqual(cookies);
    const forbidden = await candidates[0]!.request.get(`${app.url}/api/accounts/signin-links/${record.link.id}`);
    expect(forbidden.status()).toBe(403);
  } finally { await Promise.all(candidates.map(candidate => candidate.context().close())); }
});

test('QR denial and expiry, link revoke and per-request denial remain authoritative terminal states', async ({ page, browser }) => {
  const { state } = await issuer(page);
  const receiver = await devicePage(browser, state);
  try {
    await previewQR(page, (await requestQR(receiver, app.url)).url);
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: /denied/i })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const replacement = receiver.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/qr-signins'));
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    const qr = await (await replacement).json();
    await expect(receiver.getByRole('img', { name: 'QR code for this sign-in request', exact: true })).toBeVisible();
    await page.request.post(app.url + '/__mock/action', { data: { type: 'device-expire', requestId: qr.request.id } });
    await expect(receiver.getByRole('heading', { name: /expired|unavailable/i })).toBeVisible();
    const link = await createLink(page);
    await receiver.getByRole('button', { name: 'Back', exact: true }).click();
    await receiveLink(receiver, link);
    await expect(page.locator('.device-pending')).toHaveCount(1);
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: /denied/i })).toBeVisible();
    const revoking = await devicePage(browser, state);
    try {
      await receiveLink(revoking, link);
      await page.getByRole('button', { name: 'Revoke link', exact: true }).click();
      await expect(revoking.getByRole('heading', { name: /cancelled|unavailable/i })).toBeVisible();
    } finally { await revoking.context().close(); }
    expect((await session(receiver, app.url)).kind).not.toBe('account');
  } finally { await receiver.context().close(); }
});

test('server cooldown prevents allocation loops and fifth wrong code revokes the link', async ({ page, browser }) => {
  const { state } = await issuer(page);
  const receiver = await devicePage(browser, state);
  try {
    await receiver.goto(app.url);
    await page.request.post(app.url + '/__mock/action', { data: { type: 'device-fault', fault: 'rate-limited' } });
    let allocations = 0;
    receiver.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/accounts/qr-signins')) allocations++; });
    await receiver.getByRole('button', { name: 'Use another device', exact: false }).click();
    await expect(receiver.getByRole('alert')).toContainText('Please wait');
    await expect(receiver.getByRole('button', { name: 'Try again', exact: true })).toBeDisabled();
    expect(allocations).toBe(1);
    await receiver.context().close();
    const link = await createLink(page);
    const waiting = await devicePage(browser, state);
    try {
      await receiveLink(waiting, link);
      for (let attempt = 0; attempt < 5; attempt++) {
        await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill('9999');
        const rejected = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/approve'));
        await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
        expect((await rejected).status()).toBe(403);
        if (attempt < 4) await expect(page.getByRole('button', { name: 'Approve sign-in', exact: true })).toBeEnabled();
      }
      await expect(page.getByText('Link revoked.', { exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Four-digit code', exact: true })).toHaveCount(0);
      await expect(waiting.getByRole('heading', { name: /cancelled|unavailable/i })).toBeVisible();
    } finally { await waiting.context().close(); }
  } finally { await receiver.context().close(); }
});

test('signed-out QR approver scrubs the fragment and resumes preview after real passkey authentication without approving', async ({ page, browser }) => {
  const { state, authenticator } = await issuer(page);
  const receiver = await devicePage(browser, state);
  const approver = await devicePage(browser, state);
  try {
    const qr = await requestQR(receiver, app.url);
    const { credentials } = await authenticator.client.send('WebAuthn.getCredentials', { authenticatorId: authenticator.authenticatorId });
    const native = await virtualAuthenticator(approver);
    for (const credential of credentials) await native.client.send('WebAuthn.addCredential', { authenticatorId: native.authenticatorId, credential });
    await approver.goto(qr.url);
    await expect(approver).not.toHaveURL(/qr-signin=/);
    await approver.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await expect(approver.getByRole('button', { name: 'Approve sign-in', exact: true })).toBeVisible();
    await expect(receiver.getByText('Waiting for approval', { exact: false })).toBeVisible();
    await approver.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: /denied/i })).toBeVisible();
  } finally { await receiver.context().close(); await approver.context().close(); }
});

test('lost finish response reconciles actual cookie once; a receiving account conflict never silently replaces identity', async ({ page, browser }) => {
  const { state, identity } = await issuer(page);
  const receiver = await devicePage(browser, state);
  try {
    const link = await createLink(page); const code = await receiveLink(receiver, link);
    await page.request.post(app.url + '/__mock/action', { data: { type: 'device-fault', fault: 'finish-lost' } });
    let finishes = 0;
    receiver.on('request', request => { if (request.url().endsWith('/finish') && request.method() === 'POST') finishes++; });
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    expect(finishes).toBe(1); expect((await session(receiver, app.url)).visitor.id).toBe(identity.visitor.id);
    await receiver.getByRole('button', { name: 'Done', exact: true }).click();
    await receiver.goto(link);
    await receiver.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(receiver.getByRole('alert')).toContainText(/already signed in|unavailable/i);
    expect((await session(receiver, app.url)).visitor.id).toBe(identity.visitor.id);
  } finally { await receiver.context().close(); }
});

test('foreign QR is rejected, camera failure is accessible, and leaving a delayed scanner prevents late preview', async ({ page, browser }) => {
  const { state } = await issuer(page);
  const receiver = await devicePage(browser, state);
  try {
    const qr = await requestQR(receiver, app.url);
    await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
    await page.getByRole('button', { name: 'Use camera', exact: true }).click();
    await page.evaluate(url => dispatchEvent(new CustomEvent('falky:mock-qr', { detail: url.replace('localhost', 'example.com') })), qr.url);
    await expect(page.getByRole('alert')).toContainText(/valid|Falky/i);
    await expect(page.getByRole('button', { name: 'Approve sign-in', exact: true })).toHaveCount(0);
    expect((await page.request.post(app.url + '/__mock/action', { data: { type: 'faults', faults: { scannerError: 'NotAllowedError' } } })).ok()).toBe(true);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Camera access was denied');
    expect((await page.request.post(app.url + '/__mock/action', { data: { type: 'faults', faults: { scannerError: '', scannerDelayMs: 200 } } })).ok()).toBe(true);
    await page.waitForResponse(response => response.url().endsWith('/__mock/state') && response.ok());
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Back to Account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scan QR code', exact: true })).toBeFocused();
    await page.evaluate(url => dispatchEvent(new CustomEvent('falky:mock-qr', { detail: url })), qr.url);
    await expect(page.locator('.device-scanner')).toHaveCount(0);
    expect((await session(receiver, app.url)).kind).not.toBe('account');
  } finally { await receiver.context().close(); }
});

test('guest receiving browser needs explicit consent; a different signed-in account keeps its cookie on conflict', async ({ page, browser }) => {
  const { state, identity } = await issuer(page);
  const guest = await devicePage(browser, state);
  const other = await devicePage(browser, state);
  try {
    const link = await createLink(page);
    await guest.goto(app.url + '/' + new URL(state.accessLink, app.url).hash);
    await guest.getByRole('textbox', { name: 'Name', exact: true }).fill('Guest browser');
    await guest.getByRole('button', { name: 'Join as a guest', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    const guestIdentity = await session(guest, app.url);
    expect(guestIdentity.kind).toBe('guest');
    await guest.goto(link);
    await expect(guest.getByText('Continuing may switch this browser’s account.', { exact: false })).toBeVisible();
    expect(await session(guest, app.url)).toEqual(guestIdentity);
    await expect(guest.locator('.device-code')).toHaveCount(0);
    await guest.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(guest.locator('.device-code')).toBeVisible();
    const code = (await guest.locator('.device-code').innerText()).replace(/\s/g, '');
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(guest.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    expect((await session(guest, app.url)).visitor.id).toBe(identity.visitor.id);
    await virtualAuthenticator(other);
    await other.goto(app.url + '/#invite=mock-invitation-second');
    await other.getByRole('textbox', { name: 'Name', exact: true }).fill('Other account');
    await other.getByRole('button', { name: 'Create your passkey', exact: true }).click();
    await acknowledgeKit(other);
    const otherIdentity = await session(other, app.url); const cookies = await other.context().cookies();
    const nextLink = await createLink(page);
    await other.goto(nextLink);
    await other.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(other.getByRole('alert')).toContainText('Sign out of the current account');
    expect(await session(other, app.url)).toEqual(otherIdentity);
    expect(await other.context().cookies()).toEqual(cookies);
  } finally { await guest.context().close(); await other.context().close(); }
});

test('scanner abandons preview after a shared-cookie logout in another tab without approving the candidate', async ({ page, browser, context }) => {
  const { state } = await issuer(page);
  const receiver = await devicePage(browser, state);
  const sibling = await context.newPage();
  try {
    await previewQR(page, (await requestQR(receiver, app.url)).url);
    await sibling.goto(app.url);
    expect((await sibling.request.post(app.url + '/api/accounts/logout', { data: {} })).ok()).toBe(true);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(page.locator('.device-scanner')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Come on in.', exact: true })).toBeVisible();
    expect((await session(receiver, app.url)).kind).not.toBe('account');
  } finally { await sibling.close(); await receiver.context().close(); }
});
