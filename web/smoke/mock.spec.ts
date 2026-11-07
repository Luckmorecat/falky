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
async function settingsTab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
}
async function english(page: Page) {
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  await settingsTab(page, 'Система');
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
  await settingsTab(page, 'Audio & video');
  await settings.getByRole('combobox', { name: /^Microphone/ }).selectOption({ label: 'Simulated microphone' });
  await settings.getByRole('combobox', { name: /^Speakers/ }).selectOption({ label: 'Simulated speakers' });
  await settings.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect.poll(() => settings.locator('.meter > div').evaluate((el) => el.getAttribute('style'))).toMatch(/scaleX\(0\.[1-9]/);
  await settings.getByRole('button', { name: 'Stop test', exact: true }).click();
  await settings.getByRole('button', { name: 'Test sound', exact: true }).click();
  await settings.getByLabel('Join with microphone off', { exact: true }).check();
  await settingsTab(page, 'System');
  await settings.getByLabel('Message notifications', { exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Turn sound off', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Turn sound on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await movingVideo(page, "Sam's screen");
  const shareVideo = page.getByLabel("Sam's screen", { exact: true });
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className ?? '')).toContain('share');
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsTab(page, 'Audio & video');
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

test('settings window: keyboard stays inside, tabs move by arrows, favourite colour sticks', async ({ page }) => {
  await page.goto(app.url);
  await english(page);
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const tabs = settings.getByRole('tab');
  await expect(tabs).toHaveText(['Audio & video', 'Screen sharing', 'Profile', 'Shortcuts', 'System']);

  await settingsTab(page, 'Audio & video');
  await page.keyboard.press('ArrowRight');
  await expect(settings.getByRole('tab', { name: 'Screen sharing' })).toBeFocused();
  await expect(settings.getByRole('tab', { name: 'Screen sharing' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(settings.getByRole('tab', { name: 'System' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(settings.getByRole('tab', { name: 'Audio & video' })).toBeFocused();

  // Shortcuts of the page behind must not fire, and the room must not change.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  await page.keyboard.press('Slash');
  await expect(settings).toBeVisible();
  await expect(page.locator('.composer textarea')).not.toBeFocused();

  await settingsTab(page, 'Profile');
  const color = (name: string) => settings.getByRole('checkbox', { name, exact: true });
  const shown = () => settings.locator('.profile-card .orb').evaluate((el: HTMLElement) => el.style.getPropertyValue('--base'));
  await color('Lagoon').check();
  await expect.poll(shown).toBe('#35d3ad');
  await color('Moss').check();
  await expect.poll(shown).toBe('#9dc65a');
  await color('Coral').check();
  await expect.poll(shown).toBe('#f0684c');
  await expect(color('Sky')).toBeDisabled();
  await color('Coral').uncheck();
  await expect(color('Sky')).toBeEnabled();
  expect(['#35d3ad', '#9dc65a']).toContain(await shown());
  await color('Coral').check();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(opener).toBeFocused();

  await page.reload();
  await opener.click();
  await settingsTab(page, 'Profile');
  for (const name of ['Lagoon', 'Moss', 'Coral']) await expect(color(name)).toBeChecked();
  expect(['#35d3ad', '#9dc65a', '#f0684c']).toContain(await shown());
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toBeHidden();
  await opener.click();
  await page.mouse.click(4, 4);
  await expect(settings).toBeHidden();
});

test('names in chat are one colour each, none alike, and match the avatars', async ({ page }) => {
  await page.goto(app.url);
  await english(page);
  await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } });
  await page.reload();
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
  await page.getByRole('button', { name: 'Увійти', exact: true }).click();
  await english(page);
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
  // The room reopens where it was left, at the older history, so the new line is below.
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
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
    await settingsTab(other, 'System');
    await other.getByRole('button', { name: 'Light', exact: true }).click();
    await other.keyboard.press('Escape');
    await send(other, 'Only the second instance');
    await page.reload();
    await expect(page.getByText('Only the first instance', { exact: true })).toBeVisible();
    await expect(page.getByText('Only the second instance', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsTab(page, 'Profile');
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Alex');
    await page.keyboard.press('Escape');
    await page.request.post(`${app.url}/__mock/reset`, { data: {} });
    await expect(page.getByRole('button', { name: 'Налаштування', exact: true })).toBeVisible();
    await other.reload();
    await expect(other.getByText('Only the second instance', { exact: true })).toBeVisible();
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsTab(other, 'Profile');
    await expect(other.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Second visitor');
    await settingsTab(other, 'System');
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
    await settingsTab(other, 'System');
    await expect(other.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.goto(`${app.url}/design.html?scene=voice`);
    await expect(page.locator('.room-screen')).toBeVisible();
    await expect(page.locator('h1')).not.toBeEmpty();
  } finally { await other.close(); await second.close(); }
});

async function openChat(page: Page) {
  await page.mouse.move(1400, 420);
  await expect(page.locator('body')).toHaveClass(/chat-open/);
}

async function closeChat(page: Page) {
  await page.mouse.move(280, 420);
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
