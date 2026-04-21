'use client'

/**
 * Root client-side providers for Open Brain web-next.
 *
 * Wraps the app in TanStack Query v5's QueryClientProvider using the
 * `getQueryClient()` singleton so:
 *   1. The same QueryClient is reused across Suspense retries (no cache loss).
 *   2. Server-side renders get a fresh client per request (no cross-request
 *      pollution — `getQueryClient()` handles the isServer branch internally).
 *
 * Usage: wrap `{children}` in `<Providers>` inside `app/layout.tsx`.
 *
 * RSC screens that SSR-prefetch data should wrap their content in
 * `<HydrationBoundary state={dehydrate(qc)}>` — that pattern lands per-screen
 * in Phases 7/8 when screens are individually wired.
 *
 * Ref: CS1 D108 / work item 2.2
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { getQueryClient } from '../lib/query-client'
import { SseProvider } from '../components/providers/sse-provider'

interface ProvidersProps {
  children: React.ReactNode
}

export function Providers({ children }: ProvidersProps) {
  // getQueryClient() returns the browser singleton on the client, or a fresh
  // instance on the server. Do NOT wrap this in useState — see query-client.ts.
  const queryClient = getQueryClient()

  return (
    <QueryClientProvider client={queryClient}>
      {/* SseProvider must be inside QueryClientProvider — it calls useQueryClient(). */}
      <SseProvider>
        {children}
      </SseProvider>
    </QueryClientProvider>
  )
}
