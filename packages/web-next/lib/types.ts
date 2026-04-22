/**
 * UI display types for the Open Brain web-next package.
 *
 * These are shaped to match the real core-api response envelopes.
 * DB/domain types live in @open-brain/shared — these are the UI-layer
 * representations consumed by the 5 M1 screens.
 *
 * M2 wiring note: swap mock-data imports for real API fetches; these
 * interfaces remain unchanged as long as the API contract holds.
 */

// ---------------------------------------------------------------------------
// Enumerations — mirror the canonical values in @open-brain/shared
// ---------------------------------------------------------------------------

/** `captures.capture_type` — 8 values */
export type CaptureType =
  | 'decision'
  | 'idea'
  | 'observation'
  | 'task'
  | 'win'
  | 'blocker'
  | 'question'
  | 'reflection';

/** `captures.source` — 9 values */
export type CaptureSource =
  | 'slack'
  | 'voice'
  | 'api'
  | 'document'
  | 'mcp'
  | 'email'
  | 'file'
  | 'consolidation'
  | 'system';

/** `captures.pipeline_status` — 8 values */
export type PipelineStatus =
  | 'pending'
  | 'processing'
  | 'extracted'
  | 'embedded'
  | 'chunked'
  | 'complete'
  | 'failed'
  | 'deleted';

/** `captures.brain_view` — 5 values */
export type BrainView =
  | 'career'
  | 'personal'
  | 'technical'
  | 'work-internal'
  | 'client';

/** Entity type values used by the UI */
export type EntityType = 'person' | 'project' | 'topic' | 'org' | 'decision' | 'concept' | 'place' | 'tool';

/** Brief kind values from skills_log — mirrors BriefKind in @open-brain/shared */
export type BriefKind = 'DAILY' | 'WEEKLY' | 'DOSSIER' | 'DECISION' | 'PROJECT' | 'MONTHLY';

/** Cover theme for brief cards — mirrors BriefCover in @open-brain/shared */
export type BriefCover = 'parchment' | 'evening' | 'sunrise' | 'gold' | 'canvas' | 'slate';

/** Source type for brief source entries — mirrors BriefSourceType in @open-brain/shared */
export type BriefSourceType = 'EMAIL' | 'VOICE' | 'MEETING' | 'NOTE';

// ---------------------------------------------------------------------------
// Core capture type — mirrors GET /api/v1/captures item shape
// ---------------------------------------------------------------------------

/**
 * Source-specific metadata stored in `captures.source_metadata` (JSONB).
 * Shape varies by source — only voice/slack are guaranteed to have audio fields.
 * All fields are optional since older captures may not have metadata.
 */
export interface CaptureSourceMetadata {
  /** Signed or absolute URL to the original audio file (voice, slack audio). */
  audio_url?: string;
  /** Duration of the audio recording in seconds. */
  duration?: number;
  /** Transcription pipeline status: 'pending' | 'processing' | 'complete' | 'failed' */
  transcription_status?: string;
  /** AI-generated summary of the capture content. */
  summary?: string;
  /** Device or client that produced the capture (e.g. 'iPhone', 'Watch'). */
  device?: string;
  /** Location name associated with the capture (voice captures). */
  location_name?: string;
  /** Latitude for geo-tagged voice captures. */
  latitude?: number;
  /** Longitude for geo-tagged voice captures. */
  longitude?: number;
  /** Location accuracy in metres. */
  location_accuracy?: number;
  /** Slack channel or thread identifier for slack-sourced captures. */
  slack_channel?: string;
  /** Original filename for document/file captures. */
  filename?: string;
  /** MIME type for file captures. */
  mime_type?: string;
  /** Allow arbitrary additional fields from the JSONB column. */
  [key: string]: unknown;
}

/**
 * Capture as returned by `GET /api/v1/captures` list endpoint.
 * The search endpoint wraps these in `{ results: [{ capture, score }] }`.
 */
export interface Capture {
  id: string;
  content: string;
  created_at: string;          // ISO 8601
  capture_type: CaptureType;
  source: CaptureSource;
  pipeline_status: PipelineStatus;
  brain_view: BrainView;
  /** Display title derived from content or explicit field */
  title?: string;
  /** Short excerpt for list views */
  snippet?: string;
  /** Entity names co-mentioned in this capture */
  entities?: string[];
  /** Source-specific metadata (JSONB). Present on detail fetches; may be absent on list responses. */
  source_metadata?: CaptureSourceMetadata | null;
}

/**
 * Search result envelope from `GET /api/v1/search`.
 * `{ results: SearchResult[] }`
 */
export interface SearchResult {
  capture: Capture;
  score: number;
}

// ---------------------------------------------------------------------------
// Entity types — mirrors GET /api/v1/entities item shape
// ---------------------------------------------------------------------------

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  mention_count: number;
  /** Short descriptive blurb */
  blurb?: string;
  /** ISO date string or human-relative string */
  last_seen?: string;
  /** Trend indicator from UI prototype */
  trend?: '▲' | '▼' | '◆';
  /** Related entity names for pill display */
  related?: string[];
}

/** Entity detail — full record for entity detail page */
export interface EntityDetail extends Entity {
  first_seen: string;
  co_mentioned_count: number;
  sentiment: string;
  summary: string;
  summary_updated_at: string;
  captures: CaptureItem[];
  commitments: Commitment[];
  related_entities: RelatedEntity[];
}

// ---------------------------------------------------------------------------
// Entity detail sub-types
// ---------------------------------------------------------------------------

/** A capture displayed inline on the entity detail page */
export interface CaptureItem {
  id: string;
  source: string;          // display label e.g. "EMAIL", "VOICE", "MEETING"
  time: string;            // display string e.g. "APR 21 · 16:48"
  title: string;
  snippet: string;
}

/** An active commitment extracted from captures */
export interface Commitment {
  who: string;             // e.g. "Sarah owes you", "You owe Sarah"
  what: string;
  due: string;
  state: 'pending' | 'overdue' | 'blocked';
}

/** A related entity shown in the relationship graph / sidebar list */
export interface RelatedEntity {
  id: string;
  name: string;
  entity_type: EntityType;
  shared_count: number;
}

// ---------------------------------------------------------------------------
// Brief types — mirrors skills_log result JSONB shape
// ---------------------------------------------------------------------------

/** Brief card / list row — mirrors briefs table columns from core-api */
export interface Brief {
  id: string;
  kind: BriefKind;
  cover: BriefCover;
  title: string;
  subtitle: string;
  source_skill_log_id: string | null;
  refined_from_id: string | null;
  generated_at: string;          // ISO 8601
  read_at: string | null;        // ISO 8601 or null
  dismissed_at: string | null;   // ISO 8601 or null
  created_at: string;
  updated_at: string;
}

/** Full brief detail with reader content */
export interface BriefDetail extends Brief {
  eyebrow: string;          // e.g. "DAILY BRIEF · TUESDAY, APRIL 21 · 07:00"
  headline: string;         // h1 text
  meta: string;             // "Drafted from N captures over M hours · X min read · Generated..."
  body_html: string;        // Pre-rendered HTML for the .reader prose block
  toc: TocItem[];
  sources: BriefSource[];
  source_total: number;
  refine_options: string[];
}

/** TOC entry for the brief reader left sticky */
export interface TocItem {
  id: string;
  label: string;
  active?: boolean;
}

/** Source capture entry in the right sidebar */
export interface BriefSource {
  type: BriefSourceType;    // display label e.g. "EMAIL", "VOICE", "MEETING", "NOTE"
  title: string;
  date: string;    // display string e.g. "Apr 21"
}

// ---------------------------------------------------------------------------
// Dashboard types
// ---------------------------------------------------------------------------

/** Dashboard stat strip block */
export interface StatBlock {
  label: string;
  value: string;
  delta?: string;
  delta_tone?: 'success' | 'error';
  meta?: string;
}

/** Dashboard stats aggregate */
export interface DashboardStats {
  captures_7d: number;
  captures_7d_delta: string;
  captures_7d_meta: string;
  active_entities: number;
  active_entities_delta: string;
  active_entities_meta: string;
  open_questions: number;
  open_questions_delta: string;
  open_questions_meta: string;
  briefs_in_progress: number;
  briefs_due_meta: string;
  pipeline_status: 'healthy' | 'degraded' | 'unhealthy';
  pipeline_active: number;
  pipeline_queued: number;
  llm_spend_usd: number;
  capture_total: number;
  entity_total: number;
}

/** Open question for the dashboard right column */
export interface OpenQuestion {
  id: string;
  question: string;
  due: string;
  priority: 'high' | 'med' | 'low';
  context: string;
}

/** Upcoming brief for the dashboard progress list */
export interface UpcomingBrief {
  id: string;
  title: string;
  progress: number;    // 0–100
  due: string;
  source_count: number;
}

// ---------------------------------------------------------------------------
// Timeline types
// ---------------------------------------------------------------------------

/** Timeline entry — capture enriched for chronological display */
export interface TimelineEntry {
  id: string;
  date: string;        // ISO 8601 or display group header
  capture_type: CaptureType;
  source: CaptureSource;
  title: string;
  snippet: string;
  entities: string[];
  pipeline_status: PipelineStatus;
  brain_view: BrainView;
}

// ---------------------------------------------------------------------------
// Entity distribution (Entities page sidebar)
// ---------------------------------------------------------------------------

export interface EntityDistribution {
  label: string;
  count: number;
  tone: string;    // CSS color value
}

export interface NeedsAttentionItem {
  label: string;
  desc: string;
}

// ---------------------------------------------------------------------------
// Entity detail — mentions timeline
// ---------------------------------------------------------------------------

/** A single bucket from GET /api/v1/entities/:id/mentions-timeline */
export interface MentionsTimelineBucket {
  /** ISO 8601 date string for the start of the bucket period */
  period: string;
  count: number;
}

/** Response envelope from the mentions-timeline endpoint */
export interface MentionsTimelineResponse {
  buckets: MentionsTimelineBucket[];
  window: string;   // e.g. "90d"
  bucket: string;   // e.g. "week"
}

/** Response from POST /api/v1/entities/:id/ask */
export interface AskEntityResponse {
  answer: string;
  sources: Array<{ id: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Settings types — Settings page (M3, screen 11)
// ---------------------------------------------------------------------------

/**
 * A single app_settings entry returned by GET /api/v1/settings/:key.
 * `value` is JSONB and can be any JSON-serializable shape.
 */
export interface SettingEntry {
  key: string;
  value: unknown;
  updated_at: string | null;
}

/**
 * Health status of a connected integration.
 * Mirrors the values returned by GET /api/v1/config/integrations.
 */
export type IntegrationStatus = 'healthy' | 'degraded' | 'error' | 'unknown';

/** A connected integration as shown in the Settings → Sources section. */
export interface Integration {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  /** ISO 8601 timestamp of last successful data ingest — may be null */
  last_seen: string | null;
}

// ---------------------------------------------------------------------------
// Commitment types — Board Kanban (M3, screen 09)
// ---------------------------------------------------------------------------

/**
 * `commitments.status` — 4 values matching the Board's 4 columns.
 * Canonical enum from migration 0031.
 */
export type CommitmentStatus = 'pending' | 'owed_by_user' | 'waiting_on' | 'resolved';

/** Commitment as returned by GET /api/v1/commitments list endpoint. */
export interface BoardCommitment {
  id: string;
  capture_id: string;
  entity_id: string | null;
  /** Entity name resolved from entity_id — may be null if no entity linked */
  entity_name: string | null;
  text: string;
  due_date: string | null;     // ISO date e.g. "2026-04-30", or null
  status: CommitmentStatus;
  resolved_at: string | null;  // ISO 8601 or null
  created_at: string;
}
