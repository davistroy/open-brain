'use client'

/**
 * SseProvider — single EventSource owner for the entire app.
 *
 * Mounts one SseClient instance in a useEffect, subscribes to all events, and
 * maps each event to TanStack Query invalidations via SSE_INVALIDATION_MAP.
 * Cleanup on unmount stops the client and removes the subscription so Fast
 * Refresh in dev doesn't leak EventSource connections.
 *
 * Tree position: QueryClientProvider → SseProvider → children
 * (SSE must be inside QueryClientProvider to call useQueryClient.)
 *
 * Ref: CS1 work item 3.2
 */

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SseClient } from '../../lib/sse-client'
import { SSE_INVALIDATION_MAP, resolveQueryKey } from '../../lib/sse-invalidation-map'
import type { SseEvent } from '../../lib/sse-client'

interface SseProviderProps {
  children: React.ReactNode
}

export function SseProvider({ children }: SseProviderProps) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const client = new SseClient()

    const unsubscribe = client.on((evt: SseEvent) => {
      // connection_lost is synthetic — no query keys to invalidate, but we
      // could show a toast in a future phase (M3 backlog).
      if (evt.type === 'connection_lost') return

      const templates = SSE_INVALIDATION_MAP[evt.type]
      if (!templates || templates.length === 0) return

      const captureId =
        typeof evt.data.capture_id === 'string' ? evt.data.capture_id : undefined

      for (const template of templates) {
        const queryKey = resolveQueryKey(template, captureId)
        queryClient.invalidateQueries({ queryKey })
      }
    })

    client.start()

    return () => {
      unsubscribe()
      client.stop()
    }
  }, [queryClient])

  return <>{children}</>
}
