// Look comparison shots for P6c-1 (ADR 0013 §6): the same small town (9 × 9 roads, 300 buildings)
// and an empty city, at noon and at night, from the start camera, the city view and eye level.
// Works on builds with and without the view buttons (falls back to equivalent fixed poses), so the
// same file shoots "before" and "after": test-results/p6c1-<label>-{start,city,full,eye,night,empty,narrow}.png.
// Skipped unless SC_PERF=1:
//   SC_PERF=1 SC_PERF_LABEL=after E2E_WEB_PORT=5191 npx playwright test e2e/perf/p6c1-shots.spec.ts
import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.SC_PERF !== '1', 'look shots only with SC_PERF=1');
test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;
const label = process.env.SC_PERF_LABEL ?? 'run';
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/p6c1-${label}-${name}.png` });

/** Click a view button when this build has it; otherwise set the equivalent pose directly. */
async function view(page: Page, which: 'city' | 'eye', fallback: [number, number, number, number, number]) {
  const btn = page.locator(`[data-view="${which}"]`);
  if ((await btn.count()) > 0) await btn.click();
  else await hook(page, `h.lookAt(${fallback.join(', ')})`);
  await page.waitForTimeout(3500);
}

test('town and empty city shots', async ({ page }) => {
  const room = `look-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await page.waitForTimeout(2500);
  await shot(page, 'empty');

  await hook(page, `h.perf.saveBenchCity(${JSON.stringify(room)}, { grid: 9, buildings: 300, trafficDensity: 1 })`);
  await page.goto(`/?offline=1&room=${room}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 60_000 }).toBe(300);
  await page.waitForTimeout(4000);
  await shot(page, 'start');
  // At the entry (district) view, "도시 보기" shows the whole city; pressed again, the district.
  // Builds without the toggle use the same fallback pose for both.
  await view(page, 'city', [-520, 560, 640, 0, 0]);
  await shot(page, 'full');
  await view(page, 'city', [-520, 560, 640, 0, 0]);
  await shot(page, 'city');
  await hook(page, 'h.perf.setDayTime(22 * 3600)');
  await page.waitForTimeout(1500);
  await shot(page, 'night');
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await view(page, 'eye', [-55, 10, 70, 0, 0]);
  await shot(page, 'eye');
  // HUD fit on a smaller screen (top bar and status bar with the new controls).
  await page.setViewportSize({ width: 1280, height: 720 });
  await view(page, 'city', [-520, 560, 640, 0, 0]);
  await shot(page, 'narrow');
});
