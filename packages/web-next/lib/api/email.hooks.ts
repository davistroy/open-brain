'use client';

/**
 * Email drafts domain hooks — TanStack Query mutations for email draft actions.
 *
 * Covers:
 *   - Send an email draft (EmailTabs / DraftCard)
 *   - Reject an email draft (EmailTabs / DraftCard)
 *
 * These are mutation-only hooks. No queries — the email drafts list is
 * server-prefetched (RSC) and managed with local state by EmailTabs.
 *
 * NOTE: These hooks are intentionally NOT exported from lib/api/index.ts —
 * hooks must stay client-component-only; the barrel is imported in RSC contexts.
 * Consumers import directly: import { useSendEmailDraft } from '@/lib/api/email.hooks'
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { emailApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Query key constants (shared with any future useQuery for email drafts)
// ---------------------------------------------------------------------------

export const EMAIL_DRAFTS_QUERY_KEY = ['email-drafts'] as const;

// ---------------------------------------------------------------------------
// useSendEmailDraft — approve and send an email draft
// ---------------------------------------------------------------------------

/**
 * Mutation to approve and send an email draft.
 * POST /api/v1/email/drafts/:id/send → { id, status, sent_at }
 *
 * On success: invalidates ['email-drafts'] so any query-based consumers refresh.
 * EmailTabs also does local-state optimistic update in its onSuccess callback.
 */
export function useSendEmailDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => emailApi.send(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMAIL_DRAFTS_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// useRejectEmailDraft — reject and discard an email draft
// ---------------------------------------------------------------------------

/**
 * Mutation to reject an email draft.
 * DELETE /api/v1/email/drafts/:id → { id, status }
 *
 * On success: invalidates ['email-drafts'] so any query-based consumers refresh.
 * EmailTabs also does local-state optimistic update in its onSuccess callback.
 */
export function useRejectEmailDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => emailApi.reject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMAIL_DRAFTS_QUERY_KEY });
    },
  });
}
