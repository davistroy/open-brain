import { defineConfig } from 'vitest/config'

// @vitejs/plugin-react is not installed — Next.js handles the JSX transform.
// jsdom provides the browser environment for component tests.

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Scope to project source tests only. Exclude:
    //   - Playwright E2E smoke tests (require @playwright/test + live stack → `pnpm test:e2e`)
    //   - .next/ build output (contains Next.js internal Jest-based tests that use `jest` global)
    //   - node_modules (default, made explicit)
    include: ['lib/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/smoke/**', '.next/**', 'node_modules/**'],
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
