import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

/**
 * Use the bundled browser when it is installed; otherwise fall back to the newest Chromium already
 * in the Playwright cache (or CHROMIUM_PATH), so the smoke test runs without a browser download.
 */
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const exe = join(cache, d, 'chrome-linux64', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

// E2E_SERVER=1 also starts apps/server (port 8790, throwaway data dir) for the collaboration test.
// Ports differ from the dev defaults (5280/8780) so a running dev setup is never reused by accident.
const withServer = process.env.E2E_SERVER === '1';
// E2E_WEB_PORT / E2E_SERVER_PORT override them when something else already listens there.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 8790);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  outputDir: 'test-results/artifacts',
  reporter: [['list']],
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1600, height: 900 },
    launchOptions: { executablePath: chromiumPath(), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    ...(withServer
      ? [
          {
            command: 'npm run start -w @smartcity/server',
            port: SERVER_PORT,
            // SC_AI_FAKE: the scripted AI assistant (no API key, no network) for the phase 3c flow.
            env: { PORT: String(SERVER_PORT), DATA_DIR: 'test-results/server-data', SC_AI_FAKE: '1' },
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ]
      : []),
    {
      command: `npm run dev -w @smartcity/web -- --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { SMARTCITY_SERVER_URL: `ws://localhost:${SERVER_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
