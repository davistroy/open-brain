export type CaptureType = 'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection';
export type CaptureSource = 'slack' | 'voice' | 'api' | 'document' | 'mcp' | 'email' | 'file' | 'consolidation' | 'system';
export type PipelineStatus = 'pending' | 'processing' | 'extracted' | 'embedded' | 'chunked' | 'complete' | 'failed' | 'deleted';
export type BrainView = 'career' | 'personal' | 'technical' | 'work-internal' | 'client';
export type EntityType = 'person' | 'project' | 'topic' | 'org' | 'decision' | 'concept' | 'place' | 'tool';
export type BriefKind = 'DAILY' | 'WEEKLY' | 'DOSSIER' | 'DECISION' | 'PROJECT' | 'MONTHLY';
export type CommitmentStatus = 'pending' | 'owed_by_user' | 'waiting_on' | 'resolved';

export interface Capture {
  id: string;
  content: string;
  created_at: string;
  capture_type: CaptureType;
  source: CaptureSource;
  pipeline_status: PipelineStatus;
  brain_view: BrainView;
  title?: string;
  snippet?: string;
  entities?: string[];
  source_metadata?: Record<string, unknown> | null;
}

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  mention_count: number;
  blurb?: string;
  last_seen?: string;
}

export interface EntityDetail extends Entity {
  first_seen_at: string;
  last_seen_at: string | null;
  canonical_name: string;
  aliases: string[];
  metadata: unknown;
  created_at: string;
  updated_at: string;
  linked_captures: Array<{
    id: string;
    content: string;
    capture_type: string;
    brain_view: string;
    relationship: string | null;
    confidence: number | null;
    created_at: string;
  }>;
  summary?: string;
}

export interface Brief {
  id: string;
  kind: BriefKind;
  title: string;
  subtitle: string;
  generated_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
}

export interface BriefDetail extends Brief {
  body_html: string;
  toc: Array<{ id: string; label: string }>;
  sources: Array<{ type: string; title: string; date: string }>;
  refine_options: string[];
}

export interface SearchResult {
  capture: Capture;
  score: number;
}

export interface BoardCommitment {
  id: string;
  capture_id: string;
  entity_id: string | null;
  entity_name: string | null;
  text: string;
  due_date: string | null;
  status: CommitmentStatus;
  resolved_at: string | null;
  created_at: string;
}

export interface ListEnvelope<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface VoiceCaptureResponse {
  ok: boolean;
  capture: { id: string; pipeline_status: string; created_at: string };
  transcription: { text: string; language: string; duration: number };
  classification: { template: string; confidence: number };
}
