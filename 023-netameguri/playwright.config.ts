import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `rm -rf ./.e2e-data && npx vite build --config web/vite.config.ts >/dev/null && NETAMEGURI_DATA_DIR=./.e2e-data NETAMEGURI_TEST_MODE=1 NETAMEGURI_LOG=0 NETAMEGURI_AUTH_RATE_IP=200 NETAMEGURI_AUTH_RATE_EMAIL=100 PORT=${PORT} npx tsx server/src/main.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
