import { test, expect, type Locator, type Page } from '@playwright/test';
import type { MockAction, MockState } from '../mock/protocol';
import { PALETTES } from '../src/fx/palette';
import { launchMock } from './launcher';
import { showBrowserToast } from './toast-browser';

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
async function settingsTab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
}
async function english(page: Page) {
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  await settingsTab(page, 'Загальне');
  await page.getByRole('combobox', { name: 'Мова', exact: true }).selectOption('en');
  await page.keyboard.press('Escape');
}
async function send(page: Page, body: string) {
  await openChat(page);
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
  await openChat(page);
  await expect(page.getByText('Retry this message once', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Browser message survives reload', { exact: true })).toBeVisible();
  await page.request.post(`${app.url}/__mock/reset`, { data: {} });
  await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
  await expect(page.getByText('Browser message survives reload', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Retry this message once', { exact: true })).toHaveCount(0);
});

test('reduced motion opens chat history with tinted own messages without a render loop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const lounge = (await state(page)).rooms[0]!.id;
  let request = 0;
  for (const [authorName, body] of [
    ['Sam', 'Ready for a quick catch-up?'],
    ['Alex', 'Yes! I’ve got the notes ready.'],
    ['Sam', 'Perfect. I’ll join in a minute.'],
    ['Alex', 'Sounds good. We can pick up where we left off yesterday.'],
    ['Alex', 'See you shortly!'],
  ]) {
    const response = authorName === 'Alex'
      ? await page.request.post(`${app.url}/api/rooms/${lounge}/messages`, { data: { requestKey: `reduced-${request++}`, body } })
      : await page.request.post(`${app.url}/__mock/action`, { data: { type: 'message', roomId: lounge, authorName, body } });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto(app.url);
  await page.locator('.feed .msg').first().waitFor({ state: 'attached' });
  await page.keyboard.press('Slash');
  await expect(page.locator('.dock-chat')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.msg.own').last()).toHaveText('See you shortly!');
  await expect(page.locator('.msg.own').last()).toBeVisible();
  await expect.poll(() => page.locator('.feed').evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
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
  await settingsTab(page, 'Voice');
  await settings.getByRole('combobox', { name: /^Microphone/ }).selectOption({ label: 'Simulated microphone' });
  await settings.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect.poll(() => settings.locator('.meter > div').evaluate((el) => el.getAttribute('style'))).toMatch(/scaleX\(0\.[1-9]/);
  await settings.getByRole('button', { name: 'Stop test', exact: true }).click();
  await settings.getByLabel('Join with microphone off', { exact: true }).check();
  await settingsTab(page, 'Sound & notifications');
  await settings.getByRole('combobox', { name: /^Speakers/ }).selectOption({ label: 'Simulated speakers' });
  await settings.getByRole('button', { name: 'Test sound', exact: true }).click();
  await settings.getByLabel('Message notifications', { exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  const ring = page.locator('.dock .mic-ring');
  const ringStyles = () => ring.evaluate((el: HTMLElement) => [el.style.opacity, el.style.transform]);
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(ringStyles).toEqual(['0', 'scale(0.94)']);
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await expect.poll(async () => Number((await ringStyles())[0])).toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Turn sound off', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(ringStyles).toEqual(['0', 'scale(0.94)']);
  await page.getByRole('button', { name: 'Turn sound on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await movingVideo(page, "Sam's screen");
  const shareVideo = page.getByLabel("Sam's screen", { exact: true });
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className ?? '')).toContain('share');
  await expect(page.locator('.build-version:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator('.build-version:visible')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => shareVideo.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(960);
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
  await page.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(ring).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsTab(page, 'Voice');
  await page.getByLabel('Join with microphone off', { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await action(page, { type: 'faults', faults: { roomFull: null, micDenied: true } });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No access to the microphone');
  await expect(page.getByRole('toolbar', { name: 'Games' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(ringStyles).toEqual(['0', 'scale(0.94)']);
  await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('alert')).toHaveText('No access to the microphone');
});

test('settings downloads on first open and retains its tab when reopened', async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const download = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/src/ui/Settings.tsx*', async (route) => {
    requests++;
    await download;
    await route.continue();
  });
  await page.goto(app.url);
  const opener = page.getByRole('button', { name: 'Налаштування', exact: true });
  await expect(opener).toBeVisible();
  expect(requests).toBe(0);
  await opener.click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  const settings = page.getByRole('dialog', { name: 'Налаштування' });
  await expect(settings).toBeVisible();
  await settingsTab(page, 'Загальне');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(settings.getByRole('tab', { name: 'Загальне', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(requests).toBe(1);
});

test('a failed settings download leaves the interface usable and shows a notice', async ({ page }) => {
  await page.route('**/src/ui/Settings.tsx*', (route) => route.abort('failed'));
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  const notice = page.locator('.float-top').getByRole('status');
  await expect(notice).toContainText('Перевір інтернет');
  await page.getByRole('button', { name: 'Кімнати: Lounge', exact: true }).hover({ timeout: 3_000 });
  await notice.getByRole('button', { name: 'Закрити', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  await expect(page.locator('.composer textarea')).toBeEnabled();
});

test('the app-wide toast host spans entry and room navigation and clears previous visitors on revocation', async ({ page }) => {
  await page.goto(`${app.url}/?scenario=entry`);
  const name = page.getByRole('textbox', { name: "Ім'я", exact: true });
  await expect(name).toBeVisible();
  const top = page.locator('.float-top');
  const initialHost = await top.elementHandle();
  await showBrowserToast(page, 'Guest entry task', null, 'dismiss-entry-toast');
  await expect(top.getByRole('status')).toHaveText('Guest entry task');

  await name.fill('Taylor');
  await page.getByRole('button', { name: 'Увійти як гість', exact: true }).click();
  await english(page);
  await expect(top.getByRole('status')).toHaveCount(0);
  await showBrowserToast(page, 'Room task', null, 'dismiss-room-toast');
  await showBrowserToast(page, 'Room notice');
  await expect(top.getByRole('status')).toHaveText(['Room task', 'Room notice']);
  await room(page, 'Games');
  await expect(top.getByText('Room task', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Rooms: Games', exact: true }).hover();
  await page.getByRole('navigation', { name: 'Rooms', exact: true }).getByRole('button', { name: /^Lounge/ }).click();
  await expect(page.getByRole('button', { name: 'Rooms: Lounge', exact: true })).toBeVisible();
  await expect(top.getByText('Room task', { exact: true })).toBeVisible();

  const lounge = (await state(page)).rooms[0]!.id;
  await action(page, { type: 'knock', roomId: lounge, name: 'Sam' });
  await expect(top.getByRole('alert')).toContainText('Sam');
  await action(page, { type: 'revoke' });
  await expect(page.getByRole('heading', { name: 'Come on in.', exact: true })).toBeVisible();
  expect(await initialHost.evaluate(host => host === document.querySelector('.float-top'))).toBe(true);
  await expect(top.locator('.toast')).toHaveCount(0);
  await showBrowserToast(page, 'Signed-out feedback', null);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('dismiss-entry-toast'));
    window.dispatchEvent(new Event('dismiss-room-toast'));
  });
  await expect(top.getByRole('status')).toHaveText('Signed-out feedback');
});

test('incoming knock close, expiry and join coexist with timed and Enable audio toasts', async ({ page }) => {
  await page.clock.install();
  await page.goto(app.url);
  await english(page);
  const games = (await state(page)).rooms.find(({ name }) => name === 'Games')!.id;
  const top = page.locator('.float-top');
  const knock = top.getByRole('alert');
  await action(page, { type: 'knock', roomId: games, name: 'Sam' });
  await expect(knock).toContainText('Sam is calling you to Games');
  await showBrowserToast(page, 'Timed notice');
  await expect(top.getByRole('status')).toHaveText('Timed notice');
  await knock.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(knock).toHaveCount(0);
  await expect(top.getByRole('status')).toHaveText('Timed notice');

  await action(page, { type: 'knock', roomId: games, name: 'Robin' });
  await expect(knock).toContainText('Robin');
  await page.clock.fastForward(28_000);
  await expect(knock).toBeVisible();
  await expect(top.getByRole('status')).toHaveCount(0);
  await page.clock.fastForward(2_000);
  await expect(knock).toHaveCount(0);

  await action(page, { type: 'faults', faults: { audioBlocked: true } });
  await action(page, { type: 'knock', roomId: games, name: 'Sam' });
  await knock.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(knock).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Games', exact: true })).toBeVisible();
  const enable = top.getByRole('button', { name: 'Enable audio', exact: true });
  await expect(enable).toBeVisible();
  await action(page, { type: 'faults', faults: { voiceReconnecting: true } });
  await expect(top.getByText('Reconnecting voice', { exact: true })).toBeVisible();
  await expect(enable).toHaveCount(0);
  await action(page, { type: 'faults', faults: { voiceReconnecting: false } });
  await showBrowserToast(page, 'Another timed notice');
  await expect(top.getByRole('status')).toContainText(['Call audio is blocked', 'Another timed notice']);
  await enable.click();
  await expect(enable).toHaveCount(0);
  await expect(top.getByRole('status')).toHaveText('Another timed notice');
});

test.describe('short touch viewport', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 667, height: 390 } });

  async function swipeIn(page: Page, surface: Locator, direction: 'up' | 'down', distance?: number) {
    const stack = (await surface.boundingBox())!;
    const x = Math.round(stack.x + 26);
    const inset = Math.min(20, stack.height / 6);
    const travel = Math.min(stack.height - 2 * inset, distance ?? Infinity);
    const first = direction === 'up' ? stack.y + stack.height - inset : stack.y + inset;
    const last = first + (direction === 'up' ? -travel : travel);
    const touch = await page.context().newCDPSession(page);
    try {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: Math.round(first) }] });
      for (const step of [0.15, 0.3, 0.5, 0.75, 1]) {
        const y = Math.round(first + (last - first) * step);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      if (distance !== undefined) await page.waitForTimeout(100); // Lift after pausing for a swipe without a fling.
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.detach();
    }
  }

  const swipeToastStack = (page: Page, direction: 'up' | 'down', distance?: number) => swipeIn(page, page.locator('.float-top'), direction, distance);

  function noticeHit(target: Locator) {
    return target.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }, undefined, { timeout: 1_500 });
  }

  async function swipeToNotice(page: Page, host: Locator, target: Locator) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const [stack, box] = await Promise.all([host.boundingBox(), target.boundingBox({ timeout: 1_500 })]);
      if (!stack || !box) break;
      const distance = box.y + box.height / 2 - stack.y - stack.height / 2;
      if (Math.abs(distance) <= (stack.height - box.height) / 2 + 1 && await noticeHit(target)) return;
      await swipeToastStack(page, distance > 0 ? 'up' : 'down', Math.max(15, Math.abs(distance) + 8));
    }
    await expect.poll(() => noticeHit(target)).toBe(true);
  }

  async function attachComposerImage(page: Page, picker: Locator) {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 20;
      canvas.height = 20;
      canvas.getContext('2d')!.fillRect(0, 0, 20, 20);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await picker.setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  }

  const longDraft = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n');

  test('room controls, rename, and lower toast dismissals stay reachable in an overflowing stack', async ({ page }) => {
    await page.goto(app.url);
    await english(page);
    const lounge = (await state(page)).rooms[0]!.id;
    const top = page.locator('.float-top');
    await showBrowserToast(page, 'Persistent work', null);
    await showBrowserToast(page, 'Timed feedback', 60_000);
    await action(page, { type: 'knock', roomId: lounge, name: 'Sam' });
    await expect(top.getByRole('alert')).toContainText('Sam');
    await action(page, { type: 'name-conflict', active: true });
    const conflict = top.getByRole('alertdialog');
    const name = conflict.getByRole('textbox', { name: 'Name', exact: true });
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport({ ratio: 0.98 });
    await expect(top.getByRole('status')).toHaveText(['Persistent work', 'Timed feedback']);

    for (const height of [390, 375]) {
      await page.setViewportSize({ width: 667, height });
      await expect.poll(async () => await top.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(height);
    }
    const rooms = page.getByRole('button', { name: 'Rooms: Lounge', exact: true });
    await rooms.tap();
    await expect(rooms).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('navigation', { name: 'Rooms', exact: true }).getByRole('button', { name: /^Games/ }).tap();
    await expect(page.getByRole('button', { name: 'Rooms: Games', exact: true })).toBeVisible();

    await top.evaluate(el => { el.scrollTop = 0; });
    for (let swipe = 0; swipe < 3; swipe++) await swipeToastStack(page, 'up');

    await expect.poll(async () => await top.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const submit = conflict.getByRole('button', { name: 'Change name', exact: true });
    await expect(name).toBeInViewport({ ratio: 0.98 });
    await expect(submit).toBeInViewport({ ratio: 0.98 });
    await name.fill('Morgan');
    await submit.tap();
    await expect(conflict).toHaveCount(0);
    await expect(top.getByRole('alert')).toContainText('Sam');

    for (let task = 1; task <= 6; task++) await showBrowserToast(page, `Extra task ${task}`, null);
    await expect(top).toHaveAttribute('data-overflowing', '');
    await page.getByRole('button', { name: 'Settings', exact: true }).tap({ timeout: 3_000 });
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    const close = top.getByRole('status').filter({ hasText: 'Extra task 6' }).getByRole('button', { name: 'Close', exact: true });
    await top.getByRole('button', { name: 'Close', exact: true }).first().focus();
    for (let tab = 0; tab < 7; tab++) await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expect(close).toBeInViewport({ ratio: 0.98 });
    await page.keyboard.press('Enter');
    await expect(top.getByText('Extra task 6', { exact: true })).toHaveCount(0);
    await expect(top.getByText('Extra task 5', { exact: true })).toBeVisible();
  });

  test('a smaller scroll viewport reveals the focused rename field and still allows swiping away', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 500 });
    await page.goto(app.url);
    await english(page);
    for (let task = 1; task <= 9; task++) await showBrowserToast(page, `Task ${task}`, null);
    await action(page, { type: 'name-conflict', active: true });
    const top = page.locator('.float-top');
    const name = top.getByRole('alertdialog').getByRole('textbox', { name: 'Name', exact: true });
    await expect(top).toHaveAttribute('data-overflowing', '');
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport({ ratio: 0.98 });

    await page.setViewportSize({ width: 667, height: 375 });
    await expect(top).toHaveAttribute('data-overflowing', '');
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport({ ratio: 0.98 });

    await swipeToastStack(page, 'down');
    await expect(name).toBeFocused();
    await expect(name).not.toBeInViewport();
  });

  test('the active chat surface and toast stack take turns receiving touch input', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto(app.url);
    await english(page);
    for (let task = 1; task <= 6; task++) await showBrowserToast(page, `Task ${task}`, null);
    const top = page.locator('.float-top');
    await expect(top).toHaveAttribute('data-overflowing', '');

    const chatToggle = page.locator('.dock-chat');
    await chatToggle.tap();
    const chat = page.getByRole('complementary', { name: 'Chat', exact: true });
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
    await composer.tap({ timeout: 3_000 });
    await expect(composer).toBeFocused();
    await expect(chatToggle).toHaveAttribute('aria-expanded', 'true');
    await composer.fill('Sent with overflowing toasts');
    const sent = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
    await chat.getByRole('button', { name: 'Send', exact: true }).tap();
    expect((await sent).ok()).toBe(true);
    await expect(chat.getByText('Sent with overflowing toasts', { exact: true })).toBeVisible();

    await action(page, { type: 'name-conflict', active: true });
    const conflict = top.getByRole('alertdialog');
    const name = conflict.getByRole('textbox', { name: 'Name', exact: true });
    await expect(name).toBeFocused();
    await expect.poll(() => name.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return document.elementFromPoint(x + width / 2, y + height / 2) === el;
    })).toBe(true);
    await name.fill('Morgan');
    await name.press('Enter');
    await expect(conflict).toHaveCount(0);
    await expect(chatToggle).toHaveAttribute('aria-expanded', 'true');

    await chatToggle.tap();
    await expect(chatToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(top.getByRole('status')).toHaveCount(6);
    await top.evaluate(el => { el.scrollTop = 0; });
    for (let swipe = 0; swipe < 3; swipe++) await swipeToastStack(page, 'up');
    const lastTask = top.getByRole('status').filter({ hasText: 'Task 6' });
    const close = lastTask.getByRole('button', { name: 'Close', exact: true });
    await expect(close).toBeInViewport({ ratio: 0.98 });
    await close.tap();
    await expect(lastTask).toHaveCount(0);
    await expect(top.getByRole('status')).toHaveCount(5);
  });

  test('Chat stays usable with a reconnect banner, an attachment notice, and a late knock', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto(app.url);
    await english(page);
    const games = (await state(page)).rooms.find(({ name }) => name === 'Games')!.id;
    const top = page.locator('.float-top');
    const chatToggle = page.locator('.dock-chat');
    await chatToggle.tap();
    const chat = page.getByRole('complementary', { name: 'Chat', exact: true });
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
    await action(page, { type: 'knock', roomId: games, name: 'Sam' });
    const knock = top.getByRole('alert');
    const join = knock.getByRole('button', { name: 'Join', exact: true });
    await expect(knock).toContainText('Sam');
    await action(page, { type: 'faults', faults: { liveDisconnected: true } });
    const reconnect = top.getByText('Reconnecting', { exact: true });
    await expect(reconnect).toBeVisible();
    await chat.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsupported attachment') });
    const unsupported = top.getByRole('status').getByText('Only images can be added for now.');
    await expect(unsupported).toBeVisible();
    await expect.poll(() => reconnect.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }), { timeout: 3_000 }).toBe(true);
    await expect(join).toBeInViewport({ ratio: 0.98 });
    await expect(unsupported).toBeInViewport({ ratio: 0.98 });

    await composer.tap({ timeout: 3_000 });
    await expect(composer).toBeFocused();
    const message = 'Sending with Chat open\nand multiple lines\nabove the dock';
    await composer.fill(message);
    await expect.poll(async () => {
      const [stack, controls] = await Promise.all([top.boundingBox(), chat.locator('.composer').boundingBox()]);
      return !!stack && !!controls && stack.y + stack.height <= controls.y;
    }).toBe(true);
    const sent = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
    await chat.getByRole('button', { name: 'Send', exact: true }).tap();
    expect((await sent).ok()).toBe(true);
    await expect(chatToggle).toHaveAttribute('aria-expanded', 'true');

    await action(page, { type: 'faults', faults: { liveDisconnected: false } });
    await expect(reconnect).toHaveCount(0);
    for (let task = 1; task <= 9; task++) await showBrowserToast(page, `Pending ${task}`, null);
    const pendingClose = (task: number) => top.getByRole('status').filter({ hasText: `Pending ${task}` }).getByRole('button', { name: 'Close', exact: true });
    await pendingClose(3).focus();
    await page.keyboard.press('Tab');
    await expect(pendingClose(4)).toBeFocused();
    await expect.poll(() => noticeHit(pendingClose(4))).toBe(true);
    for (let swipe = 0; swipe < 3; swipe++) await swipeToastStack(page, 'up');
    await expect.poll(() => top.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    await expect(chatToggle).toHaveAttribute('aria-expanded', 'true');
    await action(page, { type: 'knock', roomId: games, name: 'Robin' });
    await expect(knock).toContainText('Robin');
    await expect.poll(() => top.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    await expect(join).toBeInViewport({ ratio: 0.98 });
    await join.tap({ timeout: 3_000 });
    await expect(page.getByRole('toolbar', { name: 'Games', exact: true })).toBeVisible();
    await expect(knock).toHaveCount(0);
  });

  for (const width of [667, 568]) {
    test(`every room notice can scroll into reach in a full composer at ${width}×320`, async ({ page }) => {
      await page.setViewportSize({ width, height: 320 });
      await page.goto(app.url);
      await english(page);
      const games = (await state(page)).rooms.find(({ name }) => name === 'Games')!.id;
      const top = page.locator('.float-top');
      const chatToggle = page.locator('.dock-chat');
      await chatToggle.tap();
      const chat = page.getByRole('complementary', { name: 'Chat', exact: true });
      const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
      const picker = chat.locator('input[type="file"]');
      await attachComposerImage(page, picker);
      await expect(chat.locator('.tray-item.ready')).toBeVisible();
      await composer.fill(longDraft);
      await chat.locator('.feed').evaluate(el => { el.scrollTop = 0; });
      const latest = chat.getByRole('button', { name: 'Latest', exact: true });
      await expect(latest).toBeVisible();

      await action(page, { type: 'knock', roomId: games, name: 'Sam' });
      const knock = top.getByRole('alert');
      await expect(knock).toContainText('Sam');
      const join = knock.getByRole('button', { name: 'Join', exact: true });
      await action(page, { type: 'faults', faults: { liveDisconnected: true } });
      const reconnect = top.getByText('Reconnecting', { exact: true });
      await expect(reconnect).toBeVisible();
      await expect(top).toHaveAttribute('data-overflowing', '');
      await expect.poll(() => noticeHit(latest)).toBe(true);
      await swipeToNotice(page, top, reconnect);

      await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsupported attachment') });
      const ordinary = top.getByRole('status').filter({ hasText: 'Only images can be added for now.' });
      await expect(ordinary).toBeVisible();
      expect(await noticeHit(reconnect)).toBe(true);
      const close = ordinary.getByRole('button', { name: 'Close', exact: true });
      await swipeToNotice(page, top, close);
      await expect(ordinary.getByText('Only images can be added for now.')).toBeInViewport({ ratio: 0.75 });
      await close.tap();
      await expect(ordinary).toHaveCount(0);
      await composer.tap();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue(longDraft);
      await expect(chat.locator('.tray-item.ready')).toBeVisible();
      await swipeToNotice(page, top, join);
      await expect.poll(() => noticeHit(latest)).toBe(true);
      await latest.tap();
      await expect(latest).toHaveCount(0);
      await expect(chatToggle).toHaveAttribute('aria-expanded', 'true');
      await swipeToNotice(page, top, join);
      await join.tap();
      await expect(page.getByRole('toolbar', { name: 'Games', exact: true })).toBeVisible();
      await expect(knock).toHaveCount(0);
    });
  }

  test('a late knock is revealed once in a short, unpinned stack', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 320 });
    await page.goto(app.url);
    await english(page);
    const games = (await state(page)).rooms.find(({ name }) => name === 'Games')!.id;
    const top = page.locator('.float-top');
    await page.locator('.dock-chat').tap();
    const chat = page.getByRole('complementary', { name: 'Chat', exact: true });
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
    await attachComposerImage(page, chat.locator('input[type="file"]'));
    await expect(chat.locator('.tray-item.ready')).toBeVisible();
    await composer.fill(longDraft);
    await chat.locator('.feed').evaluate(el => { el.scrollTop = 0; });
    await expect(chat.getByRole('button', { name: 'Latest', exact: true })).toBeVisible();
    for (let task = 1; task <= 8; task++) await showBrowserToast(page, `Pending ${task}`, null);
    await expect(top).toHaveAttribute('data-overflowing', '');
    await expect(composer).toBeFocused();
    for (let swipe = 0; swipe < 4; swipe++) await swipeToastStack(page, 'up');
    await expect.poll(() => top.evaluate(el => el.scrollTop)).toBeGreaterThanOrEqual(96);

    await action(page, { type: 'knock', roomId: games, name: 'Sam' });
    const knock = top.getByRole('alert');
    const join = knock.getByRole('button', { name: 'Join', exact: true });
    await expect(knock).toHaveCSS('position', 'static');
    await expect.poll(() => noticeHit(join), { timeout: 3_000 }).toBe(true);
    await expect(composer).toBeFocused();
    for (let swipe = 0; swipe < 3; swipe++) await swipeToastStack(page, 'up');
    await expect.poll(() => top.evaluate(el => el.scrollTop)).toBeGreaterThan(65);
    await expect.poll(() => noticeHit(join)).toBe(false);
    await expect(composer).toBeFocused();
  });

  test('a shallow Reply with an attached image leaves room for notices and can still send', async ({ page }) => {
    await page.setViewportSize({ width: 568, height: 320 });
    await page.goto(app.url);
    await english(page);
    const games = (await state(page)).rooms.find(({ name }) => name === 'Games')!.id;
    const top = page.locator('.float-top');
    await page.locator('.dock-chat').tap();
    const chat = page.getByRole('complementary', { name: 'Chat', exact: true });
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
    await chat.getByText('Welcome back! Try sending a message or joining voice.', { exact: true }).click({ button: 'right' });
    await page.getByRole('dialog', { name: 'Message actions', exact: true }).getByRole('menuitem', { name: 'Reply', exact: true }).tap();
    await expect(chat.locator('.composing')).toContainText('Replying to');
    await attachComposerImage(page, chat.locator('input[type="file"]'));
    await expect(chat.locator('.tray-item.ready')).toBeVisible();
    await composer.fill(longDraft);

    await action(page, { type: 'knock', roomId: games, name: 'Sam' });
    const knock = top.getByRole('alert');
    const join = knock.getByRole('button', { name: 'Join', exact: true });
    await expect(knock).toContainText('Sam');
    await expect.poll(() => top.evaluate(el => el.clientHeight), { timeout: 3_000 }).toBeGreaterThanOrEqual(59);
    await expect.poll(() => noticeHit(join)).toBe(true);
    const context = chat.locator('.composer-context');
    await expect.poll(() => context.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await swipeIn(page, context, 'up');
    await expect.poll(() => context.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => noticeHit(context.locator('.tray-remove'))).toBe(true);
    await composer.tap();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(longDraft);
    const sent = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
    await chat.getByRole('button', { name: 'Send', exact: true }).tap();
    const response = await sent;
    expect(response.ok()).toBe(true);
    const posted = await response.json();
    expect(posted.replyTo?.excerpt).toBe('Welcome back! Try sending a message or joining voice.');
    expect(posted.attachments).toHaveLength(1);
    await join.tap();
    await expect(page.getByRole('toolbar', { name: 'Games', exact: true })).toBeVisible();
  });
});

test('settings window: keyboard stays inside, tabs move by arrows, one confirmed colour persists', async ({ page }) => {
  await page.goto(app.url);
  await english(page);
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const tabs = settings.getByRole('tab');
  await expect(tabs).toHaveText(['General', 'Voice', 'Sound & notifications', 'Video', 'Screen sharing', 'Profile', 'Account', 'Shortcuts']);

  const voicePanel = settings.locator('#set-panel-voice');
  const voiceBody = voicePanel.locator('.set-stack');
  await expect(voicePanel).toBeAttached();
  await expect(voiceBody).toHaveCount(0);

  await settingsTab(page, 'General');
  await page.keyboard.press('ArrowDown');
  await expect(settings.getByRole('tab', { name: 'Voice' })).toBeFocused();
  await expect(settings.getByRole('tab', { name: 'Voice' })).toHaveAttribute('aria-selected', 'true');
  await expect(voiceBody).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(voiceBody).toBeAttached();
  await expect(voicePanel).toBeHidden();
  await page.keyboard.press('ArrowUp');
  await expect(settings.getByRole('tab', { name: 'Shortcuts' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(settings.getByRole('tab', { name: 'General' })).toBeFocused();

  // Shortcuts of the page behind must not fire, and the room must not change.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  await page.keyboard.press('Slash');
  await expect(settings).toBeVisible();
  await expect(page.locator('.composer textarea')).not.toBeFocused();

  await settingsTab(page, 'Profile');
  const color = (name: string) => settings.getByRole('radio', { name, exact: true });
  const shown = () => settings.locator('.profile-card .orb').evaluate((el: HTMLElement) => el.style.getPropertyValue('--base'));
  await expect(settings.getByRole('radio')).toHaveCount(16);
  await expect(settings.locator('.color input:checked')).toHaveCount(1);
  for (const [name, base] of [['Lagoon', PALETTES.lagoon[0]], ['Moss', PALETTES.moss[0]], ['Coral', PALETTES.coral[0]]] as const) {
    await color(name).click();
    await expect(color(name)).toBeChecked();
    await expect.poll(shown).toBe(base);
    await expect(settings.locator('.color input:checked')).toHaveCount(1);
  }
  await expect(color('Sky')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(opener).toBeFocused();

  await page.reload();
  await opener.click();
  await settingsTab(page, 'Profile');
  await expect(color('Coral')).toBeChecked();
  await expect(settings.locator('.color input:checked')).toHaveCount(1);
  expect(await shown()).toBe(PALETTES.coral[0]);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toBeHidden();
  await opener.click();
  await page.mouse.click(4, 4);
  await expect(settings).toBeHidden();
});

test('chat and avatars render the same authoritative colour for each visitor', async ({ page }) => {
  await page.goto(app.url);
  await english(page);
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } });
  await page.reload();
  await openChat(page);
  await page.locator('.msg').first().waitFor();
  const colours = () => page.evaluate(() => {
    const byName: Record<string, string[]> = {};
    for (const msg of document.querySelectorAll<HTMLElement>('.msg')) {
      const name = msg.querySelector('.msg-author')?.textContent;
      if (name) (byName[name] ??= []).push(msg.style.getPropertyValue('--base'));
    }
    return byName;
  });
  const tile = (name: string) => page.locator('.tile', { hasText: name }).evaluate((el: HTMLElement) => el.style.getPropertyValue('--base'));
  const seen = await colours();
  for (const name of ['Sam', 'Robin']) {
    expect(new Set(seen[name]).size).toBe(1);
    expect(seen[name]![0]).toBe(await tile(name));
  }
  expect(seen.Sam![0]).not.toBe(seen.Robin![0]);
});

test('entry, history/unread, conflict and reset after revoked or disconnected access', async ({ page }) => {
  await page.goto(`${app.url}/?scenario=entry`);
  await page.getByRole('textbox', { name: "Ім'я", exact: true }).fill('Taylor');
  await page.getByRole('button', { name: 'Увійти як гість', exact: true }).click();
  await english(page);
  await openChat(page);
  await expect(page.getByText('Welcome back! Try sending a message or joining voice.', { exact: true })).toBeVisible();
  // The first trip to the top loads the older page and keeps the message that was already there.
  // A second trip reaches the newly loaded start, which is the only place that row is mounted.
  const older = page.waitForResponse((response) => response.url().includes('/messages') && response.url().includes('before='));
  await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; });
  await older;
  await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByText('Lounge history 1', { exact: true })).toBeAttached();
  const lounge = (await state(page)).rooms[0]!.id;
  await room(page, 'Games');
  await action(page, { type: 'message', roomId: lounge, body: 'Unread in Lounge', authorName: 'Sam' });
  await expect(page.getByRole('button', { name: 'Rooms: Games', exact: true }).getByTitle('New messages')).toBeVisible();
  await room(page, 'Lounge');
  await openChat(page);
  // The room reopens where it was left, at the older history, so the new line is below.
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await expect(page.getByText('Unread in Lounge', { exact: true })).toBeVisible();
  await action(page, { type: 'name-conflict', active: true });
  await expect(page.getByRole('alertdialog')).toBeVisible();
  const conflictName = page.getByRole('alertdialog').getByRole('textbox', { name: 'Name', exact: true });
  await expect(conflictName).toBeFocused();
  await conflictName.fill('Morgan');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await action(page, { type: 'revoke' });
  await expect(page.getByRole('heading', { name: 'Come on in.', exact: true })).toBeVisible();
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
  await openChat(page);
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
    // Vite's restart reload can reapply the old query before the mock poll sees the new instance.
    await other.routeWebSocket((url) => url.pathname === '/' && url.searchParams.has('token'), () => {});
    await page.goto(app.url);
    await english(page);
    await send(page, 'Only the first instance');
    await other.goto(`${second.url}/?scenario=entry`);
    await other.getByRole('textbox', { name: "Ім'я", exact: true }).fill('Second visitor');
    await other.getByRole('button', { name: 'Увійти як гість', exact: true }).click();
    await english(other);
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsTab(other, 'General');
    await other.getByRole('button', { name: 'Light', exact: true }).click();
    await other.keyboard.press('Escape');
    await send(other, 'Only the second instance');
    await page.reload();
    await openChat(page);
    await expect(page.getByText('Only the first instance', { exact: true })).toBeVisible();
    await expect(page.getByText('Only the second instance', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsTab(page, 'Profile');
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Alex');
    await page.keyboard.press('Escape');
    await page.request.post(`${app.url}/__mock/reset`, { data: {} });
    await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
    await other.reload();
    await openChat(other);
    await expect(other.getByText('Only the second instance', { exact: true })).toBeVisible();
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsTab(other, 'Profile');
    await expect(other.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Second visitor');
    await settingsTab(other, 'General');
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
    await settingsTab(other, 'Profile');
    await expect(other.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Alex');
    await settingsTab(other, 'General');
    await expect(other.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.goto(`${app.url}/design.html?scene=voice`);
    await expect(page.locator('.room-screen')).toBeVisible();
    await expect(page.locator('h1')).not.toBeEmpty();
  } finally { await other.close(); await second.close(); }
});

async function openChat(page: Page) {
  const chat = page.locator('.dock-chat');
  if (await chat.getAttribute('aria-expanded') !== 'true') await chat.click();
  await expect(page.locator('body')).toHaveClass(/chat-open/);
}

async function closeChat(page: Page) {
  await page.locator('.dock-chat').click();
  await expect(page.locator('body')).not.toHaveClass(/chat-open/);
}

/** The message under the top edge of the feed, and how far its top sits from that edge. */
async function readingAnchor(page: Page) {
  return page.locator('.feed').evaluate((feed) => {
    const edge = feed.getBoundingClientRect().top;
    const row = [...feed.querySelectorAll<HTMLElement>('[data-row]')].find((el) => el.querySelector('.msg-text') && el.getBoundingClientRect().bottom > edge + 2);
    const box = row?.getBoundingClientRect();
    return { text: row?.querySelector('.msg-text')?.textContent ?? '', offset: box ? Math.round(box.top - edge) : null, mounted: feed.querySelectorAll('.msg').length };
  });
}

/** The same line, within a pixel. Subpixel rounding can move the reported offset by one. */
async function expectPlace(page: Page, anchor: { text: string; offset: number | null }) {
  await expect.poll(async () => {
    const next = await readingAnchor(page);
    return next.text === anchor.text && next.offset !== null && anchor.offset !== null && Math.abs(next.offset - anchor.offset) <= 1;
  }).toBe(true);
}

/** Two matching reads, so a measurement pass in between does not get stored as the place. */
async function settledAnchor(page: Page) {
  let previous = '';
  let stable = { text: '', offset: null as number | null, mounted: 0 };
  await expect.poll(async () => {
    const next = await readingAnchor(page);
    const key = `${next.text}:${next.offset}`;
    const same = key === previous && next.text !== '';
    previous = key;
    stable = next;
    return same;
  }).toBe(true);
  return stable;
}

test('chat keeps each room reading place, pages without jumping, and virtualizes the history', async ({ page }) => {
  const olderPages: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/messages') && url.searchParams.has('before')) olderPages.push(url.search);
  });
  await page.goto(app.url);
  await english(page);
  await openChat(page);
  await expect(page.getByText('Welcome back! Try sending a message or joining voice.', { exact: true })).toBeVisible();
  await page.locator('.feed').evaluate((el) => { el.scrollTop = 720; });
  const lounge = await settledAnchor(page);
  const feed = page.locator('.feed');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const feedHeight = await feed.evaluate((el) => el.clientHeight);
  await composer.fill('A draft while reading\nIt makes the composer grow\nThe reading place stays put');
  await expect.poll(() => feed.evaluate((el) => el.clientHeight)).toBeLessThan(feedHeight);
  await expectPlace(page, lounge);
  await composer.fill('');
  await expect.poll(() => feed.evaluate((el) => el.clientHeight)).toBe(feedHeight);
  await expectPlace(page, lounge);
  await closeChat(page);
  await openChat(page);
  await expectPlace(page, lounge);

  await room(page, 'Games');
  await openChat(page);
  await expect(page.getByText('Nothing here yet', { exact: true })).toBeVisible();
  const loungeId = (await state(page)).rooms[0]!.id;
  await action(page, { type: 'message', roomId: loungeId, body: 'Unread while the history was open', authorName: 'Sam' });
  await room(page, 'Lounge');
  await openChat(page);
  await expectPlace(page, lounge);
  await expect(page).toHaveTitle('(1) Falky');
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await expect(page.getByText('Unread while the history was open', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Falky');
  const followed = await settledAnchor(page);
  await action(page, { type: 'message', roomId: loungeId, body: 'Arrived at the bottom', authorName: 'Sam' });
  await expect(page.getByText('Arrived at the bottom', { exact: true })).toBeVisible();
  await page.locator('.feed').evaluate((el) => { el.scrollTop -= 640; });
  const parked = await settledAnchor(page);
  expect(parked.text).not.toBe('Arrived at the bottom');
  await action(page, { type: 'message', roomId: loungeId, body: 'Arrived while reading', authorName: 'Sam' });
  await expectPlace(page, parked);
  expect(followed.text).not.toBe(parked.text);

  let resumeOlder: (() => void) | undefined;
  await page.route(/\/messages\?.*\bbefore=/, async (route) => {
    await new Promise<void>((resolve) => { resumeOlder = resolve; });
    await route.continue();
  });
  const held = page.getByText('Lounge history 26', { exact: true });
  await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => resumeOlder !== undefined).toBe(true);
  await expect(held).toBeVisible();
  const beforePage = Math.round((await held.boundingBox())!.y);
  resumeOlder!();
  expect(olderPages).toHaveLength(1);
  await expect.poll(async () => {
    const box = await held.boundingBox();
    return box ? Math.abs(Math.round(box.y) - beforePage) : 1_000;
  }).toBeLessThanOrEqual(2);
  await expect.poll(() => page.locator('.feed .msg').count()).toBeLessThan(40);
  // The older page stayed above the message that was on screen. Scrolling up mounts its start.
  await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByText('Lounge history 1', { exact: true })).toBeAttached();
  await expect.poll(() => page.locator('.feed .msg').count()).toBeLessThan(40);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.getByRole('button', { name: /^Chat/ }).click();
  const phone = await settledAnchor(page);
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expectPlace(page, phone);
});


test('offline Leave disconnects immediately without a server request and stays idle after reload', async ({ page, context }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/api/voice/leave')) requests.push(request.url()); });
  await page.goto(app.url);
  await english(page);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('toolbar')).toBeVisible();
  try {
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(page.getByRole('toolbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible();
  } finally { await context.setOffline(false); }
  await page.reload();
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});
