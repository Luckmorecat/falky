import { execFileSync } from 'node:child_process';
import { test, expect, type Locator } from '@playwright/test';
import { launchMock } from './launcher';

let app: Awaited<ReturnType<typeof launchMock>>;
const version = `dev ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)}`;
test.beforeAll(async () => { app = await launchMock(); });
test.afterAll(async () => { await app?.close(); });

async function selectableVersion(label: Locator) {
  await expect(label).toHaveText(version);
  await expect(label).toHaveCSS('opacity', '0.5');
  await expect(label).toHaveCSS('user-select', 'text');
  expect(await label.evaluate((el) => {
    const selection = window.getSelection()!;
    selection.selectAllChildren(el);
    return selection.toString();
  })).toBe(version);
  await expect(label.locator('a, button')).toHaveCount(0);
}

for (const width of [1440, 390]) {
  test(`version is readable and selectable only on the main screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const label = page.locator('.build-version:visible');
    await page.route('**/__mock/bootstrap', (route) => route.abort());
    await page.goto(app.url);
    await expect(page.locator('#root')).toContainText('Не вдалося відкрити Falky');
    await expect(label).toHaveCount(0);
    await page.unroute('**/__mock/bootstrap');
    await page.goto(`${app.url}/?scenario=entry`);
    await expect(page.locator('.enter')).toBeVisible();
    await expect(label).toHaveCount(0);
    await page.goto(`${app.url}/?scenario=populated`);
    await expect(page.locator('.dock')).toBeVisible();
    await selectableVersion(label);
    const bounds = (await label.boundingBox())!;
    const dock = (await page.locator('.dock').boundingBox())!;
    expect(bounds.x < dock.x + dock.width && bounds.x + bounds.width > dock.x
      && bounds.y < dock.y + dock.height && bounds.y + bounds.height > dock.y).toBe(false);
    await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(label).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('.build-version')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Система', exact: true }).click();
    await page.getByRole('button', { name: 'Світла', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(label).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await selectableVersion(label);
    if (width === 390) {
      await page.locator('.chat-btn').click();
      await expect(page.locator('.chat')).toBeVisible();
      await expect(label).toHaveCount(0);
      await page.locator('.chat-btn').click();
      await selectableVersion(label);
    }
    await page.request.post(`${app.url}/__mock/action`, { data: { type: 'revoke' } });
    await expect(page.locator('.enter')).toBeVisible();
    await expect(label).toHaveCount(0);
  });
}
