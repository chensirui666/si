import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    exclude: ['src/**/*.browser.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
}))
