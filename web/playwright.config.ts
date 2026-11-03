import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/e2e',
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  workers: 1,
  timeout: 90_000,
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    // 授权导航包含临时令牌，不把它写进 trace。
    trace: 'off',
  },
})
