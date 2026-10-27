import { defineConfig } from '@playwright/experimental-ct-react'
import viteConfig from './vite.config.ts'

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.browser.test.tsx',
  outputDir: 'test-results/components',
  fullyParallel: true,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/components.json' }]],
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    ctViteConfig: viteConfig,
  },
})
