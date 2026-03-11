import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/integration/**/*.test.ts'],
    // Integration tests hit real DB/Redis — run sequentially to avoid contention
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Longer timeout for DB + Redis operations
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Fail fast — if DB/Redis setup fails, no point running remaining tests
    bail: 1,
  },
})
