import { expect, test } from '@playwright/test';

interface StudioHook {
  editor: { doc: { model: { cells: Map<string, number> } } };
  scene: { controls: { azimuthAngle: number; polarAngle: number } };
}

const studio = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __studio: StudioHook }).__studio;
    return { az: s.scene.controls.azimuthAngle, polar: s.scene.controls.polarAngle, cells: s.editor.doc.model.cells.size };
  });

/** Waits until the camera azimuth stops moving (animations are slow under software GL). */
async function settled(page: import('@playwright/test').Page): Promise<number> {
  let prev = NaN;
  await page.waitForTimeout(800);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const az = (await studio(page)).az;
    if (Math.abs(az - prev) < 1e-4) return az;
    prev = az;
  }
  return prev;
}

/** Smallest absolute difference of two angles in degrees. */
const diffDeg = (a: number, b: number) => {
  const d = (((((a - b) * 180) / Math.PI) % 360) + 540) % 360 - 180;
  return Math.abs(d);
};

test('phase 4a: studio camera views, keys, Alt+drag, panel collapse', async ({ page }) => {
  await page.goto(`/?offline=1&room=e2e-4a-${Date.now().toString(36)}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await page.locator('[role="tab"]', { hasText: '건물' }).click();
  await page.locator('[data-studio-new]').click();
  await expect(page.locator('[data-studio]')).toBeVisible();
  await expect(page.locator('[data-studio-guide]')).toBeVisible();
  await page.locator('[data-studio-guide-close]').click();
  await expect(page.locator('[data-studio-guide]')).toHaveCount(0);

  const canvas = page.locator('[data-studio] canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 2; i++) {
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(200);
  }
  expect((await studio(page)).cells).toBe(2);

  await page.locator('[data-view="front"]').click();
  await expect.poll(async () => diffDeg((await studio(page)).az, 0), { timeout: 20_000 }).toBeLessThan(5);
  const front = await settled(page);
  await page.locator('[data-view="back"]').click();
  await expect.poll(async () => Math.abs(diffDeg((await studio(page)).az, front) - 180), { timeout: 20_000 }).toBeLessThan(5);
  const back = await settled(page);
  await page.screenshot({ path: 'test-results/phase4a-studio-back.png' });

  // Q turns 15 degrees (code based, so it also works with a Korean IME).
  await page.keyboard.press('KeyQ');
  await expect.poll(async () => Math.abs(diffDeg((await studio(page)).az, back) - 15), { timeout: 20_000 }).toBeLessThan(3);

  // Alt + left drag rotates and places nothing.
  const before = await studio(page);
  await page.keyboard.down('Alt');
  await page.mouse.move(cx, cy + 120);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 120, { steps: 8 });
  await page.mouse.move(cx + 160, cy + 120, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await settled(page);
  const after = await studio(page);
  expect(diffDeg(after.az, before.az)).toBeGreaterThan(5);
  expect(after.cells).toBe(before.cells);

  // Shift+right click on a block pans/does nothing: it must not erase. Numpad digits never pick tools.
  await page.locator('[data-view="front"]').click();
  await settled(page);
  const n0 = (await studio(page)).cells;
  await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 3, cy);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  expect((await studio(page)).cells).toBe(n0);
  await page.keyboard.press('Numpad2');
  await expect(page.locator('[data-studio-tool="stack"]')).toHaveClass(/active/);

  // Tab hides the side panels; the view buttons and save/close stay.
  await expect(page.locator('.st-side')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('.st-side')).toBeHidden();
  await expect(page.locator('.st-tools')).toBeHidden();
  await expect(page.locator('[data-view="back"]')).toBeVisible();
  await expect(page.locator('[data-studio-save]')).toBeVisible();
  await expect(page.locator('[data-studio-close]')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('.st-side')).toBeVisible();
});
