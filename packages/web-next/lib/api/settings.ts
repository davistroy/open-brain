/**
 * Settings API — GET/PUT /api/v1/settings/:key.
 * Read/write app_settings key-value store. Extracted from api-client.ts.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import type { SettingEntry as SettingEntryType } from '../types'
import { request } from './core'

// ---------------------------------------------------------------------------
// settingsApi
// ---------------------------------------------------------------------------

export const settingsApi = {
  /**
   * GET /api/v1/settings/:key — read a single setting value.
   * Returns `{ key, value, updated_at }`. Throws HttpError 404 if key not set.
   */
  get: (key: string): Promise<SettingEntryType> => {
    return request<SettingEntryType>(`/settings/${encodeURIComponent(key)}`)
  },

  /**
   * PUT /api/v1/settings/:key — write a setting value.
   * Returns `{ key, value, updated_at }`.
   */
  put: (key: string, value: unknown): Promise<SettingEntryType> => {
    return request<SettingEntryType>(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  },
}
