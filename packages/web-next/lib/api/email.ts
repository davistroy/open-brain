/**
 * API client — email drafts domain.
 *
 * Covers the email drafts management endpoints (M3, screen 6.3).
 * This file handles ONLY the emailApi (drafts) namespace.
 * emailAllowlistApi and emailConfigApi live in email-settings.ts.
 *
 * Endpoint map (see packages/core-api/src/routes/email.ts):
 *   GET    /api/v1/email/drafts              → { items, total, limit, offset }
 *   GET    /api/v1/email/drafts/:id          → EmailDraft
 *   POST   /api/v1/email/drafts/:id/send     → { id, status, sent_at }
 *   DELETE /api/v1/email/drafts/:id          → { id, status }
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString, ListEnvelope } from './core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailDraftStatus = 'draft' | 'approved' | 'sent' | 'rejected' | 'failed';
export type EmailSendMode = 'review-required' | 'auto-send';

/** Email draft as returned by the API list/get endpoints. */
export interface EmailDraft {
  id: string;
  to_address: string;
  cc_address: string | null;
  subject: string;
  body: string;
  status: EmailDraftStatus;
  send_mode: EmailSendMode;
  source: string | null;
  approved_at: string | null;   // ISO 8601 or null
  sent_at: string | null;       // ISO 8601 or null
  capture_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;           // ISO 8601
  updated_at: string;           // ISO 8601
}

export interface EmailDraftsListParams {
  status?: EmailDraftStatus;
  limit?: number;
  offset?: number;
}

/** Response envelope from POST /api/v1/email/drafts/:id/send */
export interface EmailDraftSendResult {
  id: string;
  status: EmailDraftStatus;
  sent_at: string | null;
}

/** Response envelope from DELETE /api/v1/email/drafts/:id */
export interface EmailDraftRejectResult {
  id: string;
  status: EmailDraftStatus;
}

// ---------------------------------------------------------------------------
// emailApi — email drafts management
// ---------------------------------------------------------------------------

export const emailApi = {
  /**
   * GET /api/v1/email/drafts — paginated list of email drafts.
   * Optional status filter: 'draft' | 'approved' | 'sent' | 'rejected' | 'failed'.
   */
  list: (params: EmailDraftsListParams = {}): Promise<ListEnvelope<EmailDraft>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<EmailDraft>>(`/email/drafts${qs}`)
  },

  /**
   * GET /api/v1/email/drafts/:id — fetch a single draft.
   */
  get: (id: string): Promise<EmailDraft> => {
    return request<EmailDraft>(`/email/drafts/${encodeURIComponent(id)}`)
  },

  /**
   * POST /api/v1/email/drafts/:id/send — approve and send a draft.
   * Transitions draft status to 'approved' then 'sent' (or 'failed').
   */
  send: (id: string): Promise<EmailDraftSendResult> => {
    return request<EmailDraftSendResult>(
      `/email/drafts/${encodeURIComponent(id)}/send`,
      { method: 'POST' },
    )
  },

  /**
   * DELETE /api/v1/email/drafts/:id — reject and discard a draft.
   * Transitions draft status to 'rejected'.
   */
  reject: (id: string): Promise<EmailDraftRejectResult> => {
    return request<EmailDraftRejectResult>(
      `/email/drafts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
}
