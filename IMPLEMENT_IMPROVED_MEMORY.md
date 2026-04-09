# Implementation Plan: Cognitive Memory Features

**Source:** Shodh Memory evaluation — porting Hebbian learning, spreading activation, and memory consolidation concepts into Open Brain's existing Postgres/TypeScript stack.

**Date:** 2026-04-09
**Status:** Planning

---

## Overview

Three neuroscience-inspired memory features adapted from Shodh's cognitive architecture, implemented natively in Open Brain without adding external dependencies:

1. **Hebbian Learning** — Captures accessed together form strengthening associations
2. **Spreading Activation** — Entity graph traversal surfaces related captures during search
3. **Memory Consolidation** — Scheduled skill merges near-duplicate captures via LLM

All three build on existing infrastructure: `access_count`/`last_accessed_at` columns, `entity_links`/`entity_relationships` tables, BullMQ skills framework, and the hybrid search pipeline.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Association table unbounded growth | Medium | Pruning job (90-day stale + low weight). Top-10 pairing limit per search. |
| Spreading activation too slow on dense graphs | Medium | Fan-out limits in SQL function: max_hops=2, max_related=10. Benchmark. |
| Over-merging in consolidation | High | Conservative threshold (0.92), min cluster size 3, LLM safety valve, soft-delete for recovery. |
| LLM loses nuance during merge | Medium | Prompt: "never drop unique information". Output includes merge_rationale for audit. |
| Filter bubbles from Hebbian boost | Low | Boost is multiplicative 10% max, not dominant. Decay on association weights prevents lock-in. |
| Migration breaks existing system | Low | All changes additive (new table, new function, new optional params). No existing behavior modified by default. |

---

## Phase 1: Hebbian Learning

**Goal:** Captures co-accessed in search sessions form associations that strengthen over time and provide a ranking boost.

**Depends on:** Nothing (foundation phase)

### Work Item 1.1: Database Migration — capture_associations table

**Files Created:**
- `packages/shared/drizzle/0011_capture_associations.sql`

**Description:**
New table tracking capture-to-capture associations built from co-access patterns. Uses canonical pair ordering (same pattern as `entity_relationships`).

**Schema:**
```sql
CREATE TABLE capture_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id_a UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  capture_id_b UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  co_access_count INTEGER NOT NULL DEFAULT 1,
  weight REAL NOT NULL DEFAULT 1.0,
  last_co_access TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT capture_assoc_ordering CHECK (capture_id_a < capture_id_b),
  CONSTRAINT capture_assoc_unique UNIQUE (capture_id_a, capture_id_b)
);
```

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Migration applies cleanly on fresh and existing databases
- [x] CASCADE delete works (deleting a capture removes its associations)
- [x] Canonical ordering constraint prevents duplicate pairs

---

### Work Item 1.2: Drizzle Schema — captureAssociations

**Files Modified:**
- `packages/shared/src/schema/supporting.ts`

**Description:**
Add `captureAssociations` table definition matching migration 0011. Export from schema index.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Schema matches SQL migration exactly
- [x] TypeScript types correctly inferred

---

### Work Item 1.3: Co-access Tracking in update-access-stats Worker

**Files Modified:**
- `packages/workers/src/jobs/update-access-stats.ts`

**Description:**
After incrementing `access_count` for returned capture IDs, generate all pairs from the top 10 results and upsert into `capture_associations`. Weight formula: Hebbian with time decay.

```
weight = co_access_count * exp(-0.005 * hours_since_last_co_access)
```

Only pair the top 10 results per search (avoids N^2 explosion). Uses `INSERT ON CONFLICT DO UPDATE`.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] After a search returning captures A, B, C — associations A-B, A-C, B-C are created/strengthened
- [x] Weight increases with repeated co-access
- [x] Canonical ordering maintained (smaller UUID first)
- [x] No performance regression on access-stats processing

---

### Work Item 1.4: Association Boost in Search Scoring

**Files Modified:**
- `packages/core-api/src/services/search.ts`

**Description:**
Add optional `recentCaptureIds` parameter to `SearchOptions`. After ACT-R temporal decay scoring, look up `capture_associations` for results that share associations with recently accessed captures. Apply small multiplicative boost: `score * (1 + 0.1 * normalized_weight)`.

Default: no boost when `recentCaptureIds` is empty (cold-start safe). Association weight is normalized to [0,1] range.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Search results unchanged when `recentCaptureIds` is empty (backward compatible)
- [x] Associated captures receive a small but measurable score boost
- [x] Boost is bounded (max 10% increase)
- [x] No performance regression on search latency

---

### Work Item 1.5: Association Pruning

**Files Modified:**
- `packages/workers/src/jobs/update-access-stats.ts` (add pruning function)

**Description:**
Add a pruning function called periodically (piggyback on access-stats processing or daily-sweep). Deletes associations where `weight < 0.1 AND last_co_access < NOW() - INTERVAL '90 days'`.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Stale, low-weight associations are cleaned up
- [x] Active associations are preserved
- [x] Pruning runs without blocking normal access-stats processing

---

## Phase 2: Spreading Activation

**Goal:** Search results are enriched with related captures found by traversing the entity graph 1-2 hops from top results.

**Depends on:** Nothing (uses existing entity_links + entity_relationships). Benefits from Phase 1 weights but works independently.

### Work Item 2.1: SQL Function — spreading_activation

**Files Created:**
- `packages/shared/drizzle/0012_spreading_activation.sql`

**Description:**
Postgres function that takes seed capture IDs and traverses entity_links + entity_relationships to find related captures.

Algorithm:
1. From seed captures → get linked entity IDs via entity_links
2. From those entities → find other captures via entity_links (excluding seeds)
3. Score by: `SUM(entity_link.confidence * COALESCE(entity_relationship.weight, 1.0)) / hop_count`
4. Deduplicate, rank by activation_score, return top N

Parameters: `seed_capture_ids UUID[]`, `max_hops INT DEFAULT 2`, `max_related INT DEFAULT 10`
Returns: `TABLE(capture_id UUID, activation_score REAL, hop_count INT)`

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Returns related captures connected by shared entities
- [x] Excludes seed captures from results
- [x] Performance < 50ms for typical graphs
- [x] Respects max_related limit

---

### Work Item 2.2: Search Service Extension — findRelatedCaptures

**Files Modified:**
- `packages/core-api/src/services/search.ts`

**Description:**
Add `findRelatedCaptures(seedCaptureIds: string[], limit?: number)` method to SearchService. Calls the `spreading_activation` SQL function, fetches full capture records, applies ACT-R decay, returns as `SearchResult[]`.

Add `include_related` option to `SearchOptions`. When true, automatically calls `findRelatedCaptures` with top 5 result IDs after primary search.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Related captures are found via entity graph traversal
- [x] Primary search results are unchanged (spreading is additive)
- [x] Default behavior unchanged (include_related defaults to false)

---

### Work Item 2.3: Search API Response Extension

**Files Modified:**
- `packages/core-api/src/routes/search.ts`

**Description:**
Add optional `include_related` query parameter (GET) and body field (POST). When true, response includes `related_results: SearchResult[]` alongside existing `results`. Backward compatible — field absent when not requested.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Existing API consumers unaffected
- [x] `include_related=true` returns related captures in response
- [x] Related results are clearly separate from primary results

---

### Work Item 2.4: MCP search_brain Tool Update

**Files Modified:**
- `packages/core-api/src/mcp/tools/search-brain.ts`

**Description:**
After primary search results, run spreading activation on top 5 results. Append "Related captures:" section to tool response text. Add `include_related` parameter to schema (default true for MCP — AI agents benefit from broader context).

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] MCP search results include related captures section
- [x] Related captures clearly labeled and separated from primary results
- [x] Can be disabled via parameter

---

## Phase 3: Memory Consolidation

**Goal:** Scheduled weekly skill identifies clusters of near-duplicate captures, merges them via LLM, and soft-deletes originals.

**Depends on:** Phase 1 (must handle capture_associations re-pointing) and Phase 2 (entity_links must be migrated for spreading to work post-consolidation).

### Work Item 3.1: Consolidation Query Module

**Files Created:**
- `packages/workers/src/skills/memory-consolidation-query.ts`

**Description:**
Find candidate clusters for consolidation:
1. Query capture pairs with cosine similarity > 0.92 (both complete, not deleted)
2. Build clusters using union-find algorithm in JS
3. Filter: only clusters with 3+ captures
4. Return top 5 clusters (LLM budget constraint)

Types exported: `ConsolidationCluster`, `ConsolidationQueryResult`

**Acceptance Criteria:**
- [ ] Identifies clusters of semantically similar captures
- [ ] Respects minimum cluster size (3)
- [ ] Limits to top 5 clusters per run
- [ ] Excludes already-deleted captures

---

### Work Item 3.2: Prompt Template

**Files Created:**
- `config/prompts/memory_consolidation_v1.txt`

**Description:**
LLM prompt for merging a cluster of captures into a single consolidated capture:
- Merge preserving all distinct facts, decisions, insights
- Remove redundancy but never drop unique information
- Preserve original dates as inline references
- Output JSON: `{ should_merge: boolean, merged_content: string, merged_tags: string[], merge_rationale: string }`
- Set `should_merge: false` if captures are about fundamentally different topics

**Acceptance Criteria:**
- [ ] Template renders correctly with TemplateCache
- [ ] LLM output is parseable JSON
- [ ] Safety valve (should_merge: false) works when captures are too different

---

### Work Item 3.3: Consolidation Skill Implementation

**Files Created:**
- `packages/workers/src/skills/memory-consolidation.ts`

**Description:**
Following weekly-brief skill pattern:
1. Query candidate clusters (3.1)
2. For each cluster (up to 5):
   a. Load full capture content
   b. Render consolidation prompt template
   c. Call LLM (synthesis model, temp 0.2, max_completion_tokens 2048)
   d. Parse response — check should_merge safety valve
   e. Create new capture via POST /api/v1/captures with source='consolidation'
   f. Migrate entity_links from originals to new capture (ON CONFLICT DO NOTHING)
   g. Re-point capture_associations to new capture ID (merge weights on conflict)
   h. Soft-delete originals (SET deleted_at = NOW())
3. Log to skills_log with result JSONB
4. Send Pushover notification with summary

**Acceptance Criteria:**
- [ ] Clusters are merged into consolidated captures
- [ ] LLM safety valve (should_merge: false) is respected
- [ ] Entity links migrated to consolidated capture
- [ ] Capture associations re-pointed
- [ ] Originals soft-deleted (recoverable)
- [ ] skills_log records full details
- [ ] Pushover notification sent

---

### Work Item 3.4: Scheduler + Dispatcher Registration

**Files Modified:**
- `packages/workers/src/scheduler.ts`
- `packages/workers/src/jobs/skill-execution.ts`
- `packages/core-api/src/services/skill-config.ts` (DEFAULT_SKILLS)

**Description:**
- Register `memory-consolidation` repeatable job: cron `0 4 * * 0` (4 AM Sundays)
- Add case to skill-execution.ts switch statement
- Add to DEFAULT_SKILLS in skill-config.ts

**Acceptance Criteria:**
- [ ] Skill appears in GET /api/v1/skills
- [ ] Skill can be manually triggered via POST /api/v1/skills/memory-consolidation/trigger
- [ ] Repeatable job registered on scheduler startup
- [ ] Schedule editable via PATCH /api/v1/skills/memory-consolidation

---

## Implementation Sequence

```
Phase 1 (Hebbian)          Phase 2 (Spreading)
  1.1 migration              2.1 SQL function
  1.2 schema                 2.2 search extension
  1.3 co-access tracking     2.3 API update
  1.4 search boost           2.4 MCP update
  1.5 pruning
        \                      /
         \                    /
          v                  v
        Phase 3 (Consolidation)
          3.1 query module
          3.2 prompt template
          3.3 skill implementation
          3.4 scheduler + dispatcher
```

Phases 1 and 2 can be developed in parallel. Phase 3 must come after both.

---

## Scope Boundaries

**In scope:**
- Capture-to-capture Hebbian associations via co-access tracking
- Entity-graph spreading activation for search enrichment
- LLM-powered memory consolidation as a scheduled skill
- All necessary migrations, schema updates, scheduler/dispatcher registration

**Out of scope:**
- Web UI changes for displaying related results
- Proactive memory surfacing (push notifications)
- Cross-session learning (web UI view tracking)
- Forgetting/archival beyond consolidation
- Changes to embedding model or vector dimensions
- Shodh binary integration

**Follow-up work:**
- Web UI "Related captures" component
- Dashboard association graph visualization
- Parameter tuning based on real usage data
- Consolidation report included in weekly brief
