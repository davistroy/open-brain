/**
 * Admin API — queue management and Slack/data-reset administration.
 * Extracted from lib/api-client.ts (domain split, Phase 8a).
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request } from './core'

// ---------------------------------------------------------------------------
// adminQueuesApi — queue clear via POST /api/v1/admin/queues/:name/clear
// ---------------------------------------------------------------------------

export type ClearableState = 'failed' | 'completed' | 'delayed'

export interface QueueClearResult {
  queue: string
  state: ClearableState
  cleared_count: number
  cleared_at: string
}

export const adminQueuesApi = {
  /**
   * POST /api/v1/admin/queues/:name/clear — clears jobs in a given state.
   * Default state: 'failed'. No adminAuth — protected by queue name whitelist.
   */
  clear: (
    name: string,
    state: ClearableState = 'failed',
  ): Promise<QueueClearResult> => {
    return request<QueueClearResult>(
      `/admin/queues/${encodeURIComponent(name)}/clear`,
      { method: 'POST', body: JSON.stringify({ state }) },
    )
  },
}

// ---------------------------------------------------------------------------
// adminApi — Slack channel management via /api/v1/admin/slack/* endpoints
//
// Endpoint map (see packages/core-api/src/routes/admin.ts):
//   GET  /api/v1/admin/slack/channels              → { channels: SlackChannelInfo[] }
//   POST /api/v1/admin/slack/channels/:id/archive  → ArchiveResult
//
// NOTE: These endpoints require SLACK_BOT_TOKEN or SLACK_USER_TOKEN to be set
// on core-api. If neither is set, the API returns 503.
// ---------------------------------------------------------------------------

/** Slack channel info as returned by GET /api/v1/admin/slack/channels */
export interface SlackChannel {
  id: string
  name: string
  member_count: number
  last_activity: string | null
  days_inactive: number
  topic?: string
  purpose?: string
  is_archived: boolean
}

/** Result of POST /api/v1/admin/slack/channels/:id/archive */
export interface SlackArchiveResult {
  ok: boolean
  channel_id: string
  archived_at: string
}

/** Step-1 response from POST /admin/reset-data (no confirm field) */
export interface AdminResetTokenResponse {
  token: string
  expires_in: number    // seconds (typically 300 = 5 minutes)
  message: string
}

/** Step-2 response from POST /admin/reset-data (with confirm + token) */
export interface AdminResetConfirmResponse {
  cleared: string[]
  preserved: string[]
  wiped_at: string
  backup_path: string
  audit_id: string
}

export const adminApi = {
  /**
   * GET /api/v1/admin/slack/channels — list all public Slack channels with
   * activity metadata (member count, last_activity, days_inactive).
   * Returns 503 if no Slack token is configured.
   */
  getSlackChannels: (): Promise<{ channels: SlackChannel[] }> => {
    return request<{ channels: SlackChannel[] }>('/admin/slack/channels')
  },

  /**
   * POST /api/v1/admin/slack/channels/:id/archive — archive a Slack channel by ID.
   * Requires channels:write scope on the configured Slack token.
   */
  archiveSlackChannel: (id: string): Promise<SlackArchiveResult> => {
    return request<SlackArchiveResult>(
      `/admin/slack/channels/${encodeURIComponent(id)}/archive`,
      { method: 'POST' },
    )
  },

  /**
   * POST /api/v1/admin/reset-data (Step 1) — request a single-use reset token.
   *
   * No body sent. Server issues a 5-minute single-use Redis token and records
   * the request in admin_audit. Returns token + expires_in.
   *
   * Per CLAUDE.md: no adminAuth() — protection is origin allowlist + two-step
   * token + confirmation phrase + rate limiter. Do not add Bearer auth here.
   *
   * The origin must be brain.troy-davis.com — the server performs the
   * authoritative check (fail-closed: unset/unknown NODE_ENV = production).
   */
  requestResetToken: (): Promise<AdminResetTokenResponse> => {
    return request<AdminResetTokenResponse>('/admin/reset-data', { method: 'POST' })
  },

  /**
   * POST /api/v1/admin/reset-data (Step 2) — execute the data wipe.
   *
   * Requires `confirm: "WIPE ALL DATA"` and the token from step 1.
   * Server truncates all tables except admin_audit; pre-wipe pg_dump to
   * /backup/pre-wipe/<ISO>.sql (admin_prewipe_backup volume).
   *
   * Every attempt (executed/blocked/error) writes to admin_audit.
   * admin_audit is excluded from TRUNCATE — code-level test asserts this.
   */
  confirmReset: (
    token: string,
    phrase: 'WIPE ALL DATA',
  ): Promise<AdminResetConfirmResponse> => {
    return request<AdminResetConfirmResponse>('/admin/reset-data', {
      method: 'POST',
      body: JSON.stringify({ confirm: phrase, token }),
    })
  },
}
