'use client';

/**
 * TanStack Query hooks for the email-settings domain.
 *
 * Covers: emailAllowlistApi (allowlist CRUD), emailConfigApi (integration channel health).
 *
 * Hook barrel — NOT re-exported from lib/api/index.ts (barrel is used in RSC context;
 * hooks import @tanstack/react-query which must stay client-component-only).
 * Consumers import directly: `import { useEmailAllowlist, ... } from '@/lib/api/email-settings.hooks'`
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { emailAllowlistApi, emailConfigApi } from './email-settings';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const ALLOWLIST_QUERY_KEY = ['settings', 'email_allowlist'] as const;
export const EMAIL_CONFIG_QUERY_KEY = ['email-config'] as const;

// ---------------------------------------------------------------------------
// emailAllowlistApi hooks
// ---------------------------------------------------------------------------

/** Fetch email allowlist (GET settings/email_allowlist). staleTime: 30s. Returns [] on 404. */
export function useEmailAllowlist() {
  return useQuery({
    queryKey: ALLOWLIST_QUERY_KEY,
    queryFn: () => emailAllowlistApi.list(),
    staleTime: 30_000,
  });
}

/**
 * Add an entry to the email allowlist.
 * Caller must pass the current list (from useEmailAllowlist data) as `current`.
 * Invalidates ALLOWLIST_QUERY_KEY on success.
 */
export function useAddEmailAllowlistEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ current, entry }: { current: string[]; entry: string }) =>
      emailAllowlistApi.add(current, entry),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ALLOWLIST_QUERY_KEY });
    },
  });
}

/**
 * Remove an entry from the email allowlist.
 * Caller must pass the current list (from useEmailAllowlist data) as `current`.
 * Invalidates ALLOWLIST_QUERY_KEY on success.
 */
export function useRemoveEmailAllowlistEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ current, entry }: { current: string[]; entry: string }) =>
      emailAllowlistApi.remove(current, entry),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ALLOWLIST_QUERY_KEY });
    },
  });
}

// ---------------------------------------------------------------------------
// emailConfigApi hooks
// ---------------------------------------------------------------------------

/**
 * Fetch email channel health (inbound + outbound).
 * Fetches all integrations and extracts the two email channels client-side.
 * staleTime: 30s.
 */
export function useEmailConfig() {
  return useQuery({
    queryKey: EMAIL_CONFIG_QUERY_KEY,
    queryFn: () => emailConfigApi.get(),
    staleTime: 30_000,
  });
}
