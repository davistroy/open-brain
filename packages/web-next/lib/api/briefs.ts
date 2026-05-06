/**
 * API client — briefs domain.
 *
 * Covers the briefs table introduced in M2 (migration 0030): list, get (with
 * UI-layer field synthesis), patch, dismiss, refine, and audio (raw Blob fetch).
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString, getApiBase, HttpError, ListEnvelope } from './core'
import type { TocItem, BriefSource, BriefKind, BriefCover, Brief, BriefDetail } from '../types'

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface BriefsListParams {
  limit?: number
  offset?: number
  kind?: string
}

// ---------------------------------------------------------------------------
// briefsApi — M2 introduces the briefs table (migration 0030)
// ---------------------------------------------------------------------------

export const briefsApi = {
  /** GET /api/v1/briefs — paginated list */
  list: (params: BriefsListParams = {}): Promise<ListEnvelope<Brief>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<Brief>>(`/briefs${qs}`)
  },

  /**
   * GET /api/v1/briefs/:id — full brief with body_html + TOC + sources.
   *
   * The API returns `{ brief: BriefDetailItem }`. This method unwraps that
   * envelope and synthesizes the UI-layer fields (`eyebrow`, `headline`, `meta`)
   * that exist in `BriefDetail` but are not persisted columns:
   *
   *   eyebrow  ← "{KIND} BRIEF · {DAY}, {DATE} · {TIME}"  from kind + generated_at
   *   headline ← brief.title
   *   meta     ← brief.subtitle ?? "{date} brief"
   *
   * toc, sources, refine_options are JSONB arrays — cast to the typed shape.
   */
  get: async (id: string): Promise<BriefDetail> => {
    const envelope = await request<{ brief: Record<string, unknown> }>(
      `/briefs/${encodeURIComponent(id)}`,
    )
    const raw = envelope.brief

    // Synthesize eyebrow: "DAILY BRIEF · TUESDAY, APRIL 22 · 07:00"
    const generatedAt = typeof raw.generated_at === 'string' ? raw.generated_at : (raw.created_at as string)
    const dt = new Date(generatedAt)
    const kindLabel = typeof raw.kind === 'string' ? raw.kind : 'BRIEF'
    const dayName = dt.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
    const monthDay = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }).toUpperCase()
    const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    const eyebrow = `${kindLabel} BRIEF · ${dayName}, ${monthDay} · ${timeStr}`

    const title = typeof raw.title === 'string' ? raw.title : ''
    const subtitle = typeof raw.subtitle === 'string' ? raw.subtitle : null

    // meta: use subtitle if present, otherwise fall back to a minimal date string
    const meta = subtitle ?? `Generated ${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

    // JSONB arrays — cast from unknown; fall back to empty arrays
    const toc = Array.isArray(raw.toc) ? (raw.toc as TocItem[]) : []
    const sources = Array.isArray(raw.sources) ? (raw.sources as BriefSource[]) : []
    const refine_options = Array.isArray(raw.refine_options) ? (raw.refine_options as string[]) : []
    const source_total = sources.length

    return {
      id: raw.id as string,
      kind: raw.kind as BriefKind,
      cover: (raw.cover ?? 'parchment') as BriefCover,
      title,
      subtitle: subtitle ?? '',
      source_skill_log_id: (raw.source_skill_log_id as string | null) ?? null,
      refined_from_id: (raw.refined_from_id as string | null) ?? null,
      generated_at: generatedAt,
      read_at: (raw.read_at as string | null) ?? null,
      dismissed_at: (raw.dismissed_at as string | null) ?? null,
      created_at: raw.created_at as string,
      updated_at: raw.updated_at as string,
      // UI-layer synthesized fields
      eyebrow,
      headline: title,
      meta,
      // JSONB fields
      body_html: typeof raw.body_html === 'string' ? raw.body_html : '',
      toc,
      sources,
      source_total,
      refine_options,
    }
  },

  /** PATCH /api/v1/briefs/:id — update brief metadata (e.g. mark as read) */
  patchRead: (id: string, read: boolean): Promise<void> => {
    return request<void>(`/briefs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ read }),
    })
  },

  /** POST /api/v1/briefs/:id/dismiss — soft-dismiss without marking read */
  dismiss: (id: string): Promise<void> => {
    return request<void>(`/briefs/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    })
  },

  /** POST /api/v1/briefs/:id/refine — async refinement; response arrives via SSE */
  refine: (id: string, instruction: string): Promise<{ job_id: string }> => {
    return request<{ job_id: string }>(`/briefs/${encodeURIComponent(id)}/refine`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    })
  },

  /**
   * GET /api/v1/briefs/:id/audio — fetch TTS audio for a brief.
   * Returns a Blob (audio/mpeg). Bypasses the `request()` wrapper because we
   * need the raw Response for Blob extraction (not JSON).
   * Throws HttpError on non-2xx (same semantics as request()).
   */
  audio: async (id: string): Promise<Blob> => {
    const path = `/briefs/${encodeURIComponent(id)}/audio`
    const url = `${getApiBase()}${path}`
    const response = await fetch(url, {
      headers: { 'X-Open-Brain-Caller': 'web-ui' },
    })
    if (!response.ok) {
      let body: unknown
      try {
        body = await response.text()
      } catch {
        body = null
      }
      throw new HttpError(response.status, body, path)
    }
    return response.blob()
  },
}
