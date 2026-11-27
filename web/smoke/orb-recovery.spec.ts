import { expect, test } from '@playwright/test';
import type { MockState } from '../mock/protocol';
import { chromiumOptions } from './browser';
import { launchMock } from './launcher';

test.use({ launchOptions: { ...chromiumOptions(), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('keeps avatars visible through a mid-frame WebGL loss and resumes drawing', async ({ page }) => {
  const app = await launchMock(0, { stats: false });
  try {
    const state: MockState = await (await page.request.post(`${app.url}/__mock/bootstrap`, { data: { scenario: 'populated' } })).json();
    await page.addInitScript((state) => {
      localStorage.setItem(`falky.mock-generation.${state.instanceId}`, String(state.generation));
      localStorage.setItem(`falky.mock.${state.instanceId}.language`, 'en');
      localStorage.setItem(`falky.mock.${state.instanceId}.orbLight`, 'volume');

      let loseNextDraw = false;
      let extension: WEBGL_lose_context | null = null;
      document.addEventListener('test:lose-orbs', () => { loseNextDraw = true; });
      document.addEventListener('test:restore-orbs', () => extension?.restoreContext());
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (mode, first, count) {
        if (loseNextDraw && this.canvas instanceof HTMLCanvasElement && !this.canvas.isConnected) {
          loseNextDraw = false;
          extension = this.getExtension('WEBGL_lose_context')!;
          this.canvas.addEventListener('webglcontextlost', () => { document.body.dataset.orbContextLost = 'true'; }, { once: true });
          extension.loseContext();
        }
        draw.call(this, mode, first, count);
      };
    }, state);

    await page.goto(app.url);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    const leave = page.getByRole('button', { name: 'Leave voice', exact: true });
    await expect(leave).toBeVisible();
    const canvases = page.locator('.grid .orb canvas');
    const alphas = () => canvases.evaluateAll((elements: HTMLCanvasElement[]) => elements.map((canvas) => {
      if (!canvas.width) return 0;
      return canvas.getContext('2d')!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3];
    }));
    const widths = () => canvases.evaluateAll((elements: HTMLCanvasElement[]) => elements.map((canvas) => canvas.width));
    const fallback = page.locator('.grid .orb.flat');
    await expect(page.locator('.grid .orb.volume')).toHaveCount(3);
    await expect.poll(alphas).toEqual([255, 255, 255]);
    const originalWidths = await widths();

    await page.evaluate(() => document.dispatchEvent(new Event('test:lose-orbs')));
    await expect(page.locator('body')).toHaveAttribute('data-orb-context-lost', 'true');
    expect(await alphas()).toEqual([255, 255, 255]);
    await expect(fallback).toHaveCount(3);
    await expect(canvases.first()).toHaveCSS('visibility', 'hidden');

    await page.setViewportSize({ width: 720, height: 640 });
    await expect.poll(widths).not.toEqual(originalWidths);
    await expect(fallback).toHaveCount(3);
    await expect(leave).toBeVisible();

    await page.evaluate(() => document.dispatchEvent(new Event('test:restore-orbs')));
    await expect(fallback).toHaveCount(0);
    await expect(canvases.first()).toBeVisible();
    await expect(page.locator('.grid .orb.volume')).toHaveCount(3);
    await expect.poll(alphas).toEqual([255, 255, 255]);
  } finally {
    await app.close();
  }
});
