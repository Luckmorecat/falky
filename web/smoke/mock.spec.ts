import { test, expect, type Page } from '@playwright/test';
import type { MockAction, MockState } from '../mock/protocol';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
let forbiddenCalls: string[] = [];
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({ page, context }) => {
  forbiddenCalls = [];
  await context.exposeBinding('reportForbiddenCall', (_source, name: string) => { forbiddenCalls.push(name); });
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } });
  // Guards record calls even when application code catches the rejected promise.
  await context.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { forbiddenBrowserCalls: calls });
    const forbid = (name: string) => () => {
      calls.push(name);
      void (window as unknown as { reportForbiddenCall(name: string): Promise<void> }).reportForbiddenCall(name);
      throw new Error(`Real browser API: ${name}`); };
    for (const method of ['getUserMedia', 'getDisplayMedia', 'enumerateDevices']) {
      Object.defineProperty(navigator.mediaDevices, method, { value: forbid(method), configurable: true });
    }
    Object.defineProperty(Notification, 'requestPermission', { value: forbid('notification permission'), configurable: true });
    Object.defineProperty(window, 'AudioContext', { value: forbid('audio context'), configurable: true });
  });
});
test.afterEach(async ({ page }) => {
  expect(forbiddenCalls).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { forbiddenBrowserCalls: string[] }).forbiddenBrowserCalls ?? [])).toEqual([]);
});
async function action(page: Page, data: MockAction): Promise<MockState> {
  const response = await page.request.post(`${app.url}/__mock/action`, { data });
  expect(response.ok()).toBeTruthy();
  const next: MockState = await response.json();
  await page.waitForResponse(async (r) => r.url().endsWith('/__mock/state') && r.ok() && (await r.json()).revision >= next.revision);
  return next;
}
async function state(page: Page): Promise<MockState> {
  return (await page.request.get(`${app.url}/__mock/state`)).json();
}
async function english(page: Page) {
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.keyboard.press('Escape');
}
async function send(page: Page, body: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(body);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function room(page: Page, name: string) {
  await page.getByRole('button', { name: /^Rooms:/ }).hover();
  await page.getByRole('navigation', { name: 'Rooms', exact: true }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.mouse.move(1400, 950);
  await expect(page.getByRole('button', { name: `Rooms: ${name}`, exact: true })).toBeVisible();
}

test('send, retry exactly once, catch up, reload and reset the populated fixture', async ({ page }) => {
  await page.goto(app.url);
  await english(page);
  await send(page, 'Browser message survives reload');
  await expect(page.getByText('Browser message survives reload', { exact: true })).toHaveCount(1);
  await action(page, { type: 'faults', faults: { send: 'fail' } });
  await send(page, 'Retry this message once');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(page.getByText('Retry this message once', { exact: true })).toHaveCount(1);
  const lounge = (await state(page)).rooms[0]!.id;
  await action(page, { type: 'faults', faults: { liveDisconnected: true } });
  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await action(page, { type: 'message', roomId: lounge, body: 'Missed while disconnected', authorName: 'Sam' });
  await action(page, { type: 'faults', faults: { liveDisconnected: false } });
  await expect(page.getByText('Missed while disconnected', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Retry this message once', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Browser message survives reload', { exact: true })).toBeVisible();
  await page.request.post(`${app.url}/__mock/reset`, { data: {} });
  await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
  await expect(page.getByText('Browser message survives reload', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Retry this message once', { exact: true })).toHaveCount(0);
});

async function movingVideo(page: Page, label: string) {
  const video = page.getByLabel(label, { exact: true });
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(960);
  const frame = () => video.evaluate((el: HTMLVideoElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96; canvas.height = 54;
    canvas.getContext('2d')!.drawImage(el, 0, 0, 96, 54);
    return canvas.toDataURL();
  });
  const first = await frame();
  await expect.poll(frame).not.toBe(first);
}

test('settings, simulated voice errors and animated local/remote sharing avoid hardware', async ({ page }) => {
  await page.goto(`${app.url}/?scenario=remote-share`);
  await english(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: /^Microphone/ }).selectOption({ label: 'Simulated microphone' });
  await settings.getByRole('combobox', { name: /^Speakers/ }).selectOption({ label: 'Simulated speakers' });
  await settings.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect.poll(() => settings.locator('.meter > div').evaluate((el) => el.getAttribute('style'))).toMatch(/scaleX\(0\.[1-9]/);
  await settings.getByRole('button', { name: 'Stop test', exact: true }).click();
  await settings.getByRole('button', { name: 'Test sound', exact: true }).click();
  await settings.getByLabel('Message notifications', { exact: true }).check();
  await settings.getByLabel('Join with microphone off', { exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Turn sound off', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Turn sound on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await movingVideo(page, "Sam's screen");
  await expect(page.getByLabel('Screen share statistics', { exact: true })).toContainText('— Mbps');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await movingVideo(page, 'Your screen');
  const diagnostics = page.getByLabel('Screen share statistics', { exact: true });
  await expect(diagnostics).toHaveCount(1);
  for (const overlay of await diagnostics.all()) await expect(overlay).toContainText('— Mbps');
  const stream = await page.getByLabel('Your screen', { exact: true }).evaluateHandle((el: HTMLVideoElement) => el.srcObject as MediaStream);
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await expect(page.getByLabel('Your screen', { exact: true })).toHaveCount(0);
  expect(await stream.evaluate((value) => value.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await stream.dispose();
  await action(page, { type: 'faults', faults: { shareFailure: true } });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("Couldn't share your screen");
  const games = (await state(page)).rooms[1]!.id;
  await action(page, { type: 'faults', faults: { roomFull: games } });
  await room(page, 'Games');
  await page.getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('The room is full');
  await expect(page.getByRole('toolbar', { name: 'Lounge' })).toBeVisible();
  await action(page, { type: 'faults', faults: { voiceReconnecting: true } });
  await expect(page.getByText('Reconnecting voice', { exact: true })).toBeVisible();
  await action(page, { type: 'faults', faults: { voiceReconnecting: false } });
  await expect(page.getByText('Reconnecting voice', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Join with microphone off', { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await action(page, { type: 'faults', faults: { roomFull: null, micDenied: true } });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No access to the microphone');
  await expect(page.getByRole('toolbar', { name: 'Games' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('alert')).toHaveText('No access to the microphone');
});

test('entry, history/unread, conflict and reset after revoked or disconnected access', async ({ page }) => {
  await page.goto(`${app.url}/?scenario=entry`);
  await page.getByRole('textbox', { name: "Ім'я", exact: true }).fill('Taylor');
  await page.getByRole('button', { name: 'Увійти', exact: true }).click();
  await english(page);
  await expect(page.getByText('Welcome back! Try sending a message or joining voice.', { exact: true })).toBeVisible();
  await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByText('Lounge history 1', { exact: true })).toBeAttached();
  const lounge = (await state(page)).rooms[0]!.id;
  await room(page, 'Games');
  await action(page, { type: 'message', roomId: lounge, body: 'Unread in Lounge', authorName: 'Sam' });
  await expect(page.getByRole('button', { name: 'Rooms: Games', exact: true }).getByTitle('New messages')).toBeVisible();
  await room(page, 'Lounge');
  await expect(page.getByText('Unread in Lounge', { exact: true })).toBeVisible();
  await action(page, { type: 'name-conflict', active: true });
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('textbox', { name: 'Name', exact: true }).fill('Morgan');
  await page.getByRole('button', { name: 'Change name', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await action(page, { type: 'revoke' });
  await expect(page.getByRole('heading', { name: 'The link was replaced', exact: true })).toBeVisible();
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } });
  await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/scenario=populated/);
  await english(page);
  await action(page, { type: 'faults', faults: { liveDisconnected: true, delayMs: 1500 } });
  await send(page, 'Delayed across reset');
  await expect.poll(async () => (await state(page)).faults.delayMs).toBe(0);
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'quiet' } });
  await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/scenario=quiet/);
  await expect(page.getByText('Тут ще порожньо', { exact: true })).toBeVisible();
  // Let the old delayed response finish; a fresh page must remain empty.
  await page.waitForTimeout(1600);
  await page.reload();
  await expect(page.getByText('Delayed across reset', { exact: true })).toHaveCount(0);
});

test('two instances in one browser context isolate visitors and survive a fresh restart', async ({ page, context }) => {
  let second = await launchMock();
  const other = await context.newPage();
  try {
    await page.goto(app.url);
    await english(page);
    await send(page, 'Only the first instance');
    await other.goto(`${second.url}/?scenario=entry`);
    await other.getByRole('textbox', { name: "Ім'я", exact: true }).fill('Second visitor');
    await other.getByRole('button', { name: 'Увійти', exact: true }).click();
    await english(other);
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await other.getByRole('button', { name: 'Light', exact: true }).click();
    await other.keyboard.press('Escape');
    await send(other, 'Only the second instance');
    await page.reload();
    await expect(page.getByText('Only the first instance', { exact: true })).toBeVisible();
    await expect(page.getByText('Only the second instance', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Alex');
    await page.keyboard.press('Escape');
    await page.request.post(`${app.url}/__mock/reset`, { data: {} });
    await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
    await other.reload();
    await expect(other.getByText('Only the second instance', { exact: true })).toBeVisible();
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(other.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Second visitor');
    await expect(other.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await other.keyboard.press('Escape');
    const port = Number(new URL(second.url).port);
    await second.close();
    second = await launchMock(port);
    await expect(other.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
    await expect(other).toHaveURL(/scenario=populated/);
    await expect(other.getByText('Only the second instance', { exact: true })).toHaveCount(0);
    await english(other);
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(other.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Alex');
    await expect(other.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.goto(`${app.url}/design.html?scene=voice`);
    await expect(page.locator('.room-screen')).toBeVisible();
    await expect(page.locator('h1')).not.toBeEmpty();
  } finally { await other.close(); await second.close(); }
});
