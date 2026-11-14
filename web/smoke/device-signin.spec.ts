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

for (const width of [390, 1440]) {
  test(`scanner overlays Settings without reopening it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await issuer(page);
    const settings = page.locator('dialog.settings');
    const scan = page.getByRole('button', { name: 'Scan QR code', exact: true });
    await settings.evaluate(dialog => {
      dialog.dataset.openChanges = '0';
      new MutationObserver(records => {
        dialog.dataset.openChanges = String(Number(dialog.dataset.openChanges) + records.length);
      }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
    });
    for (const dismissal of ['back', 'escape']) {
      await scan.click();
      await expect(page.locator('.device-dialog-scanner')).toHaveJSProperty('open', true);
      await expect(settings).toHaveJSProperty('open', true);
      await expect(page.getByRole('button', { name: 'Use camera', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to Account', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Use camera', exact: true })).toBeFocused();
      if (dismissal === 'back') await page.getByRole('button', { name: 'Back to Account', exact: true }).click();
      else await page.keyboard.press('Escape');
      await expect(page.locator('.device-dialog-scanner')).toHaveCount(0);
      await expect(settings).toHaveJSProperty('open', true);
      await expect(settings).toHaveAttribute('data-open-changes', '0');
      await expect(page.getByRole('tab', { name: 'Account', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(scan).toBeFocused();
    }
  });
}

test('QR detection only previews; explicit approval delivers the candidate cookie and preserves exact issuer session', async ({ page, browser, context }) => {
  const { state, identity } = await issuer(page);
  await expect(page.getByRole('tab', { name: 'Account', exact: true })).toBeFocused();
  const before = await context.cookies();
  const receiver = await devicePage(browser, state);
  try {
    const qr = await requestQR(receiver, app.url);
    await page.getByRole('button', { name: 'Scan QR code', exact: true }).click();
    await expect(page.locator('dialog.settings')).toHaveJSProperty('open', true);
    await expect(page.locator('.device-dialog-scanner')).toHaveJSProperty('open', true);
    await expect(page.locator('.device-scanner')).not.toContainText('Your passkey account');
    await expect(page.locator('.device-scanner')).not.toContainText('Taylor');
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
    await expect(page.getByRole('button', { name: 'Create a sign-in link instead', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to Account', exact: true }).click();
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
      await expect(page.getByRole('dialog', { name: 'Sign-in link', exact: true })).not.toBeVisible();
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
    await expect(guest.locator('dialog.auth-dialog')).not.toBeVisible();
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

test('pasted links retry their allocation and retain the same request after offline finish reconciliation', async ({ page, browser }) => {
  const { state, identity } = await issuer(page);
  const link = await createLink(page);
  const receiver = await devicePage(browser, state);
  let allocations = 0, offline = false;
  const finishes: string[] = [];
  try {
    await requestQR(receiver, app.url);
    await receiver.getByRole('button', { name: 'Use a link instead', exact: true }).click();
    await receiver.route('**/api/accounts/signin-requests', async route => {
      if (++allocations === 1) await route.abort('failed'); else await route.continue();
    });
    await receiver.getByRole('textbox', { name: 'Paste a sign-in link', exact: true }).fill(link);
    await receiver.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: /unavailable/i })).toBeVisible();
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(receiver.locator('.device-code')).toBeVisible();
    expect(allocations).toBe(2);
    const code = (await receiver.locator('.device-code').innerText()).replace(/\s/g, '');
    await receiver.route('**/api/accounts/session', route => offline ? route.abort('failed') : route.continue());
    await receiver.route('**/api/accounts/signin-requests/*/finish', async route => {
      finishes.push(route.request().url());
      expect(route.request().postDataJSON().token).toBe(new URL(link).hash.slice('#signin='.length));
      if (finishes.length === 1) { offline = true; await route.abort('failed'); } else await route.continue();
    });
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(receiver.getByRole('alert')).toContainText('Could not confirm sign-in');
    await expect(receiver.locator('.device-code')).toBeVisible();
    offline = false;
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    expect(finishes).toHaveLength(2);
    expect(finishes[0]).toBe(finishes[1]);
    expect(allocations).toBe(2);
    expect((await session(receiver, app.url)).visitor.id).toBe(identity.visitor.id);
  } finally { await receiver.context().close(); }
});

for (const delivered of [true, false]) test(`uncertain finish after expiry recovers ${delivered ? 'the delivered session' : 'without another finish'}`, async ({ page, browser }) => {
  const { state, identity } = await issuer(page);
  const receiver = await devicePage(browser, state);
  let offline = false, allocations = 0, finishes = 0;
  try {
    await receiver.clock.install();
    receiver.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/accounts/signin-requests')) allocations++;
    });
    const code = await receiveLink(receiver, await createLink(page));
    await receiver.route('**/api/accounts/session', route => offline ? route.abort('failed') : route.continue());
    await receiver.route('**/api/accounts/signin-requests/*/finish', async route => {
      finishes++; offline = true;
      if (delivered) await route.continue(); else await route.abort('failed');
    });
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(receiver.getByRole('alert')).toContainText('Could not confirm sign-in');
    await receiver.clock.fastForward(6 * 60 * 1000);
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(receiver.getByRole('alert')).toContainText('Could not confirm sign-in');
    await expect(receiver.getByRole('heading', { name: /expired/i })).toHaveCount(0);
    offline = false;
    await receiver.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: delivered ? 'You’re in.' : /expired/i })).toBeVisible();
    expect(allocations).toBe(1);
    expect(finishes).toBe(1);
    const actual = await session(receiver, app.url);
    if (delivered) expect(actual.visitor.id).toBe(identity.visitor.id);
    else expect(actual.kind).not.toBe('account');
  } finally { await receiver.context().close(); }
});

test('a replacement link opened during allocation completes with the new link', async ({ page, browser }) => {
  const { state, identity } = await issuer(page);
  const firstLink = await createLink(page);
  const receiver = await devicePage(browser, state);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const bearers: string[] = [];
  try {
    await receiver.route('**/api/accounts/signin-requests', async route => {
      bearers.push(route.request().postDataJSON().token);
      if (bearers.length === 1) { started(); await blocked; await route.abort('failed'); }
      else await route.continue();
    });
    await receiver.goto(firstLink);
    await reached;
    await createLink(page);
    const linkField = page.getByRole('textbox', { name: 'Sign-in link', exact: true });
    await expect(linkField).not.toHaveValue(firstLink);
    const replacementLink = await linkField.inputValue();
    const replacement = receiver.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/signin-requests') && r.status() === 200);
    await receiver.evaluate(url => { location.hash = new URL(url).hash; }, replacementLink);
    await expect(receiver).not.toHaveURL(/signin=/);
    release();
    const allocated = await (await replacement).json();
    await expect(receiver.locator('.device-code')).toHaveText(allocated.code);
    expect(bearers).toEqual([firstLink, replacementLink].map(url => new URL(url).hash.slice('#signin='.length)));
    const finish = receiver.waitForRequest(r => r.url().endsWith(`/signin-requests/${allocated.request.id}/finish`));
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(allocated.code);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    expect((await finish).postDataJSON().token).toBe(bearers[1]);
    await expect(receiver.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    expect((await session(receiver, app.url)).visitor.id).toBe(identity.visitor.id);
  } finally { release(); await receiver.context().close(); }
});

test('a second QR entry in the same tab replaces the preview and remains actionable', async ({ page, browser }) => {
  const { state } = await issuer(page);
  const first = await devicePage(browser, state), second = await devicePage(browser, state);
  try {
    const firstQR = await requestQR(first, app.url), secondQR = await requestQR(second, app.url);
    await page.evaluate(url => { location.hash = new URL(url).hash; }, firstQR.url);
    await expect(page.getByRole('button', { name: 'Approve sign-in', exact: true })).toBeVisible();
    const preview = page.waitForResponse(r => r.url().endsWith('/qr-signins/preview') && r.status() === 200);
    await page.evaluate(url => { location.hash = new URL(url).hash; }, secondQR.url);
    await preview;
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(second.getByRole('heading', { name: /denied/i })).toBeVisible();
    await expect(first.getByText('Waiting for approval', { exact: false })).toBeVisible();
  } finally { await first.context().close(); await second.context().close(); }
});

test('an issuer can revoke an approved link before the receiver consumes it', async ({ page, browser }) => {
  const { state } = await issuer(page);
  const receiver = await devicePage(browser, state);
  try {
    await receiver.route('**/api/accounts/signin-requests/*/finish', route => route.abort('failed'));
    const code = await receiveLink(receiver, await createLink(page));
    await page.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Sign-in link', exact: true }).getByText('Sign-in approved. Waiting for the other browser.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Revoke link', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Sign-in link', exact: true })).not.toBeVisible();
    await expect(receiver.getByRole('heading', { name: /cancelled|unavailable/i })).toBeVisible();
    expect((await session(receiver, app.url)).kind).not.toBe('account');
  } finally { await receiver.context().close(); }
});

test('expired issuer hints do not pollute a replacement link with repeated unavailable errors', async ({ page, browser }) => {
  const { state } = await issuer(page);
  const receiver = await devicePage(browser, state);
  const reads = new Map<string, number>();
  page.on('request', request => {
    if (request.method() === 'GET' && /\/accounts\/signin-links\/[^/]+$/.test(request.url())) reads.set(request.url(), (reads.get(request.url()) ?? 0) + 1);
  });
  try {
    const creation = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/signin-links'));
    await receiveLink(receiver, await createLink(page));
    const old = await (await creation).json();
    await expect(page.locator('.device-pending')).toHaveCount(1);
    const oldPath = `${app.url}/api/accounts/signin-links/${old.link.id}`;
    const rejected = page.waitForResponse(r => r.url() === oldPath && r.status() === 403);
    await page.request.post(app.url + '/__mock/action', { data: { type: 'device-expire', linkId: old.link.id } });
    await rejected;
    await expect(page.getByRole('dialog', { name: 'Sign-in link', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Create sign-in link', exact: true })).toBeEnabled();
    const oldReads = reads.get(oldPath);
    const replacement = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/accounts/signin-links'));
    const nextURL = await createLink(page);
    const next = await (await replacement).json();
    const nextPath = `${app.url}/api/accounts/signin-links/${next.link.id}`;
    await expect.poll(() => reads.get(nextPath) ?? 0).toBeGreaterThanOrEqual(2);
    expect(reads.get(oldPath)).toBe(oldReads);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Sign-in link', exact: true })).toHaveValue(nextURL);
  } finally { await receiver.context().close(); }
});

for (const width of [1440, 390]) test(`sign-in drawer keeps settings stable and reopens for a new request at ${width}px`, async ({ page, browser }) => {
  await page.setViewportSize({ width, height: 844 });
  const { state, identity } = await issuer(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const drawer = page.getByRole('dialog', { name: 'Sign-in link', exact: true });
  const initialHeight = await settings.evaluate(element => (element as HTMLElement).scrollHeight);
  const slot = settings.locator('.device-link-slot');
  const initialSlotHeight = await slot.evaluate(element => (element as HTMLElement).offsetHeight);
  const link = await createLink(page);
  await expect(drawer).toBeVisible();
  const linkField = drawer.getByRole('textbox', { name: 'Sign-in link', exact: true });
  const copy = drawer.getByRole('button', { name: 'Copy link', exact: true });
  const revoke = drawer.getByRole('button', { name: 'Revoke link', exact: true });
  await expect(revoke).toHaveClass(/danger/);
  await expect(drawer.getByRole('button', { name: /Create/ })).toHaveCount(0);
  await drawer.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const linkBox = await linkField.boundingBox();
  const copyBox = await copy.boundingBox();
  expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(copyBox!.y);
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  const settingsHeight = await settings.evaluate(element => (element as HTMLElement).scrollHeight);
  expect(settingsHeight).toBe(initialHeight);
  expect(await slot.evaluate(element => (element as HTMLElement).offsetHeight)).toBe(initialSlotHeight);
  await expect(settings.getByRole('button', { name: /Create.*link/ })).toHaveCount(0);
  const item = settings.locator('.device-link-item');
  await expect(item).toContainText('Expires in');
  await expect(item.locator('time')).toHaveText(/^[0-9]+:[0-9]{2}$/);
  await settings.screenshot({ path: `screenshots/sign-in-link-item-${width}.png` });
  await expect(item).toBeFocused();
  await item.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(settings).toBeVisible();
  await item.click();
  await expect(drawer).toBeVisible();
  await drawer.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  const underlyingTab = settings.getByRole('tab', { name: 'Profile', exact: true });
  const underlyingBox = await underlyingTab.boundingBox();
  let creations = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/accounts/signin-links')) creations++; });
  await page.mouse.click(underlyingBox!.x + underlyingBox!.width / 2, underlyingBox!.y + underlyingBox!.height / 2);
  await expect(drawer).not.toBeVisible();
  await expect(settings).toBeVisible();
  expect(creations).toBe(0);
  await expect(settings.getByRole('tab', { name: 'Account', exact: true })).toHaveAttribute('aria-selected', 'true');
  await item.click();
  await expect(drawer).toBeVisible();
  await drawer.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await drawer.click({ position: { x: 8, y: 8 } });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(settings).toBeVisible();
  await page.waitForTimeout(3200);
  await expect(drawer).not.toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  const receiver = await devicePage(browser, state);
  const second = await devicePage(browser, state);
  try {
    const code = await receiveLink(receiver, link);
    await expect(drawer).toBeVisible();
    await expect(settings).not.toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Four-digit code', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await receiveLink(second, link);
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.device-pending')).toHaveCount(2);
    await drawer.getByRole('textbox', { name: 'Four-digit code', exact: true }).fill(code);
    await drawer.getByRole('button', { name: 'Approve sign-in', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: 'You’re in.', exact: true })).toBeVisible();
    expect((await session(receiver, app.url)).visitor.id).toBe(identity.visitor.id);
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await accountSettings(page);
    expect(await settings.evaluate(element => (element as HTMLElement).scrollHeight)).toBe(settingsHeight);
    await createLink(page);
    await page.route('**/api/accounts/signin-links/*', async route => {
      if (route.request().method() === 'DELETE') await route.abort('failed');
      else await route.continue();
    });
    await drawer.getByRole('button', { name: 'Revoke link', exact: true }).click();
    await expect(drawer.getByRole('alert')).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Sign-in link', exact: true })).toBeVisible();
    await page.unroute('**/api/accounts/signin-links/*');
    await drawer.getByRole('button', { name: 'Revoke link', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(settings.getByRole('button', { name: 'Create sign-in link', exact: true })).toBeVisible();
    expect(await settings.evaluate(element => (element as HTMLElement).scrollHeight)).toBe(initialHeight);
    const expiring = await createLink(page);
    expect(expiring).toBeTruthy();
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await page.clock.install();
    await page.clock.fastForward(300_001);
    await expect(item).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Create sign-in link', exact: true })).toBeEnabled();
    expect(await slot.evaluate(element => (element as HTMLElement).offsetHeight)).toBe(initialSlotHeight);
    expect(await settings.evaluate(element => (element as HTMLElement).scrollHeight)).toBe(initialHeight);
  } finally { await receiver.context().close(); await second.context().close(); }
});
