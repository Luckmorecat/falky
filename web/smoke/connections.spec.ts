import { test, expect, type Page } from '@playwright/test';
import type { MockState } from '../mock/protocol';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
let fixture: MockState;
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({ page }) => {
  fixture = await (await page.request.post(`${app.url}/__mock/reset`, { data: { scenario: 'same-person' } })).json();
  await page.addInitScript(({ instanceId, generation, visitor }) => {
    const prefix = `falky.mock.${instanceId}.`;
    localStorage.setItem(`falky.mock-generation.${instanceId}`, String(generation));
    localStorage.setItem(prefix + 'language', 'en');
    localStorage.setItem(prefix + 'volume.' + visitor!.id, '0');
  }, fixture);
  await page.goto(`${app.url}/?scenario=same-person`);
});
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const state = async (page: Page): Promise<MockState> => (await page.request.get(`${app.url}/__mock/state`)).json();

async function join(page: Page, button = 'Join') {
  const response = page.waitForResponse((r) => /\/api\/rooms\/[^/]+\/voice$/.test(r.url()));
  await page.getByRole('button', { name: button, exact: true }).click();
  const credentials = await (await response).json();
  await expect(page.getByRole('toolbar')).toBeVisible();
  return credentials.grantId as string;
}

test('same-person connections keep separate prejoin entries, remote screen/camera and local controls', async ({ page }) => {
  const peers = fixture.peers[fixture.rooms[0]!.id]!;
  await expect(page.locator('.stage .tile')).toHaveCount(2);
  await page.getByRole('button', { name: 'Rooms: Lounge', exact: true }).hover();
  await expect(page.locator('.room-list .room').first().locator('.people > span')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.mouse.move(1400, 950);
  const localId = await join(page);
  await expect(page.locator('.stage .tile')).toHaveCount(3);
  await expect(page.locator('.share video')).toHaveAttribute('aria-label', "Alex's screen");
  await expect(tile(page, peers[0]!.connectionId).locator('video')).toHaveClass('on');
  await expect(tile(page, localId).locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await expect(tile(page, localId).locator('video')).toHaveClass('on mirror');
  await expect(tile(page, peers[0]!.connectionId).locator('video')).toHaveClass('on');
  await expect(page.locator('.share-label')).toHaveText("Alex's screen");
  await expect.poll(() => page.locator('.share video').evaluate((el: HTMLVideoElement) => el.videoWidth)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await expect(page.getByRole('toolbar')).toHaveCount(0);
  await expect(page.locator('.stage .tile')).toHaveCount(2);
  expect((await state(page)).rooms[0]!.occupancy.map((p) => p.connectionId)).toEqual(peers.map((p) => p.connectionId));
});

test('playback volume changes only one connection and a new connection starts at normal volume', async ({ page }) => {
  const roomId = fixture.rooms[0]!.id;
  const peers = fixture.peers[roomId]!.map((p) => ({ ...p, sharing: false, camera: false }));
  await page.request.post(`${app.url}/__mock/action`, { data: { type: 'participants', roomId, participants: peers } });
  const localId = await join(page);
  const first = tile(page, peers[0]!.connectionId).getByRole('slider');
  const second = tile(page, peers[1]!.connectionId).getByRole('slider');
  await expect(first).toHaveValue('1'); await expect(second).toHaveValue('1');
  await expect(tile(page, localId).getByRole('slider')).toHaveCount(0);
  await first.focus(); await page.keyboard.press('Home');
  await expect(first).toHaveValue('0'); await expect(second).toHaveValue('1');
  const replacement = { ...peers[0]!, connectionId: peers[0]!.visitorId + '.new' };
  await page.request.post(`${app.url}/__mock/action`, { data: { type: 'participants', roomId, participants: [replacement, peers[1]] } });
  await expect(tile(page, replacement.connectionId).getByRole('slider')).toHaveValue('1');
  await expect(second).toHaveValue('1');
});

test('room switching disconnects the local captured connection while same-person remote connections stay', async ({ page }) => {
  const oldGrant = await join(page);
  const games = fixture.rooms[1]!;
  await page.getByRole('button', { name: 'Rooms: Lounge', exact: true }).hover();
  await page.locator('.room-list .room', { hasText: 'Games' }).click();
  const newGrant = await join(page, 'Move here');
  expect(newGrant).not.toBe(oldGrant);
  await expect.poll(async () => (await state(page)).voiceConnections).toEqual({ [newGrant]: games.id });
  expect((await state(page)).rooms[0]!.occupancy.map((p) => p.connectionId)).toEqual(fixture.peers[fixture.rooms[0]!.id]!.map((p) => p.connectionId));
});

test('two app instances in one session keep their own media through another instance switch and Leave', async ({ page, context }) => {
  const firstGrant = await join(page);
  const other = await context.newPage();
  try {
    await other.goto(`${app.url}/?scenario=same-person`);
    const secondGrant = await join(other);
    await expect(page.getByRole('toolbar')).toBeVisible();
    await expect.poll(async () => Object.keys((await state(page)).voiceConnections).sort()).toEqual([firstGrant, secondGrant].sort());
    await page.getByRole('button', { name: 'Rooms: Lounge', exact: true }).hover();
    await page.locator('.room-list .room', { hasText: 'Games' }).click();
    const thirdGrant = await join(page, 'Move here');
    await expect.poll(async () => Object.keys((await state(page)).voiceConnections).sort()).toEqual([secondGrant, thirdGrant].sort());
    await expect(other.getByRole('toolbar')).toBeVisible();
    await page.getByRole('button', { name: 'Leave voice', exact: true }).click();
    await expect.poll(async () => Object.keys((await state(page)).voiceConnections)).toEqual([secondGrant]);
    await expect(other.getByRole('toolbar')).toBeVisible();
    await expect(other.locator('.stage .tile')).toHaveCount(3);
    await other.getByRole('button', { name: 'Leave voice', exact: true }).click();
  } finally { await other.close(); }
});
