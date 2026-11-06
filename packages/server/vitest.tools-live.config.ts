import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/tool-execution.live.ts'],
    retry: 0,
    silent: false,
  },
})
