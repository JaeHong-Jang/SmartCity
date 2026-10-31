// Performance baseline (ADR 0013 §7): the benchmark city (2,000 buildings, ~1,000 roads, traffic),
// fixed viewport 1600×900 at DPR 1, noon, a fixed set of camera poses and a short orbit. Records
// frame time p50/p95/p99, main vs shadow-pass draw calls, triangles and vehicle interpolation CPU
// time to test-results/perf/p6-<label>.json. Nothing adapts quality automatically in this renderer,
// so the measurement runs at the one fixed quality.
//
// Skipped unless SC_PERF=1. Hardware GL under WSL (Mesa d3d12 → the Windows GPU), frame cap off:
//   SC_PERF=1 SC_PERF_LABEL=before E2E_WEB_PORT=5191 npx playwright test e2e/perf/p6-bench.spec.ts
// SC_PERF_GL=swiftshader measures with the software renderer the other e2e tests use instead;
// SC_PERF_ADAPTER=NVIDIA picks a GPU, SC_PERF_VSYNC=1 keeps the 60 Hz cap, SC_PERF_PAUSE=1 stops traffic.
// Heavier traffic: SC_PERF_VEHICLES=5000 SC_PERF_DENSITY=3 SC_PERF_WARMUP_S=360 (defaults 3000, 2, 180).
// SC_PERF_POSES=street measures only those poses (no orbit / shadows-off); SC_PERF_NIGHT=1 also measures them at 22:00.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const swift = process.env.SC_PERF_GL === 'swiftshader';
test.skip(process.env.SC_PERF !== '1', 'performance run only with SC_PERF=1');
test.use({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  launchOptions: {
    args: swift
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
      : ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', ...(process.env.SC_PERF_VSYNC === '1' ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])],
    // SC_PERF_ADAPTER picks the Windows GPU by name (e.g. NVIDIA); Mesa's default is the first adapter.
    env: { ...process.env, GALLIUM_DRIVER: 'd3d12', ...(process.env.SC_PERF_ADAPTER ? { MESA_D3D12_DEFAULT_ADAPTER_NAME: process.env.SC_PERF_ADAPTER } : {}) } as Record<string, string>,
  },
});
test.setTimeout(600_000);

interface Stats {
  fps: number;
  drawCalls: number;
  triangles: number;
  shadowCalls?: number;
  shadowTriangles?: number;
  frameMs?: { p50: number; p95: number; p99: number };
  interpMs?: { mean: number; max: number };
}

const H = 'window.__smartcity';
const hook = <T,>(page: Page, expr: string): Promise<T> => page.evaluate(`(async () => { const h = ${H}; return ${expr}; })()`) as Promise<T>;

/** Camera poses: [label, camera x, y, z, target x, z]. */
const POSES: [string, number, number, number, number, number][] = [
  ['overview', -1100, 1250, 1500, 0, 0],
  ['district', -260, 240, 330, 0, 0],
  ['street', -70, 22, 95, 0, 0],
];

/**
 * Live frame stats over `ms`, then the render cost alone: mean of 3 × 40 back-to-back renders synced
 * by a pixel read-back (vsync and frame scheduling do not quantize it), reported as the median batch.
 */
async function measure(page: Page, ms: number): Promise<Stats & { vehicles: number; renderMs: number }> {
  await page.waitForTimeout(1500);
  await hook(page, 'h.perf.resetFrameTimes()');
  await page.waitForTimeout(ms);
  const live = await hook<Stats & { vehicles: number }>(page, '({ ...h.perf.stats(), vehicles: h.store.getState().simStats?.vehicles ?? 0 })');
  const batches: number[] = [];
  for (let i = 0; i < 3; i++) batches.push(await hook<number>(page, 'h.perf.renderCost(40)'));
  batches.sort((a, b) => a - b);
  return { ...live, renderMs: batches[1]! };
}

test('benchmark city frame stats', async ({ page }) => {
  const label = process.env.SC_PERF_LABEL ?? 'run';
  const room = `perf-${Date.now().toString(36)}`;
  await page.goto(`/?offline=1&room=${room}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  const opts = process.env.SC_PERF_DENSITY ? { trafficDensity: Number(process.env.SC_PERF_DENSITY) } : {};
  const made = await hook<{ buildings: number; segments: number }>(page, `h.perf.saveBenchCity(${JSON.stringify(room)}, ${JSON.stringify(opts)})`);
  await page.goto(`/?offline=1&room=${room}`);
  await page.waitForFunction(() => !!(window as unknown as { __smartcity?: unknown }).__smartcity);
  await expect.poll(() => hook<number>(page, 'Object.keys(h.store.getState().doc.buildings).length'), { timeout: 60_000 }).toBe(made.buildings);
  const gl = await page.evaluate(() => {
    const c = document.querySelector('canvas.city-canvas') as HTMLCanvasElement;
    const g = c.getContext('webgl2')!;
    const e = g.getExtension('WEBGL_debug_renderer_info');
    return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : String(g.getParameter(g.RENDERER));
  });
  await hook(page, 'h.perf.setDayTime(12 * 3600)');

  // Traffic warm-up at 4×, then measure at 1×.
  await hook(page, 'h.store.set({ simSpeed: 4 })');
  const target = Number(process.env.SC_PERF_VEHICLES ?? 3000);
  const t0 = Date.now();
  while (Date.now() - t0 < Number(process.env.SC_PERF_WARMUP_S ?? 180) * 1000) {
    const v = await hook<number>(page, 'h.store.getState().simStats?.vehicles ?? 0');
    if (v >= target) break;
    await page.waitForTimeout(2000);
  }
  // SC_PERF_PAUSE=1 freezes the traffic for the measurement (rendering cost only, no snapshot traffic).
  await hook(page, `h.store.set({ simSpeed: ${process.env.SC_PERF_PAUSE === '1' ? 0 : 1} })`);

  const results: Record<string, unknown> = {};
  const save = (): void => {
    mkdirSync('test-results/perf', { recursive: true });
    const out = { label, gl, viewport: '1600x900@1', made, at: new Date().toISOString(), results };
    writeFileSync(`test-results/perf/p6-${label}.json`, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  };
  const only = process.env.SC_PERF_POSES?.split(',');
  const poses = only ? POSES.filter(([name]) => only.includes(name)) : POSES;
  for (const [name, px, py, pz, tx, tz] of poses) {
    await hook(page, `h.lookAt(${px}, ${py}, ${pz}, ${tx}, ${tz})`);
    results[name] = await measure(page, 5000);
    await page.screenshot({ path: `test-results/perf/p6-${label}-${name}.png` });
  }
  if (only) {
    if (process.env.SC_PERF_NIGHT === '1') {
      await hook(page, 'h.perf.setDayTime(22 * 3600)');
      for (const [name, px, py, pz, tx, tz] of poses) {
        await hook(page, `h.lookAt(${px}, ${py}, ${pz}, ${tx}, ${tz})`);
        results[`${name}Night`] = await measure(page, 5000);
        await page.screenshot({ path: `test-results/perf/p6-${label}-${name}-night.png` });
      }
    }
    save();
    return;
  }
  // Orbit: one full turn around the district view in 8 s, the azimuth set every frame in proportion
  // to the elapsed time (no damping), with frame times and draw calls aggregated over the whole turn.
  await hook(page, `h.lookAt(${POSES[1]![1]}, ${POSES[1]![2]}, ${POSES[1]![3]}, 0, 0)`);
  await page.waitForTimeout(1000);
  results.orbit = await hook(
    page,
    `new Promise((done) => {
      const c = h.renderer.cam.controls;
      const az0 = c.azimuthAngle;
      const T = 8000;
      const dts = [];
      let calls = 0, shadowCalls = 0, triangles = 0, statN = 0, lastStat = null;
      let t0 = null, prev = null;
      const step = (now) => {
        if (t0 === null) t0 = prev = now;
        else { dts.push(now - prev); prev = now; }
        const k = Math.min(1, (now - t0) / T);
        void c.rotateAzimuthTo(az0 + Math.PI * 2 * k, false);
        const st = h.perf.stats();
        if (st !== lastStat) { lastStat = st; statN++; calls = Math.max(calls, st.drawCalls); shadowCalls = Math.max(shadowCalls, st.shadowCalls ?? 0); triangles = Math.max(triangles, st.triangles); }
        if (k < 1) { requestAnimationFrame(step); return; }
        const s = dts.slice().sort((a, b) => a - b);
        const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
        done({
          fps: Math.round((dts.length * 1000) / (now - t0)),
          drawCalls: calls, shadowCalls, triangles,
          frameMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) },
          interpMs: h.perf.stats().interpMs,
          turned: c.azimuthAngle - az0, frames: dts.length, statWindows: statN,
          vehicles: h.store.getState().simStats?.vehicles ?? 0,
        });
      };
      requestAnimationFrame(step);
    })`,
  );
  // Shadows off at the district pose (shadow-pass share).
  await hook(page, `h.lookAt(${POSES[1]![1]}, ${POSES[1]![2]}, ${POSES[1]![3]}, 0, 0)`);
  await hook(page, '(h.store.set({ overlays: { ...h.store.getState().overlays, shadows: false } }), 0)');
  results.districtNoShadow = await measure(page, 5000);

  save();
});
