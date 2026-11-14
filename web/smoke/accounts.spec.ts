import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { launchMock } from './launcher';
import { virtualAuthenticator, authPreferences, registerFixture, acknowledgeKit, accountSettings } from './account-browser';

let app: Awaited<ReturnType<typeof launchMock>>;
test.beforeAll(async () => { app = await launchMock(); app.url = app.url.replace('127.0.0.1', 'localhost'); });
test.afterAll(async () => { await app?.close(); });

test('native registration, exact recovery kit exports and acknowledgement gate, logout and native sign-in', async ({ page, context }) => {
  await authPreferences(page, app.url);
  await virtualAuthenticator(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { kit, accountId, phrase } = await registerFixture(page, app.url);
  expect(phrase.split(' ')).toHaveLength(12);
  expect(phrase).toContain('yo-yo');
  await expect(page).not.toHaveURL(/invite=/);
  await expect(kit.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await expect(kit).toBeVisible();
  await kit.getByRole('button', { name: 'Copy recovery kit' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`Account ID: ${accountId}`); expect(copied).toContain(`Recovery phrase: ${phrase}`);
  const downloadPromise = page.waitForEvent('download');
  await kit.getByRole('button', { name: 'Download recovery kit' }).click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!, 'utf8')).toEqual(copied);
  await acknowledgeKit(page);
  await accountSettings(page);
  await expect(page.getByRole('button', { name: 'Remove: Passkey', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Come on in.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await accountSettings(page);
  await expect(page.locator('.account-panel')).toContainText(accountId);
});

test('manual recovery supports full and partial paste, keyboard navigation and narrow scrolling; operator proof stays exact', async ({ page, context }) => {
  await authPreferences(page, app.url); await virtualAuthenticator(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = await registerFixture(page, app.url); await acknowledgeKit(page);
  await accountSettings(page); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: 'Recover access', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account ID', exact: true }).fill(first.accountId);
  await page.evaluate(() => navigator.clipboard.writeText('WRONG PARTIAL'));
  await page.getByRole('textbox', { name: 'Word 2', exact: true }).focus(); await page.keyboard.press('Control+V');
  await expect(page.getByRole('textbox', { name: 'Word 2', exact: true })).toHaveValue('wrong');
  await expect(page.getByRole('textbox', { name: 'Word 3', exact: true })).toHaveValue('partial');
  await page.evaluate((phrase) => navigator.clipboard.writeText(`  ${phrase.toUpperCase().replaceAll(' ', '\n')}  `), first.phrase);
  await page.getByRole('textbox', { name: 'Word 6', exact: true }).focus(); await page.keyboard.press('Control+V');
  for (const [i, word] of first.phrase.split(' ').entries()) await expect(page.getByRole('textbox', { name: `Word ${i + 1}`, exact: true })).toHaveValue(word);
  await page.getByRole('textbox', { name: 'Word 11', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Word 12', exact: true })).toBeFocused();
  const replace = page.getByRole('button', { name: 'Create replacement passkey', exact: true });
  await replace.scrollIntoViewIfNeeded(); await expect(replace).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await replace.click();
  const kit = page.getByRole('dialog', { name: 'Keep your way back.', exact: true }); await expect(kit).toBeVisible();
  await expect(kit.locator('dd')).toHaveText(first.accountId);
  expect((await kit.locator('ol strong').allTextContents()).join(' ')).not.toEqual(first.phrase);
  await acknowledgeKit(page); await page.setViewportSize({ width: 1440, height: 1000 });
  const proof = '  Mock-Operator-Proof+EXACT  ';
  await page.evaluate(({ proof, accountId }) => { location.hash = new URLSearchParams({ recover: proof, account: accountId }).toString(); }, { proof, accountId: first.accountId });
  await expect(page.getByRole('textbox', { name: 'Word 1', exact: true })).toHaveCount(0);
  const request = page.waitForRequest(r => r.url().endsWith('/accounts/recovery/begin'));
  await page.getByRole('button', { name: 'Create replacement passkey', exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ accountId: first.accountId, proof });
  await expect(kit).toBeVisible(); await expect(page).not.toHaveURL(/recover=|account=/); await acknowledgeKit(page);
});

test('settings add restarts on proof expiry at finish; remove, last-key race, regenerate and close guards preserve chat and voice', async ({ page }) => {
  await authPreferences(page, app.url); const original = await virtualAuthenticator(page);
  await registerFixture(page, app.url); await acknowledgeKit(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('keep this draft');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('toolbar')).toBeVisible();
  await accountSettings(page);
  await page.request.post(app.url + '/__mock/action', { data: { type: 'account-fault', fault: 'finish-expired' } });
  const spare = await virtualAuthenticator(page, 'usb', original.client);
  let begins = 0; let reauths = 0;
  await spare.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: spare.authenticatorId, enabled: false });
  await page.route('**/accounts/*/begin', async route => {
    const add = route.request().url().endsWith('/accounts/passkeys/begin');
    const verify = route.request().url().endsWith('/accounts/reauthentication/begin');
    if (add) begins++; if (verify) reauths++;
    if (add || verify) {
      await original.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: original.authenticatorId, enabled: verify });
      await spare.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: spare.authenticatorId, enabled: add });
    }
    await route.continue();
  });
  await page.getByRole('textbox', { name: 'Passkey label (optional)', exact: true }).fill('Travel key with a long but useful label');
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  const remove = page.getByRole('button', { name: 'Remove: Travel key with a long but useful label', exact: true });
  await expect(remove).toBeVisible(); expect(begins).toBe(2); expect(reauths).toBe(1);
  await page.request.post(app.url + '/__mock/action', { data: { type: 'account-fault', fault: 'last-passkey' } });
  await remove.click(); await expect(page.getByRole('alert')).toContainText(/last passkey/i); await expect(remove).toBeVisible();
  await remove.click(); await expect(remove).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove: Passkey', exact: true })).toBeDisabled();
  await page.request.post(app.url + '/__mock/action', { data: { type: 'expire-proof' } });
  await page.getByRole('button', { name: 'Regenerate recovery phrase', exact: true }).click();
  await page.getByRole('button', { name: 'Create new recovery kit', exact: true }).click();
  const kit = page.getByRole('dialog', { name: 'Keep your way back.', exact: true }); await expect(kit).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); await expect(kit).toBeVisible();
  await page.mouse.click(1, 1); await expect(kit).toBeVisible(); await acknowledgeKit(page);
  expect(reauths).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('keep this draft');
  await expect(page.getByRole('toolbar')).toBeVisible();
});

test('guest upgrades retain owner, ready attachment, colour, history and unsent text; another account clears draft and media', async ({ page }) => {
  const initial = await authPreferences(page, app.url, 'populated'); await virtualAuthenticator(page);
  await page.goto(app.url + '/?scenario=populated');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('guest draft stays');
  const roomId = initial.rooms[0]!.id;
  await page.request.post(`${app.url}/api/rooms/${roomId}/messages`, { data: { requestKey: 'guest-history', body: 'Guest historical message' } });
  await expect(page.getByText('Guest historical message', { exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'draft.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>') });
  await expect(page.locator('.tray-item')).toHaveCount(1);
  await expect(page.locator('.tray-item')).toHaveClass(/ready/);
  await page.evaluate(() => { location.hash = 'invite=mock-invitation'; });
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  const kit = page.getByRole('dialog', { name: 'Keep your way back.', exact: true }); await expect(kit).toBeVisible();
  await expect(kit.locator('dd')).toHaveText(initial.visitor!.id); await acknowledgeKit(page);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('guest draft stays');
  await expect(page.locator('.tray-item')).toHaveCount(1); await expect(page.getByText('Guest historical message', { exact: true })).toBeVisible();
  const account = await (await page.request.get(app.url + '/api/accounts/session')).json();
  expect(account.kind).toBe('account'); expect(account.visitor.colour).toEqual(initial.visitor!.colour);
  await page.getByRole('button', { name: 'Join', exact: true }).click(); await expect(page.getByRole('toolbar')).toBeVisible();
  await page.evaluate(() => { location.hash = 'invite=mock-invitation-second'; });
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Other account');
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click(); await expect(kit).toBeVisible();
  expect(await kit.locator('dd').innerText()).not.toBe(initial.visitor!.id); await acknowledgeKit(page);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(page.locator('.tray-item')).toHaveCount(0); await expect(page.getByRole('toolbar')).toHaveCount(0);
  expect((await (await page.request.get(app.url + '/__mock/state')).json()).voiceConnections).toEqual({});
});

test('invalid invitation remains retryable; unknown finish restores committed session without fabricated kit', async ({ page }) => {
  await authPreferences(page, app.url); await virtualAuthenticator(page);
  await page.goto(app.url + '/?scenario=signed-out#invite=mock-invitation');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Taylor');
  await page.request.post(app.url + '/__mock/action', { data: { type: 'account-fault', fault: 'invalid-proof' } });
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|expired/i);
  await page.request.post(app.url + '/__mock/action', { data: { type: 'account-fault', fault: 'finish-lost' } });
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore session', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Keep your way back.', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore session', exact: true }).click();
  await accountSettings(page);
  await page.getByRole('button', { name: 'Regenerate recovery phrase', exact: true }).click();
  await page.getByRole('button', { name: 'Create new recovery kit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep your way back.', exact: true })).toBeVisible(); await acknowledgeKit(page);
});

test('native cancellation and finish name conflict preserve the invitation for a successful retry', async ({ page }) => {
  await authPreferences(page, app.url); const native = await virtualAuthenticator(page);
  await native.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: native.authenticatorId, enabled: false });
  await page.route('**/accounts/registration/begin', async route => {
    const response = await route.fetch(); const body = await response.json(); body.options.publicKey.timeout = 1;
    await route.fulfill({ response, json: body });
  });
  await page.goto(app.url + '/?scenario=signed-out#invite=mock-invitation');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Taylor');
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/cancelled|timed out/i);
  await native.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: native.authenticatorId, enabled: true });
  await page.unroute('**/accounts/registration/begin');
  await page.route('**/accounts/registration/finish', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'name_taken', message: 'Name held' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/name/i);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Taylor');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('New name');
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep your way back.', exact: true })).toBeVisible();
  await acknowledgeKit(page);
});

test('acknowledgement reconciles a cookie logged out in another tab and releases the kit gate', async ({ page }) => {
  await authPreferences(page, app.url); await virtualAuthenticator(page);
  await registerFixture(page, app.url);
  const logout = await page.request.post(app.url + '/api/accounts/logout', { data: {} }); expect(logout.ok()).toBe(true);
  await acknowledgeKit(page);
  await expect(page.getByRole('heading', { name: 'Come on in.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('regeneration ambiguity is reported once without an automatic destructive retry', async ({ page }) => {
  await authPreferences(page, app.url); await virtualAuthenticator(page);
  await registerFixture(page, app.url); await acknowledgeKit(page); await accountSettings(page);
  let requests = 0; page.on('request', request => { if (request.url().endsWith('/accounts/recovery-codes')) requests++; });
  await page.request.post(app.url + '/__mock/action', { data: { type: 'account-fault', fault: 'regenerate-lost' } });
  await page.getByRole('button', { name: 'Regenerate recovery phrase', exact: true }).click();
  await page.getByRole('button', { name: 'Create new recovery kit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/may have|might have/i);
  await expect(page.getByRole('dialog', { name: 'Keep your way back.', exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
  await page.getByRole('button', { name: 'Create new recovery kit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep your way back.', exact: true })).toBeVisible();
  expect(requests).toBe(2); await acknowledgeKit(page);
});

test('sensitive settings reconcile a shared-cookie account switch before regenerating any phrase', async ({ page, context }) => {
  await authPreferences(page, app.url); await virtualAuthenticator(page);
  const first = await registerFixture(page, app.url); await acknowledgeKit(page);
  const firstCookies = await context.cookies();
  await page.evaluate(() => { location.hash = 'invite=mock-invitation-second'; });
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Other account');
  await page.getByRole('button', { name: 'Create your passkey', exact: true }).click();
  const kit = page.getByRole('dialog', { name: 'Keep your way back.', exact: true }); await expect(kit).toBeVisible();
  const secondId = await kit.locator('dd').innerText(); await acknowledgeKit(page);
  const secondCookies = await context.cookies();
  await context.addCookies(firstCookies); await page.reload(); await accountSettings(page);
  await expect(page.locator('.account-panel')).toContainText(first.accountId);
  await page.getByRole('button', { name: 'Regenerate recovery phrase', exact: true }).click();
  await context.addCookies(secondCookies);
  let mutations = 0; page.on('request', request => { if (request.url().endsWith('/accounts/recovery-codes')) mutations++; });
  await page.getByRole('button', { name: 'Create new recovery kit', exact: true }).click();
  await accountSettings(page);
  await expect(page.locator('.account-panel')).toContainText(secondId);
  await expect(kit).not.toBeVisible(); expect(mutations).toBe(0);
});
