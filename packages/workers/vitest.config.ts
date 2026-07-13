import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['src/__tests__/integration/**'],
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/main.ts', 'src/__tests__/**'],
      thresholds: {
        lines: 78,      // package floor — do not lower
        functions: 81,  // package floor — do not lower

        // Per-file glob thresholds — lock in current high-coverage modules
        // (still enforced under Vitest 3; verified live in the CS-F coverage run)
        // Floors pinned at measured baseline from 2026-05-09 coverage run.
        'src/skills/base-skill.ts': { lines: 100, functions: 100 },
        'src/lib/ingest-dedup.ts': { lines: 100, functions: 100 },
        'src/lib/spend-tracker.ts': { lines: 100, functions: 100 },
        'src/flows/ingest-pipeline.ts': { lines: 100, functions: 100 },
      },
    },
  },
})
