// AI assistant e2e (scripted model: server runs with SC_AI_FAKE=1, the real Claude API is never called):
// where the proposal landed (camera, beacon, "최근 적용" list), the AI badge, and building from a picture.
import { expect, test, type Page } from '@playwright/test';

interface Hook {
  store: { getState(): { doc: { buildings: Record<string, { typeId: string }>; buildingTypes: Record<string, { name: string; origin?: string }> } } };
  renderer: { highlightStats(): { beacons: number; pulsingBuildings: number; lots: number } };
  worldToScreen(x: number, z: number): { x: number; y: number };
  lookAt(px: number, py: number, pz: number, tx: number, tz: number): void;
  cameraTarget(): { x: number; z: number };
}

const hook = (page: Page) => <T>(fn: (h: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__smartcity)`) as Promise<T>;

async function clickWorld(page: Page, x: number, z: number) {
  const p = await page.evaluate(([x, z]) => (window as unknown as { __smartcity: Hook }).__smartcity.worldToScreen(x!, z!), [x, z]);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
}

const ask = async (page: Page, text: string) => {
  await page.locator('textarea[aria-label="AI에게 요청"]').fill(text);
  await page.locator('[data-ai-send]').click();
};

test('AI: applied location is shown (camera, beacon, list), picture request builds a badged design', async ({ page }) => {
  test.skip(process.env.E2E_SERVER !== '1', 'needs E2E_SERVER=1 (the AI assistant runs on the server)');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const h = hook(page);

  await page.goto(`/?room=e2e-ai-${Date.now().toString(36)}`);
  await expect(page.locator('.badge')).toContainText('온라인');
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: Hook }).__smartcity);
  await h((s) => s.lookAt(-40, 220, 220, 0, 20));
  await page.waitForTimeout(300);

  // A road to build next to.
  await page.locator('[data-tool="road"]').click();
  await clickWorld(page, -180, 0);
  await clickWorld(page, 180, 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');

  // 1. Text request -> proposal -> apply.
  await page.locator('[role="tab"]', { hasText: 'AI' }).click();
  await expect(page.locator('[data-ai-panel]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-ai-applied]')).toHaveCount(0);
  await ask(page, '도로 북쪽에 카페 지어줘');
  await expect(page.locator('[data-ai-proposal]')).toBeVisible({ timeout: 20_000 });
  // No highlight before approval.
  expect((await h((s) => s.renderer.highlightStats())).beacons).toBe(0);
  await page.locator('[data-ai-apply]').click();
  await expect(page.locator('[data-ai-applied]')).toHaveCount(1, { timeout: 5000 });
  await expect.poll(async () => (await h((s) => s.renderer.highlightStats())).beacons, { timeout: 5000 }).toBeGreaterThan(0);
  expect((await h((s) => s.renderer.highlightStats())).pulsingBuildings).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/ai-applied-beacon.png' });

  // "보기": move the camera far away first, then the button brings it back to the new buildings.
  await h((s) => s.lookAt(900, 300, 900, 900, 900));
  await page.waitForTimeout(300);
  const far = await h((s) => s.cameraTarget());
  expect(Math.abs(far.x - 900)).toBeLessThan(5);
  await page.locator('[data-ai-applied] [data-ai-show]').click();
  const built = await h((s) => {
    const b = Object.entries(s.store.getState().doc.buildings).filter(([id]) => id.startsWith('ai-'));
    return b.length;
  });
  expect(built).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs((await h((s) => s.cameraTarget())).x), { timeout: 8000 }).toBeLessThan(220);
  await expect.poll(async () => Math.abs((await h((s) => s.cameraTarget())).z), { timeout: 8000 }).toBeLessThan(220);
  await page.screenshot({ path: 'test-results/ai-show-again.png' });

  // "확인": the beacon goes away.
  await page.locator('[data-ai-applied] [data-ai-confirm]').click();
  await expect.poll(async () => (await h((s) => s.renderer.highlightStats())).beacons, { timeout: 3000 }).toBe(0);
  await expect(page.locator('[data-ai-applied] [data-ai-confirm]')).toBeDisabled();

  // 2. Picture request: attach a generated PNG (no text -> the default sentence is used).
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const g = c.getContext('2d')!;
    g.fillStyle = '#9ec5e8';
    g.fillRect(0, 0, 400, 300);
    g.fillStyle = '#44627f';
    g.fillRect(150, 40, 100, 240);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  await page.locator('[data-ai-file]').setInputFiles({ name: 'tower.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('[data-ai-thumb]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/ai-image-attached.png' });
  await page.locator('[data-ai-send]').click();
  await expect(page.locator('[data-ai-thumb]')).toHaveCount(0);
  await expect(page.locator('[data-ai-msg="user"]').last()).toContainText('이미지 1장');
  await expect(page.locator('[data-ai-proposal]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.ai-items')).toContainText('AI 유리 오피스');
  await page.locator('[data-ai-apply]').click();
  await expect(page.locator('[data-ai-applied]')).toHaveCount(2, { timeout: 5000 });
  const glass = await h((s) => Object.values(s.store.getState().doc.buildingTypes).find((t) => t.name === 'AI 유리 오피스')?.origin);
  expect(glass).toBe('ai');

  // The design list shows the AI badge.
  await page.locator('[role="tab"]', { hasText: '건물' }).click();
  await expect(page.locator('.bp-designs [data-ai-badge]')).toHaveCount(2, { timeout: 5000 });
  await page.locator('.bp-designs [data-ai-badge]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ai-badge-designs.png' });
  expect(errors).toEqual([]);
});
