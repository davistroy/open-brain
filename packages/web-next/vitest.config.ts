import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// @vitejs/plugin-react is not installed — Next.js handles the JSX transform.
// jsdom provides the browser environment for component tests.

// Component source uses the `@/*` path alias (tsconfig paths). Vitest/Vite does
// not read tsconfig paths, so mirror the `@` → package-root mapping here.
// The `^@(/|$)` match rule means scoped deps (@tanstack, @testing-library,
// @open-brain) are unaffected — only `@/...` imports are rewritten.
const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Scope to project source tests. Covers lib/ unit tests plus component
    // tests colocated under components/**/__tests__ and app/**/__tests__
    // (RTL + jsdom + MSW). Exclude:
    //   - Playwright E2E smoke tests (require @playwright/test + live stack → `pnpm test:e2e`)
    //   - .next/ build output (contains Next.js internal Jest-based tests that use `jest` global)
    //   - node_modules (default, made explicit)
    include: [
      'lib/__tests__/**/*.{test,spec}.{ts,tsx}',
      'components/**/*.{test,spec}.{ts,tsx}',
      'app/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['tests/**', '.next/**', 'node_modules/**'],
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
