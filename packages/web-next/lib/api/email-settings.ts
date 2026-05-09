/**
 * Email settings API — allowlist management and email channel health.
 *
 * Cross-domain: wraps settingsApi (./settings) for the email_allowlist key and
 * configApi (./config) for integration-level channel status. Isolated here
 * because both dependencies are peer domain files, not core utilities.
 */

// ---------------------------------------------------------------------------
// Type imports from the local types file (never from @open-brain/shared)
// ---------------------------------------------------------------------------

import type { EmailConfig, EmailChannelStatus, Integration } from '../types'

// ---------------------------------------------------------------------------
// Cross-domain peer imports — resolved once peer files exist (Round 3 build)
// ---------------------------------------------------------------------------

import { HttpError } from './core'
import { settingsApi } from './settings'
import { configApi } from './config'

// ---------------------------------------------------------------------------
// emailAllowlistApi — wraps settingsApi for the email_allowlist key.
//
// The allowlist is stored as a plain string[] in app_settings (key: 'email_allowlist').
// Add/remove is a read-modify-write: fetch current list, splice, PUT.
// A 404 on GET means the list has never been set — treated as empty [].
// ---------------------------------------------------------------------------

export const emailAllowlistApi = {
  /**
   * GET allowlist: fetches settings/email_allowlist and returns the value as string[].
   * Returns [] on 404 (key not yet set).
   */
  list: async (): Promise<string[]> => {
    try {
      const res = await settingsApi.get('email_allowlist')
      return Array.isArray(res.value) ? (res.value as string[]) : []
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return []
      throw err
    }
  },

  /**
   * Add an entry to the allowlist. Reads current list then PUTs merged array.
   * `current` is the pre-fetched list (from the list() call) to avoid a second GET.
   */
  add: async (current: string[], entry: string): Promise<void> => {
    await settingsApi.put('email_allowlist', [...current, entry])
  },

  /**
   * Remove an entry from the allowlist. Reads current list then PUTs filtered array.
   * `current` is the pre-fetched list (from the list() call) to avoid a second GET.
   */
  remove: async (current: string[], entry: string): Promise<void> => {
    await settingsApi.put('email_allowlist', current.filter((e) => e !== entry))
  },
}

// ---------------------------------------------------------------------------
// emailConfigApi — email channel health from GET /api/v1/config/integrations.
//
// Filters configApi.integrations() to the two email channels and maps the
// Integration status values to EmailChannelStatus for the Settings view.
// ---------------------------------------------------------------------------

function integrationStatusToEmailChannelStatus(
  integration: Integration | undefined,
): EmailChannelStatus {
  if (!integration) return 'not_configured'
  switch (integration.status) {
    case 'healthy':  return 'connected'
    case 'degraded': return 'degraded'
    case 'error':    return 'error'
    default:         return 'not_configured'
  }
}

export const emailConfigApi = {
  /**
   * GET email config: fetches all integrations and extracts the two email channels.
   * Returns EmailConfig { inbound: EmailChannel, outbound: EmailChannel }.
   */
  get: async (): Promise<EmailConfig> => {
    const { integrations } = await configApi.integrations()
    const inboundInteg = integrations.find((i) => i.name === 'Email (Inbound)')
    const outboundInteg = integrations.find((i) => i.name === 'Email (Outbound)')
    return {
      inbound: {
        status: integrationStatusToEmailChannelStatus(inboundInteg),
        detail: inboundInteg?.description,
      },
      outbound: {
        status: integrationStatusToEmailChannelStatus(outboundInteg),
        detail: outboundInteg?.description,
      },
    }
  },
}
