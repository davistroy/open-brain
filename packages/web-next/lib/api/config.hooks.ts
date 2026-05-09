'use client';

/**
 * TanStack Query hooks for the config domain.
 *
 * Covers: configApi (integrations), triggersApi, aiRoutingApi.
 *
 * Hook barrel — NOT re-exported from lib/api/index.ts (barrel is used in RSC context;
 * hooks import @tanstack/react-query which must stay client-component-only).
 * Consumers import directly: `import { useIntegrations, useTriggers, ... } from '@/lib/api/config.hooks'`
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi, triggersApi, aiRoutingApi } from './config';
import type { CreateTriggerPayload } from './config';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const INTEGRATIONS_QUERY_KEY = ['config', 'integrations'] as const;
export const TRIGGERS_QUERY_KEY = ['triggers'] as const;
export const AI_ROUTING_QUERY_KEY = ['ai-routing'] as const;

// ---------------------------------------------------------------------------
// configApi hooks
// ---------------------------------------------------------------------------

/** Fetch all configured integrations with health status. staleTime: 30s. */
export function useIntegrations() {
  return useQuery({
    queryKey: INTEGRATIONS_QUERY_KEY,
    queryFn: () => configApi.integrations(),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// triggersApi hooks
// ---------------------------------------------------------------------------

/** List all semantic triggers. staleTime: 30s. */
export function useTriggers() {
  return useQuery({
    queryKey: TRIGGERS_QUERY_KEY,
    queryFn: () => triggersApi.list(),
    staleTime: 30_000,
  });
}

/** Create a new semantic trigger — invalidates the triggers list on success. */
export function useCreateTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateTriggerPayload) => triggersApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRIGGERS_QUERY_KEY });
    },
  });
}

/** Delete a semantic trigger by id — invalidates the triggers list on success. */
export function useDeleteTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => triggersApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRIGGERS_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// aiRoutingApi hooks
// ---------------------------------------------------------------------------

/** Fetch AI model routing table + monthly budget. staleTime: 60s (config rarely changes). */
export function useAIRouting() {
  return useQuery({
    queryKey: AI_ROUTING_QUERY_KEY,
    queryFn: () => aiRoutingApi.get(),
    staleTime: 60_000,
  });
}
