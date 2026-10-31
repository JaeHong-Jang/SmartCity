// P7c-1 (ADR 0014 §4·§5): median boulevards drawn without breaking (lanes at the median edge, the median a
// plain surface until P7c-2), the road type editor's median fields, and the Korean high-rise residential
// look / glass reflection on the new presets. Screenshots: test-results/p7c1-*.png.
// Run: E2E_WEB_PORT=5193 npx playwright test e2e/p7c1-median-facade.spec.ts
import { expect, test, type Page } from '@playwright/test';

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);

/**
 * Builds the scene in the page with the app's own shared module (served by Vite) and stores it as the
 * offline save of `room`: an 8-lane median boulevard crossing a 6-lane one, apartment blocks facing south,
 * a cross-plan tower, a mixed-use tower and a glass office podium.
 */
async function seed(page: Page, room: string): Promise<{ buildings: number; failed: string[] }> {
  return page.evaluate(async (room) => {
    const mod = (await import(/* @vite-ignore */ '/@id/@smartcity/shared')) as typeof import('@smartcity/shared');
    const doc = mod.createEmptyDoc('p7c1', 5);
    const failed: string[] = [];
    const run = (cmd: import('@smartcity/shared').Command) => {
      const r = mod.applyCommand(doc, cmd);
      if (!r.ok) failed.push(`${cmd.type}: ${r.error}`);
    };
    const node = (id: string, x: number, z: number) => run({ type: 'node.add', node: { id, pos: { x, z } } });
    node('c', 0, 0);
    node('w', -420, 0);
    node('e', 420, 0);
    node('n', 0, -420);
    node('s', 0, 420);
    run({ type: 'segment.add', segment: { id: 'W', a: 'w', b: 'c', roadTypeId: 'road-8-median' } });
    run({ type: 'segment.add', segment: { id: 'E', a: 'c', b: 'e', roadTypeId: 'road-8-median' } });
    run({ type: 'segment.add', segment: { id: 'N', a: 'n', b: 'c', roadTypeId: 'road-6-median' } });
    run({ type: 'segment.add', segment: { id: 'S', a: 'c', b: 's', roadTypeId: 'road-6-median' } });
    const place = (id: string, typeId: string, x: number, z: number, rotation = 0) => run({ type: 'building.place', building: { id, typeId, pos: { x, z }, rotation } });
    // South of the boulevard (+z): a row of slab blocks facing it, a tower behind them.
    place('slab1', 'apt-slab-25', -170, 50);
    place('slab2', 'apt-slab-25', -95, 50);
    place('slab3', 'apt-slab-25', -170, 110);
    place('slab4', 'apt-slab-25', -95, 110);
    place('tower1', 'apt-tower-35', -150, 175);
    place('apt', 'apartment', -60, 170);
    // North of it: the glass podium and the mixed-use tower.
    place('podium', 'glass-podium', 80, -60);
    place('mixed', 'mixed-tower', 160, -60);
    place('mixed2', 'mixed-use', 90, -140);
    place('office', 'office-tower', 170, -140);
    localStorage.setItem(`smartcity:offline:${room}`, JSON.stringify({ seq: 1, doc, savedAt: Date.now() }));
    return { buildings: Object.keys(doc.buildings).length, failed };
  }, room);
}

test('median boulevards and the high-rise look render; the road type editor edits the median', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /THREE\.WebGLProgram|shader/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  const room = `e2e-p7c1-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  const seeded = await seed(page, room);
  expect(seeded.failed).toEqual([]);
  await page.goto(`/?offline=1&room=${room}`);
  await ready(page);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 30_000 }).toBe(seeded.buildings);
  // The compiled graph carries the median lanes (offsets from the shared laneOffset).
  await expect.poll(() => hook<number>(page, 'h.renderer.roadNetwork.graph ? h.renderer.roadNetwork.graph.lanes.length : 0'), { timeout: 30_000 }).toBe(2 * 8 + 2 * 6);
  await hook(page, 'h.perf.setDayTime(11 * 3600)');

  const shot = async (name: string, cam: [number, number, number, number, number]) => {
    await hook(page, `h.lookAt(${cam.join(',')})`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `test-results/p7c1-${name}.png` });
  };
  await shot('overview', [-420, 260, 420, -40, 20]);
  await shot('junction', [-70, 38, 70, 0, 0]);
  await shot('apartments', [-300, 90, 260, -130, 100]);
  await shot('gable', [-260, 40, 40, -150, 70]);
  await shot('glass', [260, 70, -260, 110, -80]);
  await hook(page, 'h.perf.setDayTime(21 * 3600)');
  await shot('night', [-420, 220, 420, -40, 20]);
  await hook(page, 'h.perf.setDayTime(null)');

  // Road type editor: a median preset shows its fields; making the lanes asymmetric drops the median.
  await page.getByRole('tab', { name: '도로' }).click();
  await page.locator('.panel.side .list button', { hasText: '8차선 대로(중앙녹지)' }).click();
  const median = page.locator('input[data-median]');
  await expect(median).toBeChecked();
  await expect(page.locator('input[data-median-width]')).toHaveValue('6');
  await page.locator('aside.panel.side').screenshot({ path: 'test-results/p7c1-roadtype-editor.png' });
  const backward = page.locator('aside.panel.side input[type="number"]').nth(1);
  await backward.fill('3');
  await expect(median).not.toBeChecked();
  await expect(median).toBeDisabled();
  await backward.fill('4');
  await expect(median).toBeEnabled();
  await median.check();
  await page.locator('input[data-median-width]').fill('3');
  await page.getByRole('button', { name: '저장' }).click();
  await expect.poll(() => hook<unknown>(page, "h.store.getState().doc.roadTypes['road-8-median'].median")).toEqual({ width: 3, planted: true });

  // Studio (Sol P7c-1 #1): the opened apartment keeps its look, and 용도 → 업무 drops it.
  const studioStyles = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __studio?: { scene: { building: { geometry: { getAttribute(n: string): { count: number; getY(i: number): number } } } } } }).__studio;
      const fac = s?.scene.building.geometry.getAttribute('aFacade');
      if (!fac) return [] as number[];
      const out = new Set<number>();
      for (let i = 0; i < fac.count; i++) out.add(fac.getY(i));
      return [...out].sort((a, b) => a - b);
    });
  await page.getByRole('tab', { name: '건물' }).click();
  await page.locator('.panel.side .list button', { hasText: '고층 아파트 (판상 25층)' }).first().click();
  await page.locator('[data-studio-open]').click();
  await expect(page.locator('[data-studio]')).toBeVisible();
  await page.locator('[data-studio-guide-close]').click({ timeout: 3000 }).catch(() => undefined);
  await expect.poll(studioStyles, { timeout: 20_000 }).toEqual(expect.arrayContaining([4, 5]));
  await page.screenshot({ path: 'test-results/p7c1-studio.png' });
  await page.locator('[data-studio] select[aria-label="용도"]').selectOption('office');
  await expect.poll(async () => (await studioStyles()).some((s) => s >= 4), { timeout: 20_000 }).toBe(false);

  expect(errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket/i.test(e))).toEqual([]);
});
