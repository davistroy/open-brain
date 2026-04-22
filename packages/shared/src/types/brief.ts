import { z } from 'zod'

// ============================================================
// BriefKind — category of the brief
// Canonical 6-value set. Lockstep across:
//   - This TS union (source of truth)
//   - Zod: BriefKindSchema / BRIEF_KINDS
//   - DB CHECK: briefs_kind_check (migration 0030)
//   - Drizzle schema comment in packages/shared/src/schema/briefs.ts
//
// Semantics:
//   DAILY       — daily sweep summary (morning-brief, daily-sweep-skill)
//   WEEKLY      — weekly synthesis (weekly-brief)
//   DOSSIER     — on-demand entity/topic deep-dive
//   DECISION    — structured decision brief
//   PROJECT     — project-scoped brief
//   MONTHLY     — monthly reflection (monthly-reflection)
//
// Adding a value → update all surfaces in lockstep + pre-flight audit.
// ============================================================
export type BriefKind = 'DAILY' | 'WEEKLY' | 'DOSSIER' | 'DECISION' | 'PROJECT' | 'MONTHLY'

export const BRIEF_KINDS: readonly BriefKind[] = [
  'DAILY',
  'WEEKLY',
  'DOSSIER',
  'DECISION',
  'PROJECT',
  'MONTHLY',
] as const

export const BriefKindSchema = z.enum(['DAILY', 'WEEKLY', 'DOSSIER', 'DECISION', 'PROJECT', 'MONTHLY'])

// ============================================================
// BriefCover — visual cover theme rendered in the brief reader UI
// Canonical 6-value set. Lockstep across:
//   - This TS union (source of truth)
//   - Zod: BriefCoverSchema / BRIEF_COVERS
//   - DB CHECK: briefs_cover_check (migration 0030)
//   - Drizzle schema comment in packages/shared/src/schema/briefs.ts
//
// Adding a value → update all surfaces in lockstep.
// ============================================================
export type BriefCover = 'parchment' | 'evening' | 'sunrise' | 'gold' | 'canvas' | 'slate'

export const BRIEF_COVERS: readonly BriefCover[] = [
  'parchment',
  'evening',
  'sunrise',
  'gold',
  'canvas',
  'slate',
] as const

export const BriefCoverSchema = z.enum(['parchment', 'evening', 'sunrise', 'gold', 'canvas', 'slate'])

// ============================================================
// BriefSourceType — category of the original content source
// Canonical 4-value set. Lockstep across:
//   - This TS union (source of truth)
//   - Zod: BriefSourceTypeSchema / BRIEF_SOURCE_TYPES
//   - Web-next redeclaration: BriefSourceType in packages/web-next/lib/types.ts (drift-guard 4.5)
//
// Semantics:
//   EMAIL   — sourced from email captures
//   VOICE   — sourced from voice captures
//   MEETING — sourced from calendar/meeting captures (morning-brief skill)
//   NOTE    — sourced from all other capture types (api, mcp, slack, document, file, etc.)
//
// Adding a value → update all surfaces in lockstep.
// ============================================================
export type BriefSourceType = 'EMAIL' | 'VOICE' | 'MEETING' | 'NOTE'

export const BRIEF_SOURCE_TYPES: readonly BriefSourceType[] = [
  'EMAIL',
  'VOICE',
  'MEETING',
  'NOTE',
] as const

export const BriefSourceTypeSchema = z.enum(['EMAIL', 'VOICE', 'MEETING', 'NOTE'])

// ============================================================
// TocItem — table of contents entry extracted from body_html AST
// ============================================================
export interface TocItem {
  id: string       // anchor id matching the heading element
  text: string     // heading text content (stripped of HTML)
  level: number    // heading level: 1–6
}

export const TocItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  level: z.number().int().min(1).max(6),
})

// ============================================================
// BriefSource — reference to a capture or external item cited in a brief
// ============================================================
export interface BriefSource {
  type: BriefSourceType
  title: string
  excerpt?: string      // short quoted snippet from the source (max ~200 chars)
  capture_id?: string   // UUID — links to the originating capture row when available
}

export const BriefSourceSchema = z.object({
  type: BriefSourceTypeSchema,
  title: z.string(),
  excerpt: z.string().optional(),
  capture_id: z.string().uuid().optional(),
})

// ============================================================
// Brief — list-shape (returned by GET /api/v1/briefs)
// Does NOT include body_html, toc, sources — those are large and
// not needed for the library grid view.
// ============================================================
export interface Brief {
  id: string
  kind: BriefKind
  cover: BriefCover
  title: string
  subtitle?: string
  source_skill_log_id?: string
  refined_from_id?: string
  generated_at: string   // ISO 8601
  read_at?: string       // ISO 8601 — null means unread
  dismissed_at?: string  // ISO 8601 — null means visible
  created_at: string     // ISO 8601
  updated_at: string     // ISO 8601
}

export const BriefSchema = z.object({
  id: z.string().uuid(),
  kind: BriefKindSchema,
  cover: BriefCoverSchema,
  title: z.string(),
  subtitle: z.string().optional(),
  source_skill_log_id: z.string().uuid().optional(),
  refined_from_id: z.string().uuid().optional(),
  generated_at: z.string(),
  read_at: z.string().optional(),
  dismissed_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

// ============================================================
// BriefDetail — full-shape (returned by GET /api/v1/briefs/:id)
// Extends Brief with body_html, toc, sources, refine_options.
// ============================================================
export interface BriefDetail extends Brief {
  body_html: string
  toc: TocItem[]
  sources: BriefSource[]
  refine_options: string[]
}

export const BriefDetailSchema = BriefSchema.extend({
  body_html: z.string(),
  toc: z.array(TocItemSchema),
  sources: z.array(BriefSourceSchema),
  refine_options: z.array(z.string()),
})

// ============================================================
// SKILL_TO_BRIEF_KIND — maps skill name → BriefKind
// Used by brief-writing skills to set kind on the inserted brief row.
// ============================================================
export const SKILL_TO_BRIEF_KIND: Record<string, BriefKind> = {
  'weekly-brief': 'WEEKLY',
  'daily-sweep-skill': 'DAILY',
  'morning-brief': 'DAILY',
  'monthly-reflection': 'MONTHLY',
}

// ============================================================
// SKILL_TO_BRIEF_COVER — maps skill name → BriefCover
// Cover theme selected to match the emotional/temporal tone of each skill.
//   weekly-brief     → 'parchment' (classic, comprehensive)
//   daily-sweep-skill → 'evening'  (end-of-day reflection)
//   morning-brief    → 'sunrise'   (start of day)
//   monthly-reflection → 'gold'    (significant/milestone)
// ============================================================
export const SKILL_TO_BRIEF_COVER: Record<string, BriefCover> = {
  'weekly-brief': 'parchment',
  'daily-sweep-skill': 'evening',
  'morning-brief': 'sunrise',
  'monthly-reflection': 'gold',
}

// ============================================================
// REFINE_OPTIONS — preset refinement actions shown in the brief reader
// User picks one; the refine-brief skill applies it as a single-shot
// HTML transform (~3s, Option 2 async SSE delivery).
// ============================================================
export const REFINE_OPTIONS: readonly string[] = [
  'Shorter',
  'Longer',
  'More casual',
  'More formal',
  'Add action items',
  'Simplify language',
] as const

// ============================================================
// BRIEF_SOURCE_TYPE_MAP — maps captures.source → BriefSourceType
// Used by the unified renderer's source-mapping pass (Phase 5) to
// classify capture rows cited in a brief by their origin.
//
// Mapping rationale:
//   voice  → VOICE   (voice memos)
//   email  → EMAIL   (email captures via Cloudflare Email Worker)
//   calendar → MEETING (calendar events; not a current CaptureSource but
//               reserved for the morning-brief skill in Phase 6)
//   all others → NOTE (api, mcp, slack, document, file, consolidation, system)
// ============================================================
export const BRIEF_SOURCE_TYPE_MAP: Record<string, BriefSourceType> = {
  voice: 'VOICE',
  email: 'EMAIL',
  calendar: 'MEETING',
  // All remaining CaptureSource values fall through to NOTE:
  api: 'NOTE',
  mcp: 'NOTE',
  slack: 'NOTE',
  document: 'NOTE',
  file: 'NOTE',
  consolidation: 'NOTE',
  system: 'NOTE',
}

/**
 * Resolves a captures.source string to its BriefSourceType.
 * Unknown sources default to 'NOTE'.
 */
export function sourceToBriefSourceType(source: string): BriefSourceType {
  return BRIEF_SOURCE_TYPE_MAP[source] ?? 'NOTE'
}
