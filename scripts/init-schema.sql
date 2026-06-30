-- ==============================================================================
-- scripts/init-schema.sql — GENERATED FILE. DO NOT EDIT BY HAND.
--
-- Regenerate with:  bash scripts/regenerate-init-schema.sh
-- Source of truth:  this file + packages/shared/drizzle/0*.sql, applied in order.
-- CI guard:         scripts/validate-init-schema.sh (two-DB pg_dump parity diff).
--
-- This is a 'pg_dump --schema-only' snapshot of init-schema + ALL migrations,
-- normalized (no \restrict token, no version comments) so it is byte-stable and
-- executable by node-postgres (integration setup.ts applies it via pool.query).
-- ==============================================================================
--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: file_upload_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.file_upload_status AS ENUM (
    'pending',
    'processing',
    'parsed',
    'failed'
);


--
-- Name: actr_temporal_score(double precision, timestamp with time zone, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.actr_temporal_score(base_score double precision, created_at timestamp with time zone, temporal_weight double precision DEFAULT 0.0) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  decay_rate    float := 0.01;
  hours_since   float;
  decay         float;
BEGIN
  -- Cold-start shortcut: temporal_weight = 0 → pure base_score
  IF temporal_weight = 0.0 THEN
    RETURN base_score;
  END IF;

  hours_since := GREATEST(
    EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0,
    0.0
  );

  decay := EXP(-decay_rate * SQRT(hours_since));

  RETURN base_score * decay * temporal_weight
       + base_score * (1.0 - temporal_weight);
END;
$$;


--
-- Name: fts_only_search(text, integer, text[], text[], timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fts_only_search(query_text text, match_count integer, filter_brain_views text[] DEFAULT NULL::text[], filter_capture_types text[] DEFAULT NULL::text[], filter_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, filter_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(capture_id uuid, rrf_score double precision, fts_score double precision, vector_score double precision)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    SELECT
      c.id AS capture_id,
      ts_rank_cd(
        c.content_tsvector,
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          c.content_tsvector,
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.deleted_at IS NULL
      AND c.content_tsvector @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  )
  SELECT
    fts_ranked.capture_id,
    (1.0 / (k + fts_ranked.fts_rank))::float AS rrf_score,
    fts_ranked.fts_score,
    0.0::float AS vector_score
  FROM fts_ranked
  ORDER BY fts_ranked.fts_score DESC
  LIMIT match_count;
END;
$$;


--
-- Name: fts_search(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fts_search(query_text text, match_limit integer DEFAULT 20) RETURNS TABLE(id uuid, content text, capture_type text, brain_view text, source text, tags text[], created_at timestamp with time zone, captured_at timestamp with time zone, rank real)
    LANGUAGE sql STABLE
    AS $$
  SELECT c.id, c.content, c.capture_type, c.brain_view, c.source, c.tags, c.created_at, c.captured_at,
    ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', query_text))::real AS rank
  FROM captures c
  WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text) AND c.deleted_at IS NULL
  ORDER BY rank DESC
  LIMIT match_limit;
$$;


--
-- Name: hybrid_search(text, public.vector, integer, double precision, double precision, text[], text[], timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search(query_text text, query_embedding public.vector, match_count integer, fts_weight double precision DEFAULT 1.0, vector_weight double precision DEFAULT 1.0, filter_brain_views text[] DEFAULT NULL::text[], filter_capture_types text[] DEFAULT NULL::text[], filter_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, filter_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(capture_id uuid, rrf_score double precision, fts_score double precision, vector_score double precision)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    SELECT
      c.id AS capture_id,
      ts_rank_cd(
        c.content_tsvector,
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          c.content_tsvector,
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND c.content_tsvector @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
    ORDER BY ts_rank_cd(
      c.content_tsvector,
      plainto_tsquery('english', query_text)
    ) DESC
    LIMIT match_count * 4   -- overquery: GIN+tsquery prunes first, LIMIT handles pathological common-term cases
  ),
  vector_ranked AS (
    SELECT
      c.id AS capture_id,
      (1.0 - (c.embedding <=> query_embedding))::float AS vector_score,
      ROW_NUMBER() OVER (
        ORDER BY c.embedding <=> query_embedding ASC
      ) AS vector_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
    ORDER BY c.embedding <=> query_embedding ASC  -- explicit ORDER required for HNSW push-down
    LIMIT match_count * 4                          -- overquery: gives HNSW scan an early-stop bound
  ),
  fused AS (
    SELECT
      COALESCE(f.capture_id, v.capture_id) AS capture_id,
      (
        COALESCE(fts_weight    * (1.0 / (k + COALESCE(f.fts_rank,    2147483647))), 0.0) +
        COALESCE(vector_weight * (1.0 / (k + COALESCE(v.vector_rank, 2147483647))), 0.0)
      )::float AS rrf_score,
      COALESCE(f.fts_score,    0.0)::float AS fts_score,
      COALESCE(v.vector_score, 0.0)::float AS vector_score
    FROM fts_ranked    f
    FULL OUTER JOIN vector_ranked v USING (capture_id)
  )
  SELECT
    fused.capture_id,
    fused.rrf_score,
    fused.fts_score,
    fused.vector_score
  FROM fused
  ORDER BY fused.rrf_score DESC
  LIMIT match_count;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: spreading_activation(uuid[], integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.spreading_activation(seed_capture_ids uuid[], max_hops integer DEFAULT 2, max_related integer DEFAULT 10) RETURNS TABLE(capture_id uuid, activation_score real, hop_count integer)
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
BEGIN
  RETURN QUERY

  WITH
  -- Step 1: Get entities linked to seed captures (with their confidence scores)
  seed_entities AS (
    SELECT DISTINCT
      el.entity_id,
      el.confidence
    FROM entity_links el
    WHERE el.capture_id = ANY(seed_capture_ids)
      AND el.confidence IS NOT NULL
      AND el.confidence > 0
  ),

  -- Hop 1: From seed entities, find other captures linked to those same entities.
  -- Join captures to exclude soft-deleted rows (SE-6).
  hop1 AS (
    SELECT
      el.capture_id AS cid,
      -- Score = SUM(seed_link_confidence * target_link_confidence) / 1
      SUM(
        COALESCE(se.confidence, 1.0) * COALESCE(el.confidence, 1.0)
      )::REAL AS score,
      1 AS hops
    FROM seed_entities se
    JOIN entity_links el ON el.entity_id = se.entity_id
    JOIN captures c ON c.id = el.capture_id AND c.deleted_at IS NULL
    WHERE el.capture_id <> ALL(seed_capture_ids)
    GROUP BY el.capture_id
  ),

  -- Hop 2 (only if max_hops >= 2):
  -- From seed entities, traverse entity_relationships to find related entities,
  -- then find captures linked to those related entities.
  -- Join captures to exclude soft-deleted rows (SE-6).
  hop2 AS (
    SELECT
      el.capture_id AS cid,
      -- Score = SUM(seed_confidence * relationship_weight * target_confidence) / 2
      SUM(
        COALESCE(se.confidence, 1.0)
        * COALESCE(er.weight, 1.0)
        * COALESCE(el.confidence, 1.0)
      )::REAL / 2.0 AS score,
      2 AS hops
    FROM seed_entities se
    -- Traverse entity_relationships in both directions (undirected graph)
    JOIN entity_relationships er
      ON er.entity_id_a = se.entity_id OR er.entity_id_b = se.entity_id
    -- Get the "other" entity in the relationship
    JOIN entity_links el
      ON el.entity_id = CASE
        WHEN er.entity_id_a = se.entity_id THEN er.entity_id_b
        ELSE er.entity_id_a
      END
    JOIN captures c ON c.id = el.capture_id AND c.deleted_at IS NULL
    WHERE max_hops >= 2
      -- Exclude seed captures
      AND el.capture_id <> ALL(seed_capture_ids)
      -- Exclude entities we already found directly (those are hop 1)
      AND el.entity_id NOT IN (SELECT entity_id FROM seed_entities)
    GROUP BY el.capture_id
  ),

  -- Combine hops, deduplicate: keep best score per capture, prefer lower hop count
  combined AS (
    SELECT cid, score, hops FROM hop1
    UNION ALL
    SELECT cid, score, hops FROM hop2
  ),

  ranked AS (
    SELECT
      c.cid,
      SUM(c.score)::REAL AS total_score,
      MIN(c.hops) AS min_hops
    FROM combined c
    GROUP BY c.cid
    ORDER BY total_score DESC
    LIMIT max_related
  )

  SELECT
    r.cid AS capture_id,
    r.total_score AS activation_score,
    r.min_hops AS hop_count
  FROM ranked r;
END;
$$;


--
-- Name: update_capture_embedding(uuid, public.vector); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_capture_embedding(capture_id uuid, embedding public.vector) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE captures
  SET
    embedding       = update_capture_embedding.embedding,
    pipeline_status = 'embedded',
    updated_at      = NOW()
  WHERE id = update_capture_embedding.capture_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'capture not found: %', capture_id;
  END IF;
END;
$$;


--
-- Name: vector_search(public.vector, integer, real); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vector_search(query_embedding public.vector, match_limit integer DEFAULT 20, similarity_threshold real DEFAULT 0.0) RETURNS TABLE(id uuid, content text, capture_type text, brain_view text, source text, tags text[], created_at timestamp with time zone, captured_at timestamp with time zone, similarity real)
    LANGUAGE sql STABLE
    AS $$
  SELECT c.id, c.content, c.capture_type, c.brain_view, c.source, c.tags, c.created_at, c.captured_at,
    (1 - (c.embedding <=> query_embedding))::real AS similarity
  FROM captures c
  WHERE c.embedding IS NOT NULL AND c.deleted_at IS NULL AND (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_limit;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_feed (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(32) NOT NULL,
    subtype character varying(64),
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    summary text NOT NULL,
    view character varying(32),
    detail jsonb,
    source_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type character varying(32) NOT NULL,
    actor text NOT NULL,
    confirmation_phrase text,
    tables_affected text[],
    outcome character varying(16) NOT NULL,
    error_detail text,
    backup_path text,
    origin text,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_type text NOT NULL,
    model text NOT NULL,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    duration_ms integer,
    capture_id uuid,
    session_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client_used character varying(32) DEFAULT 'litellm'::character varying,
    cost_usd numeric(10,6) DEFAULT NULL::numeric
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: backup_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    backup_type character varying(16) NOT NULL,
    file_path text,
    size_bytes bigint,
    duration_seconds integer,
    status character varying(16) NOT NULL,
    error text,
    pruned_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    statement text NOT NULL,
    confidence real NOT NULL,
    domain text,
    resolution_date timestamp with time zone,
    resolution text,
    resolution_notes text,
    session_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    cover text NOT NULL,
    title text NOT NULL,
    subtitle text,
    body_html text NOT NULL,
    toc jsonb DEFAULT '[]'::jsonb NOT NULL,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    refine_options jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_skill_log_id uuid,
    refined_from_id uuid,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT briefs_cover_check CHECK ((cover = ANY (ARRAY['parchment'::text, 'evening'::text, 'sunrise'::text, 'gold'::text, 'canvas'::text, 'slate'::text]))),
    CONSTRAINT briefs_kind_check CHECK ((kind = ANY (ARRAY['DAILY'::text, 'WEEKLY'::text, 'DOSSIER'::text, 'DECISION'::text, 'PROJECT'::text, 'MONTHLY'::text])))
);


--
-- Name: capture_associations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capture_associations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    capture_id_a uuid NOT NULL,
    capture_id_b uuid NOT NULL,
    co_access_count integer DEFAULT 1 NOT NULL,
    weight real DEFAULT 1.0 NOT NULL,
    last_co_access timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capture_assoc_ordering CHECK ((capture_id_a < capture_id_b))
);


--
-- Name: captures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.captures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    capture_type text NOT NULL,
    brain_view text NOT NULL,
    source text NOT NULL,
    source_metadata jsonb,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    embedding public.vector(768),
    pipeline_status text DEFAULT 'pending'::text NOT NULL,
    pipeline_attempts integer DEFAULT 0 NOT NULL,
    pipeline_error text,
    pipeline_completed_at timestamp with time zone,
    pre_extracted jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    access_count integer DEFAULT 0 NOT NULL,
    last_accessed_at timestamp with time zone,
    content_tsvector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    CONSTRAINT captures_capture_type_check CHECK ((capture_type = ANY (ARRAY['decision'::text, 'idea'::text, 'observation'::text, 'task'::text, 'win'::text, 'blocker'::text, 'question'::text, 'reflection'::text]))),
    CONSTRAINT captures_pipeline_status_check CHECK ((pipeline_status = ANY (ARRAY['pending'::text, 'processing'::text, 'extracted'::text, 'embedded'::text, 'chunked'::text, 'complete'::text, 'failed'::text, 'deleted'::text]))),
    CONSTRAINT captures_source_check CHECK ((source = ANY (ARRAY['slack'::text, 'voice'::text, 'api'::text, 'document'::text, 'mcp'::text, 'email'::text, 'file'::text, 'consolidation'::text, 'system'::text])))
);


--
-- Name: commitments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commitments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    capture_id uuid NOT NULL,
    entity_id uuid,
    text text NOT NULL,
    due_date date,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commitments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'owed_by_user'::text, 'waiting_on'::text, 'resolved'::text])))
);


--
-- Name: container_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.container_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    container_name character varying(64) NOT NULL,
    healthy boolean NOT NULL,
    response_ms integer,
    error text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_classifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id text NOT NULL,
    provider text NOT NULL,
    sender text NOT NULL,
    subject text,
    category text NOT NULL,
    confidence numeric(3,2),
    tier text NOT NULL,
    folder_id text,
    moved boolean DEFAULT false,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id text NOT NULL,
    provider text NOT NULL,
    old_category text NOT NULL,
    new_category text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_daily_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_daily_summaries (
    date text NOT NULL,
    email_count integer NOT NULL,
    categories jsonb,
    summary_text text,
    posted_to_brain boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    to_address text NOT NULL,
    cc_address text,
    subject text NOT NULL,
    body text NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    send_mode character varying(20) DEFAULT 'review-required'::character varying NOT NULL,
    source character varying(32),
    approved_at timestamp with time zone,
    sent_at timestamp with time zone,
    himalaya_message_id character varying(256),
    capture_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    entity_type text NOT NULL,
    canonical_name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    relationship text,
    confidence real,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entity_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id_a uuid NOT NULL,
    entity_id_b uuid NOT NULL,
    co_occurrence_count integer DEFAULT 1 NOT NULL,
    weight real DEFAULT 1.0 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: file_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filename text NOT NULL,
    size_bytes bigint NOT NULL,
    mime_type text,
    source_type text NOT NULL,
    parser_hint text,
    destination_path text NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    status public.file_upload_status DEFAULT 'pending'::public.file_upload_status NOT NULL,
    capture_ids uuid[] DEFAULT '{}'::uuid[],
    error_message text,
    processed_at timestamp with time zone,
    duration_ms integer
);


--
-- Name: insurance_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insurance_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_number text,
    provider text NOT NULL,
    policy_type text NOT NULL,
    effective_date date,
    expiration_date date,
    insured_name text,
    coverage jsonb NOT NULL,
    raw_text text,
    source_file text,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT insurance_policies_policy_type_check CHECK ((policy_type = ANY (ARRAY['health'::text, 'auto'::text, 'home'::text, 'umbrella'::text])))
);


--
-- Name: lab_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id text NOT NULL,
    source_file text NOT NULL,
    layout text NOT NULL,
    collection_date date NOT NULL,
    ordering_provider text,
    test_name text NOT NULL,
    test_code text,
    raw_value text NOT NULL,
    numeric_value double precision,
    units text,
    ref_range_text text,
    ref_low double precision,
    ref_high double precision,
    ref_comparator text,
    lab_flag text,
    derived_flag text,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    client_id character varying(64),
    tool_name character varying(64) NOT NULL,
    parameters jsonb,
    result_summary text,
    duration_ms integer,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pipeline_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    capture_id uuid NOT NULL,
    stage text NOT NULL,
    status text NOT NULL,
    duration_ms integer,
    error text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipeline_events_stage_check CHECK ((stage = ANY (ARRAY['classify'::text, 'check_triggers'::text, 'document-chunk'::text, 'document-embed'::text, 'document-parse'::text, 'embed'::text, 'extract'::text, 'extract_commitments'::text, 'extract_entities'::text, 'link_entities'::text, 'notify'::text, 'received'::text]))),
    CONSTRAINT pipeline_events_status_check CHECK ((status = ANY (ARRAY['started'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: session_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_type text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    config jsonb,
    context_capture_ids text[] DEFAULT '{}'::text[] NOT NULL,
    summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sessions_session_type_check CHECK ((session_type = ANY (ARRAY['governance'::text, 'review'::text, 'planning'::text]))),
    CONSTRAINT sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'complete'::text, 'abandoned'::text])))
);


--
-- Name: skills_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skills_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    skill_name text NOT NULL,
    capture_id uuid,
    session_id uuid,
    input_summary text,
    output_summary text,
    result jsonb,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    condition_text text NOT NULL,
    embedding public.vector(768),
    threshold real DEFAULT 0.8 NOT NULL,
    action text NOT NULL,
    action_config jsonb,
    enabled boolean DEFAULT true NOT NULL,
    last_triggered_at timestamp with time zone,
    trigger_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: voice_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_key character varying(64) NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    duration_seconds integer,
    turn_count integer DEFAULT 0,
    transcript jsonb DEFAULT '[]'::jsonb,
    summary text,
    captures_created uuid[] DEFAULT '{}'::uuid[],
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activity_feed activity_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_pkey PRIMARY KEY (id);


--
-- Name: admin_audit admin_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT admin_audit_pkey PRIMARY KEY (id);


--
-- Name: ai_audit_log ai_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_audit_log
    ADD CONSTRAINT ai_audit_log_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: backup_log backup_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_log
    ADD CONSTRAINT backup_log_pkey PRIMARY KEY (id);


--
-- Name: bets bets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bets
    ADD CONSTRAINT bets_pkey PRIMARY KEY (id);


--
-- Name: briefs briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_pkey PRIMARY KEY (id);


--
-- Name: capture_associations capture_associations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capture_associations
    ADD CONSTRAINT capture_associations_pkey PRIMARY KEY (id);


--
-- Name: captures captures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.captures
    ADD CONSTRAINT captures_pkey PRIMARY KEY (id);


--
-- Name: commitments commitments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commitments
    ADD CONSTRAINT commitments_pkey PRIMARY KEY (id);


--
-- Name: container_health container_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.container_health
    ADD CONSTRAINT container_health_pkey PRIMARY KEY (id);


--
-- Name: email_classifications email_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_classifications
    ADD CONSTRAINT email_classifications_pkey PRIMARY KEY (id);


--
-- Name: email_corrections email_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_corrections
    ADD CONSTRAINT email_corrections_pkey PRIMARY KEY (id);


--
-- Name: email_daily_summaries email_daily_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_daily_summaries
    ADD CONSTRAINT email_daily_summaries_pkey PRIMARY KEY (date);


--
-- Name: email_drafts email_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_drafts
    ADD CONSTRAINT email_drafts_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_links entity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_pkey PRIMARY KEY (id);


--
-- Name: entity_relationships entity_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_pkey PRIMARY KEY (id);


--
-- Name: file_uploads file_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_pkey PRIMARY KEY (id);


--
-- Name: insurance_policies insurance_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance_policies
    ADD CONSTRAINT insurance_policies_pkey PRIMARY KEY (id);


--
-- Name: lab_results lab_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_pkey PRIMARY KEY (id);


--
-- Name: lab_results lab_results_report_id_test_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_report_id_test_name_key UNIQUE (report_id, test_name);


--
-- Name: mcp_activity mcp_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_activity
    ADD CONSTRAINT mcp_activity_pkey PRIMARY KEY (id);


--
-- Name: pipeline_events pipeline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_events
    ADD CONSTRAINT pipeline_events_pkey PRIMARY KEY (id);


--
-- Name: session_messages session_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_messages
    ADD CONSTRAINT session_messages_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: skills_log skills_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills_log
    ADD CONSTRAINT skills_log_pkey PRIMARY KEY (id);


--
-- Name: triggers triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggers
    ADD CONSTRAINT triggers_pkey PRIMARY KEY (id);


--
-- Name: voice_sessions voice_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_pkey PRIMARY KEY (id);


--
-- Name: voice_sessions voice_sessions_session_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_session_key_key UNIQUE (session_key);


--
-- Name: activity_feed_timestamp_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_feed_timestamp_desc_idx ON public.activity_feed USING btree ("timestamp" DESC);


--
-- Name: activity_feed_type_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_feed_type_timestamp_idx ON public.activity_feed USING btree (type, "timestamp" DESC);


--
-- Name: activity_feed_view_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_feed_view_timestamp_idx ON public.activity_feed USING btree (view, "timestamp" DESC) WHERE (view IS NOT NULL);


--
-- Name: admin_audit_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_actor_idx ON public.admin_audit USING btree (actor);


--
-- Name: admin_audit_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_created_at_idx ON public.admin_audit USING btree (created_at);


--
-- Name: admin_audit_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_event_type_idx ON public.admin_audit USING btree (event_type);


--
-- Name: ai_audit_log_capture_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_audit_log_capture_id_idx ON public.ai_audit_log USING btree (capture_id);


--
-- Name: ai_audit_log_client_used_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_audit_log_client_used_idx ON public.ai_audit_log USING btree (client_used);


--
-- Name: ai_audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_audit_log_created_at_idx ON public.ai_audit_log USING btree (created_at);


--
-- Name: ai_audit_log_task_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_audit_log_task_type_idx ON public.ai_audit_log USING btree (task_type);


--
-- Name: backup_log_timestamp_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_log_timestamp_desc_idx ON public.backup_log USING btree ("timestamp" DESC);


--
-- Name: backup_log_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_log_type_idx ON public.backup_log USING btree (backup_type);


--
-- Name: bets_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bets_domain_idx ON public.bets USING btree (domain);


--
-- Name: bets_resolution_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bets_resolution_date_idx ON public.bets USING btree (resolution_date);


--
-- Name: bets_resolution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bets_resolution_idx ON public.bets USING btree (resolution);


--
-- Name: briefs_generated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefs_generated_at_idx ON public.briefs USING btree (generated_at DESC);


--
-- Name: briefs_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefs_kind_idx ON public.briefs USING btree (kind);


--
-- Name: briefs_refined_from_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefs_refined_from_id_idx ON public.briefs USING btree (refined_from_id) WHERE (refined_from_id IS NOT NULL);


--
-- Name: briefs_source_skill_log_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX briefs_source_skill_log_id_idx ON public.briefs USING btree (source_skill_log_id) WHERE (source_skill_log_id IS NOT NULL);


--
-- Name: briefs_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefs_unread_idx ON public.briefs USING btree (generated_at DESC) WHERE ((read_at IS NULL) AND (dismissed_at IS NULL));


--
-- Name: capture_associations_capture_id_a_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capture_associations_capture_id_a_idx ON public.capture_associations USING btree (capture_id_a);


--
-- Name: capture_associations_capture_id_b_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capture_associations_capture_id_b_idx ON public.capture_associations USING btree (capture_id_b);


--
-- Name: capture_associations_last_co_access_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capture_associations_last_co_access_idx ON public.capture_associations USING btree (last_co_access);


--
-- Name: capture_associations_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX capture_associations_pair_idx ON public.capture_associations USING btree (capture_id_a, capture_id_b);


--
-- Name: captures_brain_view_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_brain_view_idx ON public.captures USING btree (brain_view);


--
-- Name: captures_capture_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_capture_type_idx ON public.captures USING btree (capture_type);


--
-- Name: captures_content_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX captures_content_hash_idx ON public.captures USING btree (content_hash) WHERE (deleted_at IS NULL);


--
-- Name: captures_content_tsvector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_content_tsvector_idx ON public.captures USING gin (content_tsvector);


--
-- Name: captures_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_created_at_idx ON public.captures USING btree (created_at);


--
-- Name: captures_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_deleted_at_idx ON public.captures USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: captures_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_embedding_hnsw_idx ON public.captures USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: captures_pipeline_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_pipeline_status_idx ON public.captures USING btree (pipeline_status);


--
-- Name: captures_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX captures_source_idx ON public.captures USING btree (source);


--
-- Name: commitments_capture_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commitments_capture_id_idx ON public.commitments USING btree (capture_id);


--
-- Name: commitments_entity_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commitments_entity_status_idx ON public.commitments USING btree (entity_id, status);


--
-- Name: commitments_status_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commitments_status_due_date_idx ON public.commitments USING btree (status, due_date);


--
-- Name: container_health_name_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX container_health_name_timestamp_idx ON public.container_health USING btree (container_name, "timestamp" DESC);


--
-- Name: container_health_timestamp_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX container_health_timestamp_desc_idx ON public.container_health USING btree ("timestamp" DESC);


--
-- Name: container_health_unhealthy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX container_health_unhealthy_idx ON public.container_health USING btree (container_name, "timestamp" DESC) WHERE (healthy = false);


--
-- Name: ec_category_processed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ec_category_processed_idx ON public.email_classifications USING btree (category, processed_at);


--
-- Name: ec_processed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ec_processed_at_idx ON public.email_classifications USING btree (processed_at);


--
-- Name: ec_provider_message_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ec_provider_message_uniq ON public.email_classifications USING btree (provider, message_id);


--
-- Name: email_drafts_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_drafts_created_at_idx ON public.email_drafts USING btree (created_at DESC);


--
-- Name: email_drafts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_drafts_status_idx ON public.email_drafts USING btree (status);


--
-- Name: entities_canonical_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_canonical_name_idx ON public.entities USING btree (canonical_name);


--
-- Name: entities_entity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_entity_type_idx ON public.entities USING btree (entity_type);


--
-- Name: entities_entity_type_lower_canonical_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_entity_type_lower_canonical_idx ON public.entities USING btree (entity_type, lower(canonical_name));


--
-- Name: entities_entity_type_lower_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_entity_type_lower_name_idx ON public.entities USING btree (entity_type, lower(name));


--
-- Name: entities_name_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entities_name_type_idx ON public.entities USING btree (name, entity_type);


--
-- Name: entity_links_capture_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_links_capture_id_idx ON public.entity_links USING btree (capture_id);


--
-- Name: entity_links_entity_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_links_entity_capture_idx ON public.entity_links USING btree (entity_id, capture_id);


--
-- Name: entity_links_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_links_entity_id_idx ON public.entity_links USING btree (entity_id);


--
-- Name: entity_relationships_entity_id_a_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_relationships_entity_id_a_idx ON public.entity_relationships USING btree (entity_id_a);


--
-- Name: entity_relationships_entity_id_b_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_relationships_entity_id_b_idx ON public.entity_relationships USING btree (entity_id_b);


--
-- Name: entity_relationships_last_seen_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_relationships_last_seen_at_idx ON public.entity_relationships USING btree (last_seen_at);


--
-- Name: entity_relationships_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_relationships_pair_idx ON public.entity_relationships USING btree (entity_id_a, entity_id_b);


--
-- Name: idx_file_uploads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_uploads_status ON public.file_uploads USING btree (status) WHERE (status = ANY (ARRAY['pending'::public.file_upload_status, 'processing'::public.file_upload_status]));


--
-- Name: idx_file_uploads_uploaded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_uploads_uploaded_at ON public.file_uploads USING btree (uploaded_at DESC);


--
-- Name: idx_lab_results_collection_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_results_collection_date ON public.lab_results USING btree (collection_date DESC);


--
-- Name: idx_lab_results_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_results_report_id ON public.lab_results USING btree (report_id);


--
-- Name: idx_lab_results_test_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lab_results_test_name ON public.lab_results USING btree (test_name);


--
-- Name: insurance_policies_effective_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insurance_policies_effective_date_idx ON public.insurance_policies USING btree (effective_date);


--
-- Name: insurance_policies_policy_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insurance_policies_policy_type_idx ON public.insurance_policies USING btree (policy_type);


--
-- Name: insurance_policies_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insurance_policies_provider_idx ON public.insurance_policies USING btree (provider);


--
-- Name: insurance_policies_source_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX insurance_policies_source_file_idx ON public.insurance_policies USING btree (source_file) WHERE (source_file IS NOT NULL);


--
-- Name: mcp_activity_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_activity_timestamp_idx ON public.mcp_activity USING btree ("timestamp" DESC);


--
-- Name: mcp_activity_tool_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_activity_tool_name_idx ON public.mcp_activity USING btree (tool_name);


--
-- Name: pipeline_events_capture_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipeline_events_capture_id_idx ON public.pipeline_events USING btree (capture_id);


--
-- Name: pipeline_events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipeline_events_created_at_idx ON public.pipeline_events USING btree (created_at);


--
-- Name: pipeline_events_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipeline_events_stage_idx ON public.pipeline_events USING btree (stage);


--
-- Name: session_messages_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_messages_created_at_idx ON public.session_messages USING btree (created_at);


--
-- Name: session_messages_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_messages_session_id_idx ON public.session_messages USING btree (session_id);


--
-- Name: sessions_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_created_at_idx ON public.sessions USING btree (created_at);


--
-- Name: sessions_session_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_session_type_idx ON public.sessions USING btree (session_type);


--
-- Name: sessions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_status_idx ON public.sessions USING btree (status);


--
-- Name: skills_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX skills_log_created_at_idx ON public.skills_log USING btree (created_at);


--
-- Name: skills_log_skill_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX skills_log_skill_name_idx ON public.skills_log USING btree (skill_name);


--
-- Name: triggers_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX triggers_embedding_hnsw_idx ON public.triggers USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: triggers_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX triggers_enabled_idx ON public.triggers USING btree (enabled);


--
-- Name: triggers_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX triggers_name_idx ON public.triggers USING btree (name);


--
-- Name: voice_sessions_started_at_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_sessions_started_at_desc_idx ON public.voice_sessions USING btree (started_at DESC);


--
-- Name: bets set_bets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_bets_updated_at BEFORE UPDATE ON public.bets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: briefs set_briefs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_briefs_updated_at BEFORE UPDATE ON public.briefs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: captures set_captures_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_captures_updated_at BEFORE UPDATE ON public.captures FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: email_drafts set_email_drafts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_email_drafts_updated_at BEFORE UPDATE ON public.email_drafts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: entities set_entities_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_entities_updated_at BEFORE UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sessions set_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_sessions_updated_at BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: triggers set_triggers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_triggers_updated_at BEFORE UPDATE ON public.triggers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ai_audit_log ai_audit_log_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_audit_log
    ADD CONSTRAINT ai_audit_log_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;


--
-- Name: bets bets_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bets
    ADD CONSTRAINT bets_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: briefs briefs_refined_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_refined_from_id_fkey FOREIGN KEY (refined_from_id) REFERENCES public.briefs(id);


--
-- Name: briefs briefs_source_skill_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefs
    ADD CONSTRAINT briefs_source_skill_log_id_fkey FOREIGN KEY (source_skill_log_id) REFERENCES public.skills_log(id);


--
-- Name: capture_associations capture_associations_capture_id_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capture_associations
    ADD CONSTRAINT capture_associations_capture_id_a_fkey FOREIGN KEY (capture_id_a) REFERENCES public.captures(id) ON DELETE CASCADE;


--
-- Name: capture_associations capture_associations_capture_id_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capture_associations
    ADD CONSTRAINT capture_associations_capture_id_b_fkey FOREIGN KEY (capture_id_b) REFERENCES public.captures(id) ON DELETE CASCADE;


--
-- Name: commitments commitments_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commitments
    ADD CONSTRAINT commitments_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE CASCADE;


--
-- Name: commitments commitments_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commitments
    ADD CONSTRAINT commitments_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE SET NULL;


--
-- Name: email_drafts email_drafts_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_drafts
    ADD CONSTRAINT email_drafts_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;


--
-- Name: entity_links entity_links_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE CASCADE;


--
-- Name: entity_links entity_links_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_links
    ADD CONSTRAINT entity_links_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_entity_id_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_entity_id_a_fkey FOREIGN KEY (entity_id_a) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_entity_id_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_entity_id_b_fkey FOREIGN KEY (entity_id_b) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: pipeline_events pipeline_events_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_events
    ADD CONSTRAINT pipeline_events_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE CASCADE;


--
-- Name: session_messages session_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_messages
    ADD CONSTRAINT session_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: skills_log skills_log_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills_log
    ADD CONSTRAINT skills_log_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;


--
-- Name: skills_log skills_log_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills_log
    ADD CONSTRAINT skills_log_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


