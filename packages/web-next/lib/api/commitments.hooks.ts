'use client';

/**
 * TanStack Query hooks for the commitments domain.
 *
 * Hook barrel — NOT re-exported from lib/api/index.ts (barrel is used in RSC context;
 * hooks import @tanstack/react-query which must stay client-component-only).
 * Consumers import directly: `import { useCommitmentsForEntity, ... } from '@/lib/api/commitments.hooks'`
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commitmentsApi } from './commitments';
import type { CommitmentsListParams, CreateCommitmentPayload, PatchCommitmentPayload } from './commitments';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const COMMITMENTS_QUERY_KEY = ['commitments'] as const;

export const commitmentsKeys = {
  all: COMMITMENTS_QUERY_KEY,
  list: (params: CommitmentsListParams = {}) => ['commitments', 'list', params] as const,
  forEntity: (entityId: string, params?: { limit?: number }) =>
    ['commitments', 'entity', entityId, params] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/** List commitments with optional status/entity_id filters. */
export function useCommitments(params: CommitmentsListParams = {}) {
  return useQuery({
    queryKey: commitmentsKeys.list(params),
    queryFn: () => commitmentsApi.list(params),
    staleTime: 30_000,
  });
}

/** Open commitments for a specific entity — used by CommitmentsCard. */
export function useCommitmentsForEntity(entityId: string, params?: { limit?: number }) {
  return useQuery({
    queryKey: commitmentsKeys.forEntity(entityId, params),
    queryFn: () => commitmentsApi.forEntity(entityId, params),
    staleTime: 30_000,
    enabled: Boolean(entityId),
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

/** Resolve a commitment — sets resolved: true. Performs optimistic removal from entity list. */
export function useResolveCommitment(entityId?: string) {
  const queryClient = useQueryClient();
  const entityQueryKey = entityId ? commitmentsKeys.forEntity(entityId) : null;

  return useMutation({
    mutationFn: (id: string) => commitmentsApi.patch(id, { resolved: true }),

    onMutate: async (id: string) => {
      if (!entityQueryKey) return;
      await queryClient.cancelQueries({ queryKey: entityQueryKey });
      const previous = queryClient.getQueryData(entityQueryKey);
      queryClient.setQueryData(entityQueryKey, (old: { items: { id: string }[]; total: number } | undefined) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.filter((c) => c.id !== id),
          total: Math.max(0, old.total - 1),
        };
      });
      return { previous };
    },

    onError: (_err, _id, context) => {
      if (entityQueryKey && context?.previous) {
        queryClient.setQueryData(entityQueryKey, context.previous);
      }
    },

    onSettled: () => {
      // Invalidate both the entity-specific list and the global commitments list.
      if (entityQueryKey) {
        queryClient.invalidateQueries({ queryKey: entityQueryKey });
      }
      queryClient.invalidateQueries({ queryKey: COMMITMENTS_QUERY_KEY });
    },
  });
}

/** Patch a commitment (status, due_date, resolved). */
export function usePatchCommitment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchCommitmentPayload }) =>
      commitmentsApi.patch(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COMMITMENTS_QUERY_KEY });
    },
  });
}

/** Create a new commitment. */
export function useCreateCommitment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateCommitmentPayload) => commitmentsApi.create(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COMMITMENTS_QUERY_KEY });
    },
  });
}
