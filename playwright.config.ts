import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    env: { AI_MODE: 'demo', DATA_FILE: '.context/e2e-state.json', SUBMISSIONS_PER_MINUTE: '100', NAMES_PER_MINUTE: '100' },
    timeout: 30_000,
  },
});
