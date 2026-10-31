// P7a render cost A/B in one page (ADR 0014 §8): the benchmark city at the P6 poses, measuring the pure
// render cost (renderCost, as p6-bench) with the streetscape (trees, lamps) and the mountains shown or
// hidden, interleaved so machine load drifts hit every variant alike. Brick sidewalks and the paving grid
// are part of every variant (compare p6-bench runs before/after for those).
//
// Skipped unless SC_PERF=1:
//   SC_PERF=1 SC_PERF_ADAPTER=AMD SC_PERF_VSYNC=1 E2E_WEB_PORT=5195 npx playwright test e2e/perf/p7a-ab.spec.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.SC_PERF !== '1', 'performance run only with SC_PERF=1');
test.use({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  launchOptions: {
    args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', ...(process.env.SC_PERF_VSYNC === '1' ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])],
    env: { ...process.env, GALLIUM_DRIVER: 'd3d12', ...(process.env.SC_PERF_ADAPTER ? { MESA_D3D12_DEFAULT_ADAPTER_NAME: process.env.SC_PERF_ADAPTER } : {}) } as Record<string, string>,
  },
});
test.setTimeout(600_000);

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;

const POSES: [string, number, number, number, number, number][] = [
  ['overview', -1100, 1250, 1500, 0, 0],
  ['district', -260, 240, 330, 0, 0],
  ['street', -70, 22, 95, 0, 0],
];
const VARIANTS: [string, boolean, boolean][] = [
  ['all', true, true],
  ['noStreetscape', false, true],
  ['noMountains', true, false],
  ['neither', false, false],
];

test('P7a layers render cost A/B', async ({ page }) => {
  const room = `perf-ab-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  const made = await hook<{ buildings: number }>(page, `h.perf.saveBenchCity(${JSON.stringify(room)})`);
  await page.goto(`/?offline=1&room=${room}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 60_000 }).toBe(made.buildings);
  await hook(page, 'h.perf.setDayTime(12 * 3600)');
  await hook(page, 'h.store.set({ simSpeed: 0 })');
  const out: Record<string, Record<string, number[]>> = {};
  const layers: Record<string, unknown> = {};
  for (const [name, px, py, pz, tx, tz] of POSES) {
    await hook(page, `h.lookAt(${px}, ${py}, ${pz}, ${tx}, ${tz})`);
    await page.waitForTimeout(1500);
    layers[name] = await hook(page, 'h.renderer.streetscapeStats()');
    out[name] = {};
    for (let round = 0; round < 5; round++) {
      for (const [v, street, mountains] of VARIANTS) {
        await hook(page, `(h.renderer.scene.getObjectByName('streetscape').visible = ${street}, h.renderer.scene.getObjectByName('mountains').visible = ${mountains}, 0)`);
        (out[name]![v] ??= []).push(await hook<number>(page, 'h.perf.renderCost(30)'));
      }
    }
    await hook(page, "(h.renderer.scene.getObjectByName('streetscape').visible = true, h.renderer.scene.getObjectByName('mountains').visible = true, 0)");
  }
  const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1]!;
  const summary = Object.fromEntries(Object.entries(out).map(([p, vs]) => [p, Object.fromEntries(Object.entries(vs).map(([v, a]) => [v, Math.round(median(a) * 100) / 100]))]));
  mkdirSync('test-results/perf', { recursive: true });
  const label = process.env.SC_PERF_LABEL ?? 'run';
  writeFileSync(`test-results/perf/p7a-ab-${label}.json`, JSON.stringify({ label, summary, raw: out, layers }, null, 2));
  console.log(JSON.stringify({ summary, layers }, null, 2));
});
