'use client';

/**
 * Admin domain hooks — TanStack Query mutations for admin operations.
 *
 * Covers:
 *   - Slack channel archive (ChannelTable)
 *   - BullMQ queue clear (QueuesTab)
 *
 * These are mutation-only hooks. No queries — admin list data is server-fetched
 * (RSC prefetch) and managed with local state by the consumers.
 *
 * NOTE: These hooks are intentionally NOT exported from lib/api/index.ts —
 * hooks must stay client-component-only; the barrel is imported in RSC contexts.
 * Consumers import directly: import { useArchiveSlackChannel } from '@/lib/api/admin.hooks'
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminApi, adminQueuesApi } from '@/lib/api-client';
import type { ClearableState } from '@/lib/api/admin';

// ---------------------------------------------------------------------------
// useArchiveSlackChannel — archive a Slack channel by ID
// ---------------------------------------------------------------------------

/**
 * Mutation to archive a Slack channel.
 * POST /api/v1/admin/slack/channels/:id/archive → SlackArchiveResult
 *
 * On success: invalidates ['slack-channels'] so any queries or RSC revalidations
 * pick up the archived state.
 *
 * Consumer (ChannelTable) does its own local-state optimistic update and toast
 * in onSuccess/onError callbacks passed to mutate().
 */
export function useArchiveSlackChannel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => adminApi.archiveSlackChannel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slack-channels'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useClearQueue — clear failed (or other) jobs from a BullMQ queue
// ---------------------------------------------------------------------------

interface ClearQueueVariables {
  name: string;
  state?: ClearableState;
}

/**
 * Mutation to clear jobs in a given state from a BullMQ queue.
 * POST /api/v1/admin/queues/:name/clear { state } → QueueClearResult
 *
 * Default state: 'failed' (matches adminQueuesApi.clear default).
 * Consumer (QueuesTab) handles toast + page reload in mutation callbacks.
 */
export function useClearQueue() {
  return useMutation({
    mutationFn: ({ name, state = 'failed' }: ClearQueueVariables) =>
      adminQueuesApi.clear(name, state),
  });
}
