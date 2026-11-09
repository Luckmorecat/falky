import { test, expect, type Page } from '@playwright/test';
import type { MockAction, MockState } from '../mock/protocol';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
let fixture: MockState;
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({ page }) => {
  fixture = await (await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'populated' } })).json();
  await control(page, { type: 'colour', visitorId: fixture.visitor!.id, palette: 'sky' });
  await page.context().addInitScript(({ instanceId, generation }) => {
    localStorage.setItem(`falky.mock-generation.${instanceId}`, String(generation));
    localStorage.setItem(`falky.mock.${instanceId}.language`, 'en');
    localStorage.setItem(`falky.mock.${instanceId}.theme`, 'dark');
  }, fixture);
});
async function control(page: Page, data: MockAction) {
  const response = await page.request.post(`${app.url}/__mock/action`, { data });
  expect(response.ok()).toBeTruthy(); return response.json();
}
async function profile(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Profile', exact: true }).click();
  await expect(page.locator('.color input:checked')).toHaveCount(1);
}
const swatch = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });
const base = (page: Page, selector: string) => page.locator(selector).first().evaluate((el: HTMLElement) => el.style.getPropertyValue('--base'));
const authorRows = (page: Page, name: string) => page.locator('.msg', { has: page.locator('.msg-author', { hasText: new RegExp(`^${name}$`) }) });
async function authorColour(page: Page, name: string, colour: string) {
  await expect(authorRows(page, name).first()).toBeAttached();
  await expect.poll(() => authorRows(page, name).evaluateAll((rows) => [...new Set(rows.map((el) => (el as HTMLElement).style.getPropertyValue('--base')))])).toEqual([colour]);
}

test('one confirmed swatch waits for acceptance, retains selection on failed save and retries the exact colour', async ({ page }) => {
  await page.goto(app.url); await profile(page);
  await expect(swatch(page, 'Sky')).toBeChecked();
  const reselected = page.waitForResponse((r) => r.url().endsWith('/api/me/colour') && r.request().method() === 'PUT');
  await swatch(page, 'Sky').click();
  expect((await (await reselected).json()).palette).toBe('sky');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/me/colour', async (route) => { await gate; await route.continue(); });
  await swatch(page, 'Rose').click();
  await expect(page.getByRole('status')).toHaveText('Saving colour…');
  await expect(swatch(page, 'Sky')).toBeChecked();
  expect(await base(page, '.profile-card .orb')).toBe('#4f98ee');
  release();
  await expect(swatch(page, 'Rose')).toBeChecked();
  await expect(page.getByRole('status')).toHaveCount(0);
  await control(page, { type: 'faults', faults: { colourSave: 'fail' } });
  await swatch(page, 'Moss').click();
  await expect(page.getByRole('alert')).toHaveText('Could not save your colour. Try again.');
  await expect(swatch(page, 'Rose')).toBeChecked();
  expect(await base(page, '.profile-card .orb')).toBe('#f08ca8');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(swatch(page, 'Moss')).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.color input:checked')).toHaveCount(1);
  await page.reload(); await profile(page); await expect(swatch(page, 'Moss')).toBeChecked();
});

test('tabs with different loaded history agree on duplicate colours, live recolouring and offline-author recovery without new messages', async ({ page, context }) => {
  await page.goto(app.url);
  const other = await context.newPage();
  try {
    await other.goto(app.url);
    await page.bringToFront();
    await page.keyboard.press('Slash');
    await expect(page.getByText('Welcome back! Try sending a message or joining voice.', { exact: true })).toBeVisible();
    const older = page.waitForResponse((response) => response.url().includes('/messages?before='), { timeout: 10_000 });
    await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; }); await older;
    await page.locator('.feed').evaluate((el) => { el.scrollTop = 0; });
    await expect(page.getByText('Lounge history 1', { exact: true })).toBeAttached();
    await expect(other.getByText('Lounge history 1', { exact: true })).toHaveCount(0);
    const sam = fixture.rooms[0]!.occupancy.find((p) => p.name === 'Sam')!;
    const robin = fixture.rooms[0]!.occupancy.find((p) => p.name === 'Robin')!;
    await control(page, { type: 'colour', visitorId: sam.visitorId, palette: 'ruby' });
    await control(page, { type: 'colour', visitorId: robin.visitorId, palette: 'ruby' });
    for (const tab of [page, other]) {
      await authorColour(tab, 'Sam', '#d42a55'); await authorColour(tab, 'Robin', '#d42a55');
      await expect.poll(() => base(tab, `[data-tile="${sam.connectionId}"]`)).toBe('#d42a55');
      await expect.poll(() => base(tab, `[data-tile="${robin.connectionId}"]`)).toBe('#d42a55');
    }
    await control(page, { type: 'participants', roomId: fixture.rooms[0]!.id, participants: [] });
    await expect(page.locator('[data-tile]')).toHaveCount(0);
    await control(page, { type: 'faults', faults: { liveDisconnected: true } });
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
    await expect(other.getByText('Reconnecting', { exact: true })).toBeVisible();
    await control(page, { type: 'colour', visitorId: sam.visitorId, palette: 'moss' });
    await control(page, { type: 'colour', visitorId: robin.visitorId, palette: 'moss' });
    await authorColour(page, 'Sam', '#d42a55');
    await control(page, { type: 'faults', faults: { liveDisconnected: false } });
    for (const tab of [page, other]) { await authorColour(tab, 'Sam', '#9dc65a'); await authorColour(tab, 'Robin', '#9dc65a'); }
    await other.reload(); await authorColour(other, 'Sam', '#9dc65a');
  } finally { await other.close(); }
});

test('two tabs converge on the last accepted edit while an earlier response is delayed', async ({ page, context }) => {
  await page.goto(app.url); await profile(page);
  const other = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await other.goto(app.url); await profile(other);
    let accepted!: () => void;
    const committed = new Promise<void>((resolve) => { accepted = resolve; });
    await page.route('**/api/me/colour', async (route) => {
      const response = await route.fetch(); accepted(); await gate; await route.fulfill({ response });
    });
    await swatch(page, 'Rose').click(); await committed;
    await expect(swatch(other, 'Rose')).toBeChecked();
    await swatch(other, 'Moss').click();
    for (const tab of [page, other]) await expect(swatch(tab, 'Moss')).toBeChecked();
    release();
    await expect(page.getByRole('status')).toHaveCount(0);
    for (const tab of [page, other]) { await expect(swatch(tab, 'Moss')).toBeChecked(); expect(await base(tab, '.profile-card .orb')).toBe('#9dc65a'); }
    await page.reload(); await profile(page); await expect(swatch(page, 'Moss')).toBeChecked();
  } finally { release(); await other.close(); }
});
