import '@testing-library/jest-dom/vitest'
import { server } from './msw-server'
import { afterAll, afterEach, beforeAll } from 'vitest'

// Start the MSW server before all tests; close after all tests complete.
// afterEach resets handlers so per-test overrides don't leak between tests.
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
