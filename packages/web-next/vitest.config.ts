import { defineConfig } from 'vitest/config'

// @vitejs/plugin-react is not installed — Next.js handles the JSX transform.
// jsdom provides the browser environment for component tests.

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
    globals: true,
  },
})
