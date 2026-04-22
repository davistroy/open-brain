/**
 * TanStack Query v5 client factory + singleton pattern.
 *
 * Design (CS1 D108):
 * - `makeQueryClient()` — always returns a fresh instance. Used server-side
 *   (each RSC render request) to prevent cross-request cache pollution.
 * - `getQueryClient()` — returns the same instance across re-renders/Suspense
 *   retries on the client. Browser branch is safe because there is no shared
 *   request context in the browser.
 *
 * Do NOT use `useState` to hold the QueryClient in the provider — React docs
 * warn that useState is not safe for side-effect initialization and the
 * singleton may be re-created on StrictMode double-invoke.
 *
 * `throwOnError` discriminates by status:
 *   - 5xx → throw → trips the nearest error.tsx boundary
 *   - 4xx → return false → stays in-component (useQuery `error` state)
 *
 * Ref: https://tanstack.com/query/v5/docs/framework/react/guides/advanced-ssr
 */

import { QueryClient } from '@tanstack/react-query'
import { HttpError } from './api-client'

// ---------------------------------------------------------------------------
// Shared default config
// ---------------------------------------------------------------------------

function buildQueryClientDefaults() {
  return {
    queries: {
      staleTime: 60_000,
      retry: 2,
      throwOnError: (err: unknown) =>
        err instanceof HttpError && err.status >= 500,
    },
  } as const
}

// ---------------------------------------------------------------------------
// makeQueryClient — always fresh (for RSC / server usage)
// ---------------------------------------------------------------------------

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: buildQueryClientDefaults(),
  })
}

// ---------------------------------------------------------------------------
// getQueryClient — singleton in the browser, fresh on the server
// ---------------------------------------------------------------------------

let browserQueryClient: QueryClient | undefined

export function getQueryClient(): QueryClient {
  const isServer = typeof window === 'undefined'

  if (isServer) {
    // Server: always return a fresh instance — no cross-request pollution.
    return makeQueryClient()
  }

  // Browser: return cached singleton so query cache survives Suspense retries.
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient()
  }
  return browserQueryClient
}
