import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/models.live.ts'],
    maxConcurrency: 6,
    retry: 0,
  },
})
