import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/model-tools.live.ts'],
    retry: 0,
    silent: false,
  },
})
