/**
 * Config & Triggers API — GET /api/v1/config/integrations, /api/v1/config/ai-routing,
 * and CRUD /api/v1/triggers. Extracted from api-client.ts.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import type { Integration, Trigger, AIRoutingConfig } from '../types'
import { request } from './core'

// ---------------------------------------------------------------------------
// configApi — read integration health via GET /api/v1/config/integrations
// ---------------------------------------------------------------------------

export interface IntegrationsResponse {
  integrations: Integration[];
}

export const configApi = {
  /**
   * GET /api/v1/config/integrations — list all configured integrations with
   * health status. Used by the Settings → Sources section.
   */
  integrations: (): Promise<IntegrationsResponse> => {
    return request<IntegrationsResponse>('/config/integrations')
  },
}

// ---------------------------------------------------------------------------
// triggersApi — semantic trigger management (Settings → Triggers)
//
// Endpoint map (see packages/core-api/src/routes/triggers.ts):
//   GET    /api/v1/triggers          → { triggers: Trigger[] }
//   POST   /api/v1/triggers          → { trigger: Trigger }   (201)
//   DELETE /api/v1/triggers/:id      → { message: string }
// ---------------------------------------------------------------------------

export interface CreateTriggerPayload {
  name: string;
  queryText: string;
  description?: string;
  threshold?: number;
  cooldownMinutes?: number;
  deliveryChannel?: 'pushover' | 'slack' | 'both';
}

export const triggersApi = {
  /**
   * GET /api/v1/triggers — list all triggers (active and inactive).
   * Returns { triggers: Trigger[] }.
   */
  list: (): Promise<{ triggers: Trigger[] }> => {
    return request<{ triggers: Trigger[] }>('/triggers')
  },

  /**
   * POST /api/v1/triggers — create a new trigger.
   * Generates an embedding from queryText server-side.
   * Returns 201 { trigger: Trigger }.
   */
  create: (payload: CreateTriggerPayload): Promise<{ trigger: Trigger }> => {
    return request<{ trigger: Trigger }>('/triggers', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  /**
   * DELETE /api/v1/triggers/:id — hard-delete a trigger by UUID or name.
   * Returns { message: string }.
   */
  delete: (id: string): Promise<{ message: string }> => {
    return request<{ message: string }>(
      `/triggers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
}

// ---------------------------------------------------------------------------
// aiRoutingApi — GET /api/v1/config/ai-routing (Settings → AI routing)
// ---------------------------------------------------------------------------

export const aiRoutingApi = {
  /**
   * GET /api/v1/config/ai-routing — task-to-model routing table + monthly budget.
   * Returns AIRoutingConfig { models: ModelRoutingEntry[], budget: { ... } }.
   */
  get: (): Promise<AIRoutingConfig> => request<AIRoutingConfig>('/config/ai-routing'),
}
