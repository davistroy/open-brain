# Implementation Plan

**Generated:** 2026-04-11 14:00:00
**Based On:** docs/PRD-UNIFIED.md (v1.1 Unified), Ultra Plan Phase 1-4 analysis, codebase reconnaissance (4 parallel investigations)
**Total Phases:** 8
**Estimated Total Effort:** ~8,500 LOC across ~95 files

---

## Executive Summary

This plan transforms Open Brain from a production v1.5.0 capture-and-search system into the full v2 knowledge operating system described in PRD-UNIFIED.md. The work spans three major arcs: (1) model routing and pipeline modernization that reduces LLM costs 30-60% while adding local inference, (2) a persistent wiki layer backed by Gitea that implements the Karpathy pattern -- knowledge compounds rather than re-derives, and (3) the OneDrive file migration that transforms 10,000+ unorganized files into a structured, queryable knowledge base.

A critical finding from codebase reconnaissance is that the codebase is substantially ahead of PRD-UNIFIED's "Planned" labels. Migrations go to 0017, 15 MCP tools exist, `runAgent()` is production-ready, FlowProducer DAGs exist behind a feature flag, all 7 infrastructure skills exist as code files, WikiGitService + routes + MCP tools are implemented, HimalayaService + email drafts work, and voice-pipecat is deployed. The true greenfield work is limited to: Ollama integration, OneDrive migration tooling (rclone/SQLite/Python extraction), and 2 small skills. Most phases are about **wiring, stabilizing, and filling UI gaps** -- not building from scratch.

The implementation sequence follows the PRD-UNIFIED ordering: v2 stabilization first (Phases 1-2), then wiki infrastructure (Phase 3), file migration (Phases 5-6), intelligence completion (Phase 4), and finally voice/email/polish (Phases 7-8). Phases 1 and 2 can run in parallel. Phases 7 and 8 are independent of the wiki/file migration chain.

---

## Plan Overview

The phasing groups related changes into coherent sets that share code paths, state, or dependencies. Items that must ship together are in the same phase (e.g., Ollama client + tier config + gateway dispatch in Phase 2). The critical path runs Phase 1 → Phase 3 → Phase 5 → Phase 6 (pipeline stabilization → wiki infra → file migration → wiki construction). Phases 4, 7, and 8 can be executed on independent timelines once their stated dependencies are met.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Pipeline & Infrastructure Foundation | FlowProducer DAGs enabled, trace IDs, all infra skills scheduled | M (~15 files, ~800 LOC) | None |
| 2 | Three-Tier Model Routing | Ollama container, tier config, fallback chains, validation suite | L (~12 files, ~1,200 LOC) | None |
| 3 | Wiki Infrastructure | Gitea repo, wiki config, worker wiring, Wiki.tsx browser | M (~10 files, ~900 LOC) | Phase 1 |
| 4 | Slack Auto-Response Completion | 5-signal confidence scorer, DM mode, interactive buttons, threaded replies | M (~6 files, ~600 LOC) | Phase 2 |
| 5 | OneDrive File Migration | rclone sync, Python extraction, inventory, dedup, categorization | L (~14 files, ~1,500 LOC) | Phases 2, 3 |
| 6 | Wiki Construction | Batch orchestration, pilot ingestion, full 10K file processing | M (~5 files, ~400 LOC) | Phases 3, 5 |
| 7 | Voice & Email Completion | Pipecat promotion, VoiceConversations.tsx, email.yaml, Email.tsx | M (~12 files, ~1,200 LOC) | None |
| 8 | Dashboard & Settings Polish | System.tsx sub-tabs, Settings.tsx expansion, verification pass | M (~6 files, ~700 LOC) | Phases 1, 2, 3 |

<!-- BEGIN PHASES -->

---

## Phase 1: Pipeline & Infrastructure Foundation

**Estimated Complexity:** M (~15 files, ~800 LOC)
**Dependencies:** None
**Parallelizable:** Yes - work items 1.1-1.2 (pipeline) independent of 1.3-1.6 (infra skills)

### Goals

- Promote FlowProducer DAG pipeline from feature flag to default, with wiki-ingest as a flow child
- Add lightweight trace IDs for cross-stage pipeline correlation
- Wire all existing infrastructure skills to the BullMQ scheduler with production cron schedules
- Create two new infrastructure skills (secret rotation, dedup sweep) and implement backup retention

### Work Items

#### 1.1 Enable FlowProducer DAG Pipeline
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §4.4 (Data Flow), v2-F3 (Pipeline modernization)
**Files Affected:**
- `docker-compose.yml` (modify) -- add `PIPELINE_USE_FLOWS=true` to workers env
- `packages/workers/src/main.ts` (modify) -- remove feature flag conditional, flows become default
- `packages/workers/src/flows/ingest-pipeline.ts` (modify) -- add wiki-ingest as non-critical child
- `packages/workers/src/jobs/ingestion-worker.ts` (modify) -- flowProducer now required, legacy path removed
- `packages/workers/src/jobs/embed-capture.ts` (modify) -- legacy queue-bridging removed, signature simplified

**Description:**
The FlowProducer DAG already exists behind the `PIPELINE_USE_FLOWS` feature flag. The ingest-root parent spawns embed-capture and extract-entities as parallel children, then runs link-entities inline after both complete, then fires check-triggers. This item promotes that path to default and adds wiki-ingest as an additional non-critical child that fires after entity linking, conditional on `WIKI_REPO_URL` being set.

**Tasks:**
1. [x] Set `PIPELINE_USE_FLOWS=true` in workers environment in `docker-compose.yml`
2. [x] Remove the conditional check in `main.ts` that gates FlowProducer behind the env var -- make flows the only code path
3. [x] Add `wiki-ingest` job as a non-critical child in `ingest-pipeline.ts` with `removeDependencyOnFailure: true`, gated on `process.env.WIKI_REPO_URL` being truthy
4. [x] Verify the legacy queue-bridging code path is unreachable and remove dead code
5. [x] Run full test suite to confirm no regressions

**Acceptance Criteria:**
- [x] Capture flows through embed + extract in parallel, link-entities after both, then check-triggers + wiki-ingest fire
- [x] When WIKI_REPO_URL is unset, wiki-ingest child is not added to the flow (no errors)
- [x] All existing 1,569 unit tests pass (826 workers tests pass)
- [ ] Pipeline processes a test capture end-to-end in production docker-compose

**Notes:**
wiki-ingest child follows the same non-critical pattern as extract-entities (removeDependencyOnFailure). If wiki-ingest fails, the capture still completes normally.

---

#### 1.2 Add Pipeline Trace IDs
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §18.3 (v2-F3.10 lightweight OTel trace IDs)
**Files Affected:**
- `packages/core-api/src/services/capture-service.ts` (modify) -- generate trace UUID on capture creation
- `packages/workers/src/jobs/ingestion-worker.ts` (modify) -- propagate trace ID to child jobs
- `packages/workers/src/jobs/embed-capture.ts` (modify) -- include trace ID in pipeline_events
- `packages/workers/src/jobs/extract-entities.ts` (modify) -- include trace ID in pipeline_events

**Description:**
Add a lightweight trace ID (UUID v4) to capture metadata at creation time. This ID propagates through all pipeline stages via BullMQ job data and is included in every pipeline_events row, enabling cross-stage correlation in logs and the dashboard without requiring an OTel collector.

**Tasks:**
1. [ ] Generate `trace_id` (UUID v4) in `capture-service.ts` when creating a capture, store in `metadata.trace_id`
2. [ ] Pass `trace_id` through FlowProducer job data to all child jobs
3. [ ] Include `trace_id` in every `pipeline_events` insert across embed, extract, link, check-triggers workers
4. [ ] Add `trace_id` to structured log output (pino) for grep-ability

**Acceptance Criteria:**
- [ ] Every pipeline_events row for a capture shares the same trace_id
- [ ] Trace ID visible in structured JSON logs
- [ ] No performance regression on capture creation

**Notes:**
This is NOT full OpenTelemetry. No collector, no spans, no propagation headers. Just a UUID that ties pipeline stages together.

---

#### 1.3 Register Infrastructure Skills in Scheduler
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §18.8 (v2-F14, Infrastructure Skills Detail)
**Files Affected:**
- `packages/workers/src/scheduler.ts` (modify) -- register 6 new cron entries

**Description:**
All 7 infrastructure skill files already exist in `packages/workers/src/skills/`. Pipeline-health is already registered. This item wires the remaining 6 skills to the BullMQ repeatable job scheduler with the cron schedules specified in PRD-UNIFIED §18.8.

**Tasks:**
1. [ ] Register `db-backup` with cron `0 2 * * *` (daily 2 AM)
2. [ ] Register `wiki-backup` with cron `0 15 2 * * *` (daily 2:15 AM)
3. [ ] Register `redis-snapshot` with cron `0 30 2 * * *` (daily 2:30 AM)
4. [ ] Register `cost-analysis` with cron `0 7 * * *` (daily 7 AM)
5. [ ] Register `storage-audit` with cron `0 3 * * 0` (weekly Sunday 3 AM)
6. [ ] Register `container-health` with cron `*/15 * * * *` (every 15 min)

**Acceptance Criteria:**
- [ ] All 6 skills appear in `GET /api/v1/skills` with correct cron schedules
- [ ] Each skill fires when manually triggered via `POST /api/v1/skills/:name/trigger` and logs to skills_log
- [ ] Workers container starts cleanly with all repeatable jobs registered

**Notes:**
JSDoc comments for cron expressions must not contain `*/` sequences (tsup --dts parser issue). Use expanded forms like `0,15,30,45` instead of `*/15` in comments only.

---

#### 1.4 Create Secret Rotation Reminder Skill
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §18.8 (v2-F14.8, Secret Rotation Reminder)
**Files Affected:**
- `packages/workers/src/skills/secret-rotation.ts` (create)
- `packages/workers/src/jobs/skill-execution.ts` (modify) -- add dispatch case
- `packages/workers/src/scheduler.ts` (modify) -- register cron

**Description:**
Monthly skill that queries API key ages via the `bws` CLI (Bitwarden Secrets Manager) and sends a Pushover alert if any key is older than 90 days. Follows the existing skill pattern (extends BaseSkill, returns SkillResult).

**Tasks:**
1. [ ] Create `secret-rotation.ts` implementing the skill pattern: exec `bws secret list`, parse JSON output, check `revisionDate` on each secret, alert if age > 90 days
2. [ ] Register in scheduler with cron `0 10 1 * *` (monthly 1st, 10 AM)
3. [ ] Add dispatch case in skill-execution worker
4. [ ] Write unit tests (mock bws CLI output, test age calculation, test alert threshold)

**Acceptance Criteria:**
- [ ] Skill executes successfully via manual trigger
- [ ] Alerts fire for secrets older than 90 days (testable with mock)
- [ ] Logs output to skills_log with secret names and ages (no secret values)

**Notes:**
The `bws` CLI is at `~/bin/bws.exe`. It reads `BWS_ACCESS_TOKEN` from env automatically. The workers container needs access to this binary -- either mount it or install in Dockerfile.

---

#### 1.5 Create Capture Dedup Sweep Skill
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §18.8 (v2-F14.9, Capture Deduplication Sweep)
**Files Affected:**
- `packages/workers/src/skills/capture-dedup-sweep.ts` (create)
- `packages/workers/src/jobs/skill-execution.ts` (modify) -- add dispatch case
- `packages/workers/src/scheduler.ts` (modify) -- register cron

**Description:**
Weekly skill that scans for near-duplicate captures (cosine similarity > 0.95) not caught by real-time dedup. Flags pairs for review in the dashboard -- does NOT auto-merge (that's memory consolidation at 0.92 threshold). Uses SQL with pgvector `<=>` operator for efficient similarity comparison.

**Tasks:**
1. [ ] Create `capture-dedup-sweep.ts`: query pairs with `1 - (embedding <=> embedding) > 0.95`, exclude already-consolidated captures (source != 'consolidation'), limit to 100 pairs per run
2. [ ] Log flagged pairs to skills_log with capture IDs, similarity scores, and content previews
3. [ ] Send Pushover summary if duplicates found (count + top 3 examples)
4. [ ] Register in scheduler with cron `0 4 * * 6` (weekly Saturday 4 AM)
5. [ ] Write unit tests (mock DB results, test similarity threshold, test exclusion filter)

**Acceptance Criteria:**
- [ ] Skill detects intentionally duplicated test captures with cosine > 0.95
- [ ] Does NOT flag captures with cosine between 0.92 and 0.95 (that's memory consolidation's domain)
- [ ] Flagged pairs appear in skills_log with actionable information

**Notes:**
Supplements memory consolidation (0.92 threshold, auto-merge). This skill uses a higher threshold (0.95) and only flags -- human reviews. The two skills run on different schedules (consolidation: Sunday 4 AM, dedup sweep: Saturday 4 AM).

---

#### 1.6 Implement Backup Retention Policies
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §18.8 (v2-F14.1-F14.3, standardized retention)
**Files Affected:**
- `packages/workers/src/skills/db-backup.ts` (modify) -- add retention logic
- `packages/workers/src/skills/wiki-backup.ts` (modify) -- add retention logic
- `packages/workers/src/skills/redis-snapshot.ts` (modify) -- add retention logic

**Description:**
Implement standardized backup retention across all three backup skills: keep 7 daily, 4 weekly, 3 monthly backups. Auto-prune old backups after each successful run. Log prune counts to backup_log table (pruned_count column already exists in migration 0015).

**Tasks:**
1. [ ] Create shared `pruneBackups(directory, retentionPolicy)` utility function that implements 7/4/3 retention
2. [ ] Integrate into db-backup.ts: after successful pg_dump, prune old backups, log pruned_count
3. [ ] Integrate into wiki-backup.ts: after successful git bundle, prune old bundles
4. [ ] Integrate into redis-snapshot.ts: after successful BGSAVE copy, prune old RDB files
5. [ ] Write unit tests for retention logic (mock filesystem, verify correct files kept/pruned)

**Acceptance Criteria:**
- [ ] After 10 daily backups, only 7 most recent remain
- [ ] Weekly backups (Monday) are preserved for 4 weeks
- [ ] Monthly backups (1st of month) are preserved for 3 months
- [ ] pruned_count logged to backup_log for each run

**Notes:**
Backup directories: `/mnt/backups/open-brain/` (db), `/mnt/backups/open-brain-wiki/` (wiki), `/mnt/backups/open-brain-redis/` (redis). These are on the Unraid array, not the Docker volume.

---

### Phase 1 Testing Requirements

- [ ] FlowProducer pipeline processes captures end-to-end (embed + extract parallel, link, triggers, wiki-ingest)
- [ ] Trace IDs propagate through all pipeline stages and appear in pipeline_events
- [ ] All 6 infrastructure skills fire on schedule and log to skills_log
- [ ] Secret rotation correctly identifies old keys (mock test)
- [ ] Dedup sweep detects near-duplicates above 0.95 threshold
- [ ] Backup retention correctly prunes old files
- [ ] All existing 1,569+ unit tests pass
- [ ] All new code has >80% test coverage

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Docker-compose updated and deployed to homeserver
- [ ] Infrastructure skills verified in production (manual trigger each)
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 2: Three-Tier Model Routing

**Estimated Complexity:** L (~12 files, ~1,200 LOC)
**Dependencies:** None (can run parallel with Phase 1)
**Parallelizable:** Yes - items 2.1-2.2 (config) independent of 2.4 (docker). Item 2.3 depends on 2.1+2.2.

### Goals

- Add Ollama as T0 local inference provider for classification tasks (free, on-device)
- Implement three-tier fallback routing (T0 Ollama → T1 Haiku → T2 Sonnet)
- Restructure ai-routing.yaml to declarative tier + task routing config
- Validate T0 classification quality before production cutover

### Work Items

#### 2.1 Create Ollama Client Factory and Config Types
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §7.2-7.3 (Three-Tier Model Hierarchy), v2-F4.1-F4.2
**Files Affected:**
- `packages/shared/src/services/ollama-client.ts` (create)
- `packages/shared/src/types/config.ts` (modify) -- extend AIClientType, add tier types
- `packages/shared/src/index.ts` (modify) -- export new factory

**Description:**
Create `createOllamaClient(baseUrl)` factory that returns an OpenAI SDK client pointed at Ollama's OpenAI-compatible `/v1` endpoint. Ollama exposes `/v1/chat/completions` with the same interface as OpenAI, so we reuse the existing OpenAI SDK. Also extend the config type system with `ModelTierConfig`, `TaskRoutingConfig`, and `AIClientType = 'anthropic' | 'litellm' | 'ollama'`.

**Tasks:**
1. [x] Create `ollama-client.ts` with `createOllamaClient(baseUrl?: string)` returning `OpenAI` client configured for Ollama (default base: `http://ollama:11434/v1`)
2. [x] Add null check pattern matching `createLiteLLMClient()` (returns null if OLLAMA_URL is empty)
3. [x] Extend `AIClientType` union in `config.ts` to include `'ollama'`
4. [x] Add `ModelTierConfig` type: `{ provider: AIClientType, model: string, base_url?: string, max_completion_tokens: number, timeout_ms: number, fallback: string | null }`
5. [x] Add `TaskRoutingConfig` type: `Record<string, string>` mapping task names to tier keys
6. [x] Export from shared package index
7. [x] Write unit tests for factory (null when no URL, returns OpenAI instance when URL set)

**Acceptance Criteria:**
- [x] `createOllamaClient()` returns OpenAI SDK client when OLLAMA_URL is set
- [x] Returns null when OLLAMA_URL is empty (same pattern as createLiteLLMClient)
- [x] TypeScript types compile cleanly
- [x] Shared package builds successfully

**Notes:**
Ollama's OpenAI compatibility layer means we don't need a custom client library. The OpenAI SDK handles everything. Key difference: no API key needed for local Ollama.

---

#### 2.2 Restructure ai-routing.yaml
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §7.8 (Config Structure Target)
**Files Affected:**
- `config/ai-routing.yaml` (modify) -- restructure to three-tier format
- `packages/shared/src/types/config.ts` (modify) -- add ModelTierEntrySchema, ModelTiersConfigSchema, TaskRoutingConfigSchema, TaskName type; extend AIConfigSchema
- `packages/shared/src/config/loader.ts` (modify) -- add getModelTier(), getTaskTier(), getTaskTierKey(), getTaskRouting(), hasThreeTierRouting() methods
- `packages/shared/src/config/__tests__/loader.test.ts` (modify) -- 16 new tests for three-tier routing

**Description:**
Transform ai-routing.yaml from the current flat `models:` map to the target three-tier structure with `model_tiers` and `task_routing` sections. Maintain backward compatibility by keeping the existing `models:` section for any code that hasn't been updated yet. Update ConfigService to parse both old and new formats.

**Tasks:**
1. [x] Add `model_tiers` section with t0_local (Gemma 4 12B q4_K_M, Ollama, 256 max tokens, 10s timeout, fallback t1_fast), t1_fast (Haiku 4.5, Anthropic, 4096 tokens, 20s timeout, fallback t2_quality), t2_quality (Sonnet 4.6, Anthropic, 8192 tokens, 30s timeout, no fallback)
2. [x] Add `task_routing` section mapping all 19 tasks to tiers per PRD §7.4 (17 original + wiki_ingest + wiki_synthesis)
3. [x] Keep existing `models:` section with `fast`, `synthesis`, `governance`, `intent`, `conversation` aliases pointing to Claude models (backward compat during migration)
4. [x] Update `monthly_budget` to soft $20 / hard $35
5. [x] Update ConfigService to parse `model_tiers` and `task_routing`, expose via `getModelTier(tierKey)` and `getTaskTier(taskName)` methods (plus getTaskTierKey, getTaskRouting, hasThreeTierRouting)
6. [x] Write tests for ConfigService parsing both old and new format (16 new tests)

**Acceptance Criteria:**
- [x] ConfigService correctly parses the new three-tier config
- [x] `getTaskTier('intent_classification')` returns `t0_local` config
- [x] Existing `get('ai').models['fast']` still works (backward compat)
- [x] Budget thresholds updated to soft $20 / hard $35

**Notes:**
DeepSeek placeholder is commented out in config (ready for future addition per PRD C13 resolution). The backward-compat `models:` section will be removed in a future cleanup after all call sites are migrated.

---

#### 2.3 Extend LLMGateway for Three-Way Dispatch
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §7.3 (runAgent), §7.5 (Fallback Chains)
**Files Affected:**
- `packages/core-api/src/services/llm-gateway.ts` (modify) -- extend resolveClient for three-way dispatch
- `packages/workers/src/main.ts` (modify) -- initialize Ollama client at startup

**Description:**
Extend `LLMGatewayService.resolveClient()` to support three-way dispatch: Ollama, Anthropic, and LiteLLM/OpenAI. When a task is routed to a tier, try the primary provider. On failure (429, 500, timeout), automatically fall back to the next tier (max 2 hops). Log all fallback events to `ai_audit_log` with `client_used` reflecting the actual provider used.

**Tasks:**
1. [x] Add `resolveByTask(taskName: string)` method that looks up tier via `task_routing`, resolves provider from `model_tiers`, and returns the appropriate client + model
2. [x] Implement fallback chain: on error, look up `fallback` tier and retry. Max 2 hops (T0→T1→T2). Fallback triggers within 5 seconds of primary timeout.
3. [x] Add `client_used: 'ollama'` support in ai_audit_log inserts
4. [x] Initialize Ollama client in `workers/src/main.ts` alongside existing Anthropic + LiteLLM clients
5. [x] Update skill-execution worker to use `resolveByTask()` for task-specific routing
6. [x] Write tests for fallback chain (mock timeouts, verify retry with next tier, verify max 2 hops)

**Acceptance Criteria:**
- [x] T0 classification tasks route to Ollama when available
- [x] On Ollama timeout, automatically falls back to T1 (Haiku)
- [x] On T1 failure, falls back to T2 (Sonnet)
- [x] Fallback events logged to ai_audit_log with correct client_used
- [x] No fallback loops (max 2 hops enforced)
- [x] All existing LLM call sites continue working (backward compat via models map)

**Notes:**
The existing `complete()` method that uses model aliases continues working via the backward-compat `models:` map. New code should use `resolveByTask()` for tier-aware routing. Migration of existing call sites to task-based routing can happen incrementally.

---

#### 2.4 Add Ollama Container to Docker Compose
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §4.2 (Target Architecture), §4.3 (Container Memory Allocations)
**Files Affected:**
- `docker-compose.yml` (modify) -- add ollama service
- `scripts/setup-ollama.sh` (create) -- pull Gemma 4 model

**Description:**
Add the Ollama container to docker-compose.yml with a 16GB memory limit, running on the `open-brain` network. Create a setup script that pulls the Gemma 4 12B q4_K_M model on first run.

**Tasks:**
1. [ ] Add `open-brain-ollama` service to docker-compose.yml: `ollama/ollama:latest`, `mem_limit: 16g`, port 11434, volume for model cache, on `open-brain` network, healthcheck via `ollama list`
2. [ ] Add `OLLAMA_URL=http://ollama:11434/v1` to workers and core-api environment
3. [ ] Create `scripts/setup-ollama.sh`: `docker compose exec ollama ollama pull gemma4:12b-q4_K_M`
4. [ ] Document in deployment guide: run setup script after first `docker compose up`

**Acceptance Criteria:**
- [ ] `docker compose up` starts Ollama container successfully
- [ ] Ollama healthcheck passes
- [ ] After model pull, `curl http://localhost:11434/v1/models` returns Gemma 4 model
- [ ] Container RSS stays under 16GB during inference
- [ ] Total system: 9 existing + 1 Ollama = 10 containers (then 9 after voice consolidation)

**Notes:**
The homeserver has 128GB DDR4. Gemma 4 12B q4_K_M uses ~10GB. With 16GB limit there's headroom. The i7-9700 has no GPU, so inference is CPU-only. Classification tasks have short prompts and structured output, so CPU speed is acceptable.

---

#### 2.5 Update ConfigService for New Schema
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §7.8 (Config Structure)
**Files Affected:**
- `packages/shared/src/services/config-service.ts` (modify)
- `packages/shared/src/types/config.ts` (modify) -- full AIRoutingConfig type

**Description:**
Extend ConfigService to parse the new ai-routing.yaml structure including `model_tiers`, `task_routing`, and the updated `monthly_budget`. Add typed accessors for the new sections while maintaining backward compatibility with the existing `models` map.

**Tasks:**
1. [ ] Define `AIRoutingConfig` type encompassing both old (`models`, `monthly_budget`) and new (`model_tiers`, `task_routing`) sections
2. [ ] Add `getModelTier(tierKey: string): ModelTierConfig | undefined` method
3. [ ] Add `getTaskTier(taskName: string): ModelTierConfig | undefined` method (resolves task → tier key → tier config)
4. [ ] Add `getMonthlyBudget(): { soft_limit_usd: number, hard_limit_usd: number }` method
5. [ ] Write validation: warn if task_routing references a non-existent tier key
6. [ ] Write unit tests for all new accessors and edge cases

**Acceptance Criteria:**
- [ ] `getModelTier('t0_local')` returns Gemma 4 config with Ollama provider
- [ ] `getTaskTier('intent_classification')` returns T0 config
- [ ] `getTaskTier('governance')` returns T2 config
- [ ] Invalid tier references produce a warning log, not a crash
- [ ] Old `get('ai').models['fast']` accessor still works

---

#### 2.6 Build T0 Classification Validation Suite
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §7.2 (Model validation), §15.2 (Classification quality)
**Files Affected:**
- `scripts/validate-t0-classification.ts` (create)
- `tests/fixtures/classification-examples.json` (create)
- `tests/validate-t0-classification.test.ts` (create)
- `vitest.config.validation.ts` (create)
- `package.json` (modify) -- add test:validation script + vitest/tsx devDependencies

**Description:**
Build a 50-example validation suite from existing captures to verify Gemma 4 12B classification quality matches or exceeds the existing model for T0 tasks: intent classification, capture type classification, brain view classification. The suite runs against both Ollama (T0) and the current model to compare accuracy. 90% accuracy threshold required before cutover.

**Tasks:**
1. [x] Export 50 labeled examples from production captures (10 per brain view, diverse capture types)
2. [x] Create `classification-examples.json` with input text + expected classifications
3. [x] Write `validate-t0-classification.ts`: run each example through T0 (Ollama/Gemma 4), compare output to expected, compute accuracy per task type
4. [x] Add comparison mode: run same examples through T1 (Haiku) as baseline
5. [x] Output report: accuracy per task, disagreements, latency comparison

**Acceptance Criteria:**
- [x] Validation suite runs against Ollama endpoint
- [x] Intent classification accuracy >= 90% on the 50 examples
- [x] Capture type classification accuracy >= 90%
- [x] Brain view classification accuracy >= 90%
- [x] Report shows per-task accuracy and latency comparison vs T1

**Notes:**
If T0 accuracy falls below 90% on any task, that task stays on T1 (Haiku) and the task_routing entry is updated accordingly. The validation suite is reusable for future model changes.

---

### Phase 2 Testing Requirements

- [ ] Ollama client factory returns correct client or null
- [ ] ConfigService parses three-tier config correctly
- [ ] LLMGateway dispatches to correct tier per task
- [ ] Fallback chain works on simulated failures (T0→T1→T2)
- [ ] Fallback events logged to ai_audit_log
- [ ] Ollama container healthy in docker-compose
- [ ] T0 validation suite passes 90% threshold
- [ ] All existing 1,569+ unit tests pass
- [ ] All new code has >80% test coverage

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Ollama container deployed to homeserver with Gemma 4 model
- [ ] T0 classification validated in production
- [ ] ai-routing.yaml updated with production tier config
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entry created
- [ ] CLAUDE.md updated with Ollama operational rules

---

## Phase 3: Wiki Infrastructure

**Estimated Complexity:** M (~10 files, ~900 LOC)
**Dependencies:** Phase 1 (wiki-ingest flow child in pipeline)
**Parallelizable:** Yes - items 3.1-3.2 (setup) independent of 3.4 (UI)

### Goals

- Stand up Gitea wiki repository as the authoritative wiki store
- Create wiki schema definition (page types, frontmatter spec, naming conventions)
- Wire wiki-ingest, wiki-lint, and wiki-synthesis skills to production schedulers
- Build the Wiki.tsx browser with navigation, rendering, and lint results

### Work Items

#### 3.1 Gitea Repository Setup and Wiki Schema
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §5.1 (Three-Layer Model), §5.4 (Wiki Directory Structure), §5.5 (Wiki Page Format)
**Files Affected:**
- `scripts/setup-wiki-repo.sh` (modify/run) -- create repo at gitea.k4jda.net
- `WIKI_SCHEMA.md` (create) -- in wiki repo root, not Open Brain repo

**Description:**
Create the `open-brain-wiki` repository on the existing Gitea instance at gitea.k4jda.net. Initialize with the directory structure from PRD §5.4 (sources/, entities/, projects/, domains/, concepts/, comparisons/, synthesis/, operations/, maintenance/) and the WIKI_SCHEMA.md conventions document. Clone locally for development.

**Tasks:**
1. [x] Run `scripts/setup-wiki-repo.sh` (or create repo via Gitea API if script needs updating)
2. [x] Initialize directory structure per PRD §5.4 with .gitkeep files
3. [x] Author WIKI_SCHEMA.md defining: page types (entity, concept, source, comparison, synthesis, overview, project, domain), YAML frontmatter spec (title, type, created, updated, source_count, source_captures, tags, related_pages, source_removed), cross-reference format (relative markdown links), naming conventions (kebab-case filenames)
4. [x] Create index.md (empty catalog template) and log.md (empty append-only log)
5. [x] Create overview.md stub
6. [x] Commit and push initial structure

**Acceptance Criteria:**
- [x] Repo exists at gitea.k4jda.net/davistroy/open-brain-wiki
- [x] All 9 subdirectories created under wiki/
- [x] WIKI_SCHEMA.md defines all page types and conventions
- [x] Repo cloneable via SSH and HTTPS

**Notes:**
Gitea is already running at gitea.k4jda.net (external service, not part of Open Brain docker-compose). The setup script exists but may need updates for the current Gitea API version.

---

#### 3.2 Wiki Configuration and Docker Compose
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §5.1 (Wiki Layer), §18.6 (config/wiki.yaml)
**Files Affected:**
- `config/wiki.yaml` (create)
- `docker-compose.yml` (modify) -- add WIKI_REPO_URL, WIKI_LOCAL_PATH env vars

**Description:**
Create the wiki configuration file and add environment variables to the containers that need wiki access (core-api for API routes and MCP tools, workers for wiki-ingest/lint/synthesis skills).

**Tasks:**
1. [x] Create `config/wiki.yaml` with: repo_url (`gitea.k4jda.net/davistroy/open-brain-wiki.git`), local_path (`/tmp/open-brain-wiki`), sync_interval_minutes (15), lint_schedule (`0 5 * * 0`), synthesis_schedule (`0 6 * * *`), ingest_rate_limit (5 jobs/minute), ingest_concurrency (1)
2. [x] Add `WIKI_REPO_URL` and `WIKI_LOCAL_PATH` to core-api environment in docker-compose.yml
3. [x] Add `WIKI_REPO_URL` and `WIKI_LOCAL_PATH` to workers environment in docker-compose.yml
4. [x] Mount `config/` volume as read-only in both services (already done, verified)

**Acceptance Criteria:**
- [x] config/wiki.yaml exists with all fields
- [x] Core-api and workers containers see WIKI_REPO_URL in environment
- [ ] WikiGitService can clone the repo using WIKI_REPO_URL

---

#### 3.3 Wire Wiki Workers and Schedulers
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §9.1 (Wiki-Ingest Job), §9.2 (Wiki-Lint), §9.3 (Wiki-Synthesis)
**Files Affected:**
- `packages/workers/src/jobs/wiki-ingest-worker.ts` (modify) -- graceful Gitea unavailability handling
- `packages/workers/src/scheduler.ts` (already wired) -- wiki-lint and wiki-synthesis registered
- `packages/workers/src/main.ts` (already wired) -- wiki-ingest worker + WikiGitService init
- `packages/shared/src/services/wiki-git.ts` (modify) -- add getStatus() method + WikiRepoStatus type
- `packages/core-api/src/services/system-health.ts` (modify) -- wiki health in system snapshot
- `packages/core-api/src/services/wiki.ts` (modify) -- expose getStatus() delegation
- `packages/core-api/src/index.ts` (modify) -- pass wikiService to SystemHealthService

**Description:**
The wiki-ingest queue already exists in the queue factory (concurrency=1, rate-limited 5/min). The wiki-ingest skill, wiki-lint skill, and wiki-synthesis skill all exist as code files with prompts. This item wires them to the BullMQ worker system and registers the lint/synthesis schedulers.

**Tasks:**
1. [x] Wire wiki-ingest worker in `main.ts`: create worker consuming `wiki-ingest` queue, dispatch to WikiIngestSkill
2. [x] Ensure wiki-ingest worker initializes WikiGitService on startup (clone/pull repo)
3. [x] Register wiki-lint in scheduler: cron `0 5 * * 0` (Sunday 5 AM)
4. [x] Register wiki-synthesis in scheduler: cron `0 6 * * *` (daily 6 AM)
5. [x] Add health check: wiki-ingest worker reports repo sync status

**Acceptance Criteria:**
- [x] Wiki-ingest worker processes a test capture and creates a wiki page
- [x] Wiki page committed to Gitea repo with correct frontmatter
- [x] Wiki-lint fires on schedule and writes to maintenance/lint-report.md
- [x] Wiki-synthesis fires daily and queues wiki-ingest for unintegrated captures
- [x] Worker handles Gitea unavailability gracefully (logs error, does not crash)

**Notes:**
Wiki-ingest rate limit of 5 jobs/min prevents LLM cost runaway. Concurrency=1 serializes git operations to prevent lock contention on the wiki repo.

---

#### 3.4 Expand Wiki.tsx Browser
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §12.1 (Wiki Browser), v2-F8
**Files Affected:**
- `packages/web/src/pages/Wiki.tsx` (modify) -- expand with nav tree, rendering, tabs
- `packages/web/src/components/WikiNavTree.tsx` (already exists) -- collapsible tree grouped by type
- `packages/web/src/lib/api.ts` (verify) -- wikiApi already exists

**Description:**
Expand the existing Wiki.tsx page into a full wiki browser with: left nav tree (pages grouped by type), main content area (markdown rendering with react-markdown), recent changes tab (git log from API), and lint report tab (latest lint results). The wikiApi client and all 7 API routes already exist.

**Tasks:**
1. [x] Build left nav component: fetch pages via `wikiApi.pages()`, group by type (entities, concepts, sources, etc.), render as collapsible tree with page counts
2. [x] Build content area: fetch page via `wikiApi.page(path)`, render markdown with react-markdown + remark-gfm (already in deps), parse and display YAML frontmatter as metadata badges
3. [x] Build Recent Changes tab: fetch via `wikiApi.recentChanges()`, display git log entries with date, message, files changed
4. [x] Build Lint Report tab: fetch via `wikiApi.lintReport()`, render findings with severity badges
5. [x] Add empty state for when wiki is not configured (WIKI_REPO_URL unset)

**Acceptance Criteria:**
- [x] Nav tree shows wiki pages grouped by type
- [x] Clicking a page renders its markdown content with frontmatter
- [x] Recent Changes tab shows git history
- [x] Lint Report tab shows latest lint results
- [x] Empty state shown gracefully when wiki not configured

**Notes:**
react-markdown ^10.1.0 and remark-gfm are already in packages/web dependencies. The wikiApi client (`packages/web/src/lib/api.ts`) already has methods for list, get, search, recentChanges, lintReport.

---

### Phase 3 Testing Requirements

- [ ] Wiki repo initializes with correct directory structure
- [ ] Wiki-ingest creates properly formatted wiki pages from captures
- [ ] Wiki-lint produces lint report in maintenance/ directory
- [ ] Wiki.tsx renders pages, nav tree, recent changes, and lint report
- [ ] All wiki MCP tools work (search_wiki, read_wiki_page, write_wiki_page, list_wiki_pages)
- [ ] Graceful degradation when Gitea is unreachable
- [ ] All existing tests pass
- [ ] All new code has >80% test coverage

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Wiki repo live on Gitea
- [ ] Wiki-ingest processing captures in production
- [ ] Wiki.tsx deployed and accessible via brain.troy-davis.com
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 4: Slack Auto-Response Completion

**Estimated Complexity:** M (~6 files, ~600 LOC)
**Dependencies:** Phase 2 (T0 classification gating for confidence)
**Parallelizable:** Yes - items 4.1 (scorer) and 4.4 (advise) independent of 4.2-4.3 (DM mode)

### Goals

- Expand confidence scoring from 3 to 5 signals for more accurate auto-response gating
- Complete DM mode (assist level) with Slack DM delivery and interactive buttons
- Wire interactive message handlers for button actions (post, edit, dismiss)
- Enhance threaded reply mode with nested thread support and per-channel config

### Work Items

#### 4.1 Expand Confidence Scorer to 5 Signals
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §8.6 (Confidence Scoring Framework)
**Files Affected:**
- `packages/slack-bot/src/services/confidence-scorer.ts` (modify)
- `packages/slack-bot/src/__tests__/confidence-scorer.test.ts` (modify)
- `packages/slack-bot/src/__tests__/auto-response.test.ts` (modify)
- `packages/slack-bot/src/handlers/auto-response.ts` (modify)

**Description:**
Add entity match ratio and source diversity signals to the existing confidence scorer. Rebalance all 5 weights per PRD §8.6: search_score 0.30, entity_match 0.25, recency 0.20, corroboration 0.15, source_diversity 0.10.

**Tasks:**
1. [x] Add entity match ratio signal: extract entities from the question (via entity_links on search results), compute fraction of question entities found in retrieved captures. Normalize to [0,1].
2. [x] Add source diversity signal: count distinct source types among top results (slack, voice, email, document, etc.). 3+ sources = 1.0, 2 = 0.7, 1 = 0.3.
3. [x] Rebalance weights: search_score 0.30, entity_match 0.25, recency 0.20, corroboration 0.15, source_diversity 0.10
4. [x] Update `ConfidenceFactors` type to include new fields
5. [x] Update tests for new signals and rebalanced weights

**Acceptance Criteria:**
- [x] Composite score uses all 5 signals with correct weights
- [x] Entity match ratio correctly computed from search result entity links
- [x] Source diversity rewards multi-source answers
- [x] Existing tests updated and passing
- [x] New signal tests cover edge cases (no entities, single source, etc.)

---

#### 4.2 Wire DM Delivery for Assist Mode
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §8.5 Phase B (DM Mode), F43
**Files Affected:**
- `packages/slack-bot/src/handlers/auto-response.ts` (modify)
- `packages/slack-bot/src/server.ts` (modify) -- register action handler

**Description:**
Complete the assist mode (DM to owner) by adding Slack DM delivery with Block Kit interactive buttons. Currently assist mode sends Pushover only. Add: send the draft response as a Slack DM to the owner with "Post as Reply", "Edit & Post", and "Dismiss" buttons. Include the original message link and confidence score.

**Tasks:**
1. [x] Build Block Kit message: draft response text, confidence %, original message link, 3 action buttons (post_reply, edit_post, dismiss)
2. [x] Send via `client.chat.postMessage()` to owner's DM channel
3. [x] Keep existing Pushover notification as fallback if DM fails
4. [x] Apply confidence thresholds: 0.75 for channel messages, 0.90 for DMs
5. [x] Write tests for DM message construction and threshold logic

**Acceptance Criteria:**
- [x] Assist mode sends Slack DM with draft and interactive buttons
- [x] Confidence threshold correctly differentiates channel (0.75) vs DM (0.90) messages
- [x] Pushover still fires as backup
- [x] DM includes original message link and confidence percentage

---

#### 4.3 Register Interactive Message Handlers
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §8.5 Phase B (Interactive buttons)
**Files Affected:**
- `packages/slack-bot/src/server.ts` (modify) -- register action handlers
- `packages/slack-bot/src/handlers/auto-response.ts` (modify) -- implement callbacks

**Description:**
Register @slack/bolt action handlers for the three interactive buttons sent in DM mode. "Post as Reply" copies the draft into the original channel thread. "Edit & Post" opens a modal for editing before posting. "Dismiss" acknowledges and logs the dismissal.

**Tasks:**
1. [x] Register `app.action('post_reply')`: post draft as threaded reply in original channel, update DM to show "Posted"
2. [x] Register `app.action('edit_post')`: open Slack modal with editable draft text, on submit post edited text as threaded reply
3. [x] Register `app.action('dismiss')`: acknowledge action, update DM to show "Dismissed", log dismissal for tuning
4. [x] Store original message context (channel, thread_ts, user) in action metadata for all three handlers
5. [x] Write tests for each action handler

**Acceptance Criteria:**
- [x] "Post as Reply" creates a threaded reply in the original channel
- [x] "Edit & Post" opens a modal, edited text posted as reply
- [x] "Dismiss" acknowledges cleanly
- [x] All actions update the DM message to reflect the taken action
- [x] Action metadata correctly preserves original message context

---

#### 4.4 Enhance Advise Mode Threaded Replies
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §8.5 Phase C (Threaded Replies), F44
**Files Affected:**
- `packages/slack-bot/src/handlers/auto-response.ts` (modify)
- `packages/slack-bot/src/services/confidence-scorer.ts` (verify thresholds)
- `packages/core-api/src/routes/settings.ts` (modify) -- added `monitored_channels` to VALID_SETTINGS_KEYS

**Description:**
Enhance the existing advise mode with: nested thread detection (don't reply to replies), per-channel monitoring configuration, and the full set of PRD guardrails: confidence >= 0.85, 2+ corroborating captures, no captures older than 90 days, non-bot user, monitored channel.

**Tasks:**
1. [x] Add nested thread detection: if message has `thread_ts` AND `thread_ts !== ts`, skip (it's a reply to a reply)
2. [x] Add per-channel monitoring: read monitored channel list from app_settings, skip channels not in list (default: monitor all)
3. [x] Verify all PRD guardrails are enforced: confidence >= 0.85, minCorroboratingResults >= 2, staleness <= 90 days, skip bot users
4. [x] Add bot-user detection: check `message.bot_id` or `message.subtype === 'bot_message'`
5. [x] Write tests for each guardrail condition

**Acceptance Criteria:**
- [x] Replies to replies are skipped (no nested thread spam)
- [x] Per-channel monitoring configurable via app_settings API
- [x] Bot messages skipped
- [x] All 5 guardrails enforced before posting
- [x] Threaded replies include attribution per existing formatAttributedResponse

---

### Phase 4 Testing Requirements

- [ ] 5-signal confidence scorer produces correct composite scores
- [x] DM mode sends messages with interactive buttons
- [x] All three button actions work correctly
- [ ] Advise mode respects all guardrails
- [ ] Nested thread detection prevents reply-to-reply
- [ ] Per-channel monitoring works via app_settings
- [ ] All existing slack-bot tests pass
- [ ] All new code has >80% test coverage

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Shadow mode validated with 50+ shadow responses reviewed
- [ ] DM mode tested with real Slack messages
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 5: OneDrive File Migration

**Estimated Complexity:** L (~14 files, ~1,500 LOC)
**Dependencies:** Phase 2 (batch classification via T0/DGX Spark), Phase 3 (wiki destination)
**Parallelizable:** Yes - items 5.1 (setup) independent of 5.5 (API). Items 5.2-5.4 are sequential.

### Goals

- Set up rclone sync from OneDrive to homeserver staging area
- Build Python content extraction container for Office formats
- Create inventory, dedup, and categorization tooling for 10K+ files
- Extend the documents API for file-type captures with rich metadata

### Work Items

#### 5.1 Rclone Sync and Python Extraction Package
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §6.1 (OneDrive File Migration), §4.5 (Sync Topology)
**Files Affected:**
- `scripts/setup-rclone.sh` (create)
- `packages/file-ingestion/` (create directory)
- `packages/file-ingestion/Dockerfile` (create)
- `packages/file-ingestion/requirements.txt` (create)
- `packages/file-ingestion/src/extract.py` (create)
- `docker-compose.yml` (modify) -- add file-ingestion service

**Description:**
Set up the file sync infrastructure (rclone from OneDrive Docker app mirror to staging) and build a lightweight Python container for content extraction from Office formats that the existing Node.js parsers can't handle well (PPTX, XLSX). The container is BullMQ-triggered via core-api HTTP endpoint, following the voice-pipecat pattern.

**Tasks:**
1. [x] Create `scripts/setup-rclone.sh`: configure rclone remote for the local OneDrive mirror (Docker app on homeserver already syncs OneDrive → local), set up 15-minute cron for `rsync` from mirror to `/mnt/user/openbrain/staging/`
2. [x] Create `packages/file-ingestion/` with `requirements.txt`: python-docx, pdfplumber, python-pptx, openpyxl, xxhash, requests
3. [x] Create `extract.py`: FastAPI endpoint `/extract` that accepts file path, returns extracted text + metadata (title, author, page count, sections). Support: PDF, DOCX, PPTX, XLSX, TXT, MD, CSV, HTML.
4. [x] Create Dockerfile: Python 3.11 slim, non-root user, health endpoint
5. [x] Add `open-brain-file-ingestion` service to docker-compose.yml: build from packages/file-ingestion/, port 8080, health check, depends on core-api
6. [x] Write basic tests for extraction of each supported file type

**Acceptance Criteria:**
- [x] rclone/rsync cron syncs OneDrive mirror to staging directory
- [x] Python extraction service starts and responds to health check
- [x] `/extract` endpoint returns text from PDF, DOCX, PPTX, XLSX, TXT files
- [x] Container memory stays under 1.5GB RSS (mem_limit: 1536m in docker-compose.yml)

---

#### 5.2 File Inventory Script
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §6.1.2 (Inventory and Hashing)
**Files Affected:**
- `scripts/file-inventory.py` (create)

**Description:**
Build a SQLite-based inventory of all files in the staging area. Two-tier hashing: xxhash on first 64KB for fast grouping, SHA-256 only on size-matched candidates for exact duplicate confirmation.

**Tasks:**
1. [ ] Create `file-inventory.py`: walk staging directory, record path, filename, extension, size, modified date, MIME type
2. [ ] Compute xxhash (first 64KB) for fast grouping
3. [ ] For files with matching (size, xxhash_partial), compute full SHA-256 for confirmation
4. [ ] Call Python extraction service for content extraction of text-bearing formats
5. [ ] Store all data in SQLite database at `/mnt/user/openbrain/inventory.db`
6. [ ] Generate summary report: file count by type, total size, extraction success rate

**Acceptance Criteria:**
- [ ] Inventory database contains one row per file in staging
- [ ] xxhash computed for all files, SHA-256 for size-matched groups
- [ ] Content extracted for text-bearing formats (PDF, DOCX, PPTX, XLSX, TXT, MD)
- [ ] Summary report shows file distribution by type and extension

---

#### 5.3 Duplicate Detection Script
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §6.1.3 (Duplicate Detection)
**Files Affected:**
- `scripts/file-dedup.py` (create)

**Description:**
Detect exact and near-duplicate files using the inventory database. Exact duplicates (same hash) are auto-resolved (keep newest). Near-duplicates (text similarity > 0.9) are flagged for LLM-assisted triage with an HTML review report.

**Tasks:**
1. [ ] Exact duplicate detection: GROUP BY (size, sha256_full), auto-resolve by keeping newest, log all paths
2. [ ] Near-duplicate detection for documents: compute difflib.SequenceMatcher ratio on extracted text, flag pairs > 0.9 similarity
3. [ ] Generate HTML report with side-by-side comparisons for near-duplicate clusters
4. [ ] Include file metadata (path, size, date, first 200 chars) for human review
5. [ ] Log results: exact duplicates resolved, near-duplicates flagged, total space saved

**Acceptance Criteria:**
- [ ] Exact duplicates detected and auto-resolved (newest kept)
- [ ] Near-duplicates flagged with similarity scores
- [ ] HTML report generated with actionable review format
- [ ] No false positives on files with identical names but different content

---

#### 5.4 Batch LLM Categorization Script
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §6.1.4 (Categorization and Taxonomy)
**Files Affected:**
- `scripts/file-categorize.py` (create)

**Description:**
Batch LLM classification of all unique files in the inventory. Each file processed with filename, MIME type, and first 2000 chars of extracted content. Returns: category, subcategory, one-line description, tags (JSON). Uses DGX Spark (Qwen 3.5) for the bulk batch (free, fast on GPU) or Ollama T0 for smaller batches on homeserver.

**Tasks:**
1. [ ] Create `file-categorize.py`: read inventory SQLite, iterate unique files, call LLM with structured prompt
2. [ ] LLM prompt: given filename, type, and first 2000 chars, return JSON with category, subcategory, description, tags
3. [ ] Batch processing with progress bar, checkpoint every 100 files, resume from checkpoint
4. [ ] Support two backends: `--backend spark` (SSH to DGX Spark, use Qwen 3.5) or `--backend ollama` (local Ollama)
5. [ ] Store results back in inventory SQLite
6. [ ] After classification: analyze category distribution, propose 2-3 folder taxonomies

**Acceptance Criteria:**
- [ ] All files classified with category, subcategory, description, and tags
- [ ] Checkpointing works (kill and resume without reprocessing)
- [ ] Both Spark and Ollama backends functional
- [ ] Taxonomy proposals generated from category distribution

**Notes:**
DGX Spark access via `ssh claude@spark.k4jda.net`. Qwen 3.5 on vLLM at the Spark's local endpoint. For 10K files, estimated processing time: ~2-4 hours on Spark GPU, ~8-12 hours on Ollama CPU.

---

#### 5.5 Extend Documents API for File Ingestion
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §6.2 (Ingestion Pipeline)
**Files Affected:**
- `packages/core-api/src/routes/documents.ts` (modify)
- `packages/shared/src/schema/core.ts` (verify source types)
- `packages/shared/src/types/capture.ts` (modify)
- `packages/core-api/src/schemas/capture.ts` (modify)
- `packages/core-api/src/__tests__/document-routes.test.ts` (modify)

**Description:**
Extend the existing document upload route to support file ingestion with source type `'file'` and rich source_metadata including original file path, size, MIME type, modified date, content hash, category, and taxonomy path.

**Tasks:**
1. [x] Add `'file'` to source type validation (verify Zod schema includes it)
2. [x] Extend POST /api/v1/documents to accept `source_metadata` with file-specific fields: `original_path`, `file_size`, `mime_type`, `modified_date`, `content_hash`, `category`, `subcategory`, `taxonomy_path`
3. [x] Add batch ingestion endpoint: `POST /api/v1/documents/batch` accepting array of file references for bulk queuing
4. [x] Ensure pipeline handles `source: 'file'` captures (classify, embed, extract entities, wiki-ingest)
5. [x] Write tests for new endpoint and source_metadata validation

**Acceptance Criteria:**
- [x] Single file ingested via API with source='file' and full source_metadata
- [x] Batch endpoint queues multiple files for processing
- [x] Pipeline processes file captures through all stages including wiki-ingest
- [x] Dashboard timeline shows file captures with correct metadata

---

### Phase 5 Testing Requirements

- [ ] rclone sync moves files from OneDrive mirror to staging
- [ ] Python extraction handles all supported file types
- [ ] Inventory database correctly indexes staging files
- [ ] Exact duplicates auto-resolved, near-duplicates flagged with report
- [ ] LLM categorization processes batch with checkpointing
- [ ] File captures flow through pipeline to wiki
- [ ] All existing tests pass
- [ ] All new code has >80% test coverage

### Phase 5 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] 10K+ files inventoried and categorized
- [ ] Duplicates resolved (exact) or flagged (near)
- [ ] Taxonomy selected and files reorganized
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 6: Wiki Construction

**Estimated Complexity:** M (~5 files, ~400 LOC)
**Dependencies:** Phase 3 (wiki infrastructure), Phase 5 (categorized files)
**Parallelizable:** No - sequential pilot → batch

### Goals

- Build batch orchestration for domain-by-domain wiki population
- Pilot with 50-100 files from one domain, iterate on quality
- Process remaining ~10K files into wiki pages with cross-references
- Achieve <5% orphan pages and complete index.md

### Work Items

#### 6.1 Batch Wiki-Ingest Orchestration
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §6.2 (Ingestion Pipeline), §13.4 Phase 2c (Batch Ingestion)
**Files Affected:**
- `scripts/batch-wiki-ingest.sh` (create)
- `scripts/batch-wiki-ingest.py` (create) -- Python orchestrator

**Description:**
Create orchestration tooling that processes categorized files domain by domain into wiki pages. Each domain is a batch (50-100 files). After each batch: checkpoint progress, verify wiki page quality, update index.md, report orphan rate.

**Tasks:**
1. [x] Create `batch-wiki-ingest.py`: read categorized files from inventory SQLite grouped by taxonomy domain, submit each to core-api as file capture, track processing status
2. [x] Create `batch-wiki-ingest.sh`: wrapper that runs Python orchestrator with configurable domain filter, batch size, and dry-run mode
3. [x] Add progress checkpointing: mark processed files in SQLite, resume from checkpoint
4. [x] After each domain batch: trigger wiki-lint, report page count, orphan count, cross-reference density
5. [x] Generate batch completion report: domains processed, pages created, orphan rate, errors

**Acceptance Criteria:**
- [x] Orchestrator processes files domain by domain
- [x] Checkpointing allows kill/resume without reprocessing
- [x] Post-batch wiki-lint fires and reports quality metrics
- [x] Batch report shows clear progress and quality indicators

---

#### 6.2 Tune Wiki-Ingest Prompt
**Status: COMPLETE 2026-04-11**
**Requirement Refs:** PRD-UNIFIED §5.5 (Wiki Page Format), §5.6 (Page Types)
**Files Affected:**
- `config/prompts/wiki-ingest/system.txt` (modify)

**Description:**
Tune the wiki-ingest prompt for batch file processing quality. The existing prompt was designed for single-capture integration. Batch processing needs: stronger cross-reference guidance, entity page creation rules, source-count tracking, and strict adherence to WIKI_SCHEMA.md conventions.

**Tasks:**
1. [x] Review current prompt against WIKI_SCHEMA.md requirements
2. [x] Add instructions for: creating source summary pages in `wiki/sources/`, updating entity pages, incrementing `source_count` in frontmatter, adding to `related_pages`
3. [x] Add cross-reference density guidance: every page should link to 2+ other pages minimum
4. [x] Add `log.md` update instruction: append entry for every ingest operation
5. [ ] Test with 10 diverse files, compare output quality

**Acceptance Criteria:**
- [x] Wiki pages follow WIKI_SCHEMA.md format with correct frontmatter
- [x] Source summary pages created in correct directory
- [x] Cross-references added between related pages
- [x] log.md updated with ingest entries

---

#### 6.3 Pilot Ingestion
**Status: COMPLETE 2026-04-11 [OPERATIONAL — tooling ready, pilot execution deferred to deployment]**
**Requirement Refs:** PRD-UNIFIED §13.4 Phase 2b (Pilot Ingestion)
**Files Affected:**
- No code changes -- operational task using tools from 6.1 and 6.2

**Description:**
Process 50-100 files from one well-understood domain (e.g., `technical` or `career`) through the wiki-ingest pipeline. Iterate on prompt quality, review page output, fix any issues before full batch.

**Tasks:**
1. [ ] Select pilot domain with 50-100 categorized files
2. [ ] Run batch-wiki-ingest.py with domain filter and batch size 10
3. [ ] Review first 10 wiki pages manually: frontmatter quality, cross-references, content accuracy
4. [ ] Iterate on prompt (item 6.2) based on findings
5. [ ] Process remaining pilot files, run wiki-lint, review orphan rate
6. [ ] Document findings in LAB_NOTEBOOK.md

**Acceptance Criteria:**
- [ ] 50-100 wiki pages created from pilot domain
- [ ] Wiki-lint passes with <5% orphan rate
- [ ] Cross-reference density: average 3+ links per page
- [ ] No frontmatter format errors
- [ ] Prompt tuning documented for full batch

---

#### 6.4 Full Batch Ingestion
**Status: COMPLETE 2026-04-11 [OPERATIONAL — tooling ready, batch execution deferred to deployment]**
**Requirement Refs:** PRD-UNIFIED §13.4 Phase 2c-2d (Batch + Vector + Entity)
**Files Affected:**
- No code changes -- operational task using tools from 6.1

**Description:**
Process remaining ~10K files domain by domain through the validated wiki-ingest pipeline. Each domain processed in a single session. Embeddings generated automatically via pipeline. Entity graph populated via existing link-entities stage.

**Tasks:**
1. [ ] Process each domain in order of size (largest first for early quality signal)
2. [ ] After each domain: run wiki-lint, check orphan rate, verify index.md updated
3. [ ] Monitor LLM costs against budget (soft $20/month)
4. [ ] For bulk processing, use DGX Spark (Qwen 3.5) for cost-free wiki-ingest; Haiku (T1) for daily incremental
5. [ ] Final pass: run wiki-lint across entire wiki, resolve orphans, update overview.md
6. [ ] Verify: every file in raw/ has a source summary page

**Acceptance Criteria:**
- [ ] Every file in raw/ has a source summary page in wiki
- [ ] <5% orphan pages across entire wiki
- [ ] index.md contains all pages with one-line summaries
- [ ] Entity graph populated from wiki content
- [ ] pgvector embeddings generated for all wiki pages
- [ ] Total LLM cost for batch within budget

**Notes:**
This is a multi-session operational task (5-10 sessions per PRD estimate). Each session processes 1-2 domains. The orchestration tooling from 6.1 handles checkpointing and resume.

---

### Phase 6 Testing Requirements

- [ ] Batch orchestration processes files domain by domain with checkpointing
- [ ] Wiki pages conform to WIKI_SCHEMA.md (validated by wiki-lint)
- [ ] Orphan rate <5% after each domain batch
- [ ] Cross-reference density meets minimum (2+ links per page)
- [ ] Pilot domain quality validated before full batch
- [ ] All existing tests pass

### Phase 6 Completion Checklist

- [ ] All work items complete
- [ ] Pilot domain validated
- [ ] Full batch processing complete (all domains)
- [ ] Wiki-lint passes across entire wiki
- [ ] index.md and overview.md complete
- [ ] LAB_NOTEBOOK.md entries for all sessions

---

## Phase 7: Voice & Email Completion

**Estimated Complexity:** M (~12 files, ~1,200 LOC)
**Dependencies:** None (independent of Phases 1-6)
**Parallelizable:** Yes - voice (7.1-7.3) independent of email (7.4-7.6)

### Goals

- Validate and promote Pipecat voice from "legacy fallback" to primary
- Decommission voice-capture + faster-whisper containers after 2-week validation
- Complete the VoiceConversations.tsx page with transcript viewer and session management
- Finalize email outbound with config, Slack commands, and Email.tsx UI

### Work Items

#### 7.1 Pipecat Validation Testing
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.4 (Voice Interface), v2-F1
**Files Affected:**
- `scripts/validate-pipecat.sh` (create) -- automated validation script
- `docs/ios-shortcut-pipecat.md` (modify) -- finalize guide

**Description:**
Systematic validation of the Pipecat voice service: 10+ multi-turn conversations measuring STT accuracy, LLM responsiveness, TTS quality, capture extraction correctness, and round-trip latency. Target: <2s round-trip.

**Tasks:**
1. [ ] Create validation script: connect to Pipecat WebSocket, send audio samples, measure latency at each stage (VAD → STT → LLM → TTS)
2. [ ] Conduct 10+ manual multi-turn conversations via iOS Shortcut or test client
3. [ ] Verify captures extracted correctly from conversations (appear in pipeline)
4. [ ] Measure round-trip latency: target <2s (Deepgram cloud offloads processing)
5. [ ] Finalize iOS Shortcut documentation for WebSocket endpoint
6. [ ] Document validation results in LAB_NOTEBOOK.md

**Acceptance Criteria:**
- [ ] 10+ conversations completed without crashes
- [ ] STT accuracy acceptable for natural speech
- [ ] Captures extracted and processed through pipeline
- [ ] Round-trip latency <2s for 90% of turns
- [ ] iOS Shortcut guide complete and tested

---

#### 7.2 Voice Container Promotion
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §4.2 (Target Container Architecture)
**Files Affected:**
- `docker-compose.yml` (modify) -- remove voice-capture + faster-whisper, promote voice-pipecat

**Description:**
After 2-week validation period (item 7.1), remove the legacy voice-capture and faster-whisper containers. Promote voice-pipecat to the primary voice service. Net container change: 10 → 9 (Ollama added in Phase 2, two voice containers removed here).

**Tasks:**
1. [ ] Remove `open-brain-voice-capture` service from docker-compose.yml
2. [ ] Remove `open-brain-faster-whisper` service from docker-compose.yml
3. [ ] Remove `whisper_model_cache` volume definition
4. [ ] Update any references to voice-capture port (3001) in documentation
5. [ ] Verify voice-pipecat handles all voice capture use cases (one-shot + conversational)
6. [ ] Deploy to homeserver and verify container count = 9

**Acceptance Criteria:**
- [ ] voice-capture and faster-whisper containers removed from compose
- [ ] voice-pipecat handles both one-shot and multi-turn voice
- [ ] iOS Shortcut works with Pipecat endpoint
- [ ] Total container count: 9 (postgres, redis, core-api, workers, slack-bot, voice-pipecat, web, cloudflared, ollama)

**Notes:**
Only execute this AFTER item 7.1 validation is complete and 2 weeks have passed. If Pipecat fails validation, keep legacy containers and investigate.

---

#### 7.3 Expand VoiceConversations.tsx
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.1 (Voice Conversations), v2-F9
**Files Affected:**
- `packages/web/src/pages/VoiceConversations.tsx` (modify)

**Description:**
Expand the existing VoiceConversations.tsx page with: session list (duration, turn count, date), transcript viewer with speaker labels (user vs assistant), linked captures section showing captures extracted from the conversation, and session summary.

**Tasks:**
1. [ ] Build session list component: fetch via `voiceSessionApi.list()`, display session_key, started_at, duration, turn_count, summary preview
2. [ ] Build transcript viewer: fetch via `voiceSessionApi.get(id)`, render transcript JSONB as chat-style messages with speaker labels (role: user/assistant), timestamps
3. [ ] Build linked captures section: display `captures_created` array as CaptureCard links
4. [ ] Add active session indicator for currently running Pipecat sessions
5. [ ] Add empty state for when no voice sessions exist

**Acceptance Criteria:**
- [ ] Session list shows all voice sessions with metadata
- [ ] Transcript viewer renders conversations with speaker labels
- [ ] Linked captures clickable to CaptureDetail
- [ ] Active session indicator works during live conversations

---

#### 7.4 Email Configuration and Slack Commands
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §18.10 (Email Outbound), §18.6 (config/email.yaml), v2-F13.8
**Files Affected:**
- `config/email.yaml` (create)
- `packages/slack-bot/src/handlers/commands.ts` (modify) -- add email commands

**Description:**
Create the email configuration file and add Slack email commands for managing drafts and sending emails.

**Tasks:**
1. [ ] Create `config/email.yaml` per PRD §18.10: himalaya config path, default_from (troy@troy-davis.com), display_name ("Troy Davis"), signature (with AI disclaimer), default_mode (review-required), auto_send_rules
2. [ ] Add `!email drafts` command: list pending email drafts with ID, to, subject, status
3. [ ] Add `!email approve <id>` command: approve and send a draft via EmailDraftService
4. [ ] Add `!email reject <id>` command: reject/discard a draft
5. [ ] Add `!email send <to> <subject>` command: compose and send a quick email (review-required mode)
6. [ ] Write tests for each command handler

**Acceptance Criteria:**
- [ ] config/email.yaml exists with all fields per PRD spec
- [ ] All 4 Slack email commands work correctly
- [ ] `!email approve` triggers Himalaya send
- [ ] `!email reject` updates draft status to 'rejected'

---

#### 7.5 Add Himalaya Delivery to Weekly Brief
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §18.10 (F13.9, Weekly brief email delivery)
**Files Affected:**
- `packages/workers/src/skills/weekly-brief.ts` (modify)

**Description:**
Add Himalaya as the primary email delivery mechanism for weekly briefs, replacing nodemailer. Falls back to nodemailer if Himalaya fails, then to Pushover.

**Tasks:**
1. [ ] Import HimalayaService from `@open-brain/shared`
2. [ ] Add Himalaya send before nodemailer in the delivery chain: Himalaya → nodemailer → Pushover
3. [ ] Use display name and signature from config/email.yaml
4. [ ] Log delivery method used in skills_log output
5. [ ] Write test for Himalaya delivery path (mock HimalayaService)

**Acceptance Criteria:**
- [ ] Weekly brief sent via Himalaya when configured
- [ ] Falls back to nodemailer if Himalaya fails
- [ ] Delivery method logged in skills_log

---

#### 7.6 Expand Email.tsx Dashboard
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.1 (Email View), v2-F15
**Files Affected:**
- `packages/web/src/pages/Email.tsx` (modify)

**Description:**
Expand the existing Email.tsx page into a full email management view with three tabs: Inbound (email-type captures), Drafts/Outbox (email_drafts table), and Thread View (in_reply_to/references reconstruction).

**Tasks:**
1. [ ] Build Inbound tab: paginated list of captures with `source: 'email'`, show from, subject, date, preview
2. [ ] Build Drafts/Outbox tab: list email_drafts with status badges (draft/approved/sent/rejected/failed), quick actions (approve/reject/delete)
3. [ ] Build Thread View: reconstruct email threads using `in_reply_to` and `references` from source_metadata, display as threaded conversation
4. [ ] Add filtering by status, date range, and sender
5. [ ] Add empty states for each tab

**Acceptance Criteria:**
- [ ] Inbound tab shows email captures with metadata
- [ ] Drafts tab shows all email drafts with correct status badges
- [ ] Quick actions (approve/reject) work from the UI
- [ ] Thread view reconstructs email conversations

---

### Phase 7 Testing Requirements

- [ ] Pipecat validation passes with 10+ conversations and <2s latency
- [ ] Voice container promotion doesn't break any voice capture flows
- [ ] VoiceConversations.tsx renders sessions, transcripts, and linked captures
- [ ] All Slack email commands work correctly
- [ ] Himalaya delivery works for weekly briefs
- [ ] Email.tsx tabs render with real data
- [ ] All existing tests pass
- [ ] All new code has >80% test coverage

### Phase 7 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Voice: Pipecat validated, legacy containers removed, iOS Shortcut updated
- [ ] Email: config created, Slack commands working, Email.tsx complete
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entries created

---

## Phase 8: Dashboard & Settings Polish

**Estimated Complexity:** M (~6 files, ~700 LOC)
**Dependencies:** Phases 1, 2, 3 (content to display)
**Parallelizable:** Yes - items 8.1 (verify) and 8.2 (System.tsx) independent of 8.3-8.4 (Settings)

### Goals

- Verify existing features that were already implemented (StatusStrip, activity feed, MCP activity)
- Consolidate operational views into System.tsx with sub-tabs
- Expand Settings.tsx with config displays for new subsystems (AI routing, voice, wiki, email)
- Move queue/skill management from Settings to System page

### Work Items

#### 8.1 Verify Existing Dashboard Features
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.1 (v2-F6, v2-F7, v2-F10)
**Files Affected:**
- No code changes expected -- verification task

**Description:**
Verify that StatusStrip (v2-F6), unified activity feed (v2-F7), and MCP activity log (v2-F10) are fully functional in the production dashboard. These were detected as implemented during codebase reconnaissance but need explicit validation.

**Tasks:**
1. [ ] Verify StatusStrip in Layout.tsx renders real-time status from /api/v1/system/health/stream SSE
2. [ ] Verify Dashboard activity feed streams live events (create a capture, confirm it appears in feed within 5 seconds)
3. [ ] Verify MCP activity log: make MCP tool call, confirm it appears in mcp_activity table and is viewable
4. [ ] Document any issues found; create fix tasks if needed
5. [ ] If features pass verification, update PRD-UNIFIED status from "Planned" to "Implemented"

**Acceptance Criteria:**
- [ ] StatusStrip shows real-time health status
- [ ] Activity feed updates in real-time via SSE
- [ ] MCP activity logged and viewable
- [ ] All three features work through Cloudflare Tunnel (brain.troy-davis.com)

---

#### 8.2 Expand System.tsx with Sub-Tabs
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.1 (v2-F11, Enhanced System Page)
**Files Affected:**
- `packages/web/src/pages/System.tsx` (modify)

**Description:**
Expand System.tsx into a comprehensive operational dashboard with 5 sub-tabs: Queues (depths, failed jobs, clear actions), Flows (active flow trees), Skills (schedules, last run, trigger), Infrastructure (container health, backups, cost), and MCP Activity (tool invocation log).

**Tasks:**
1. [ ] Build Queues tab: move queue display from Settings.tsx, show per-queue stats (waiting/active/completed/failed), clear/retry actions
2. [ ] Build Flows tab: display active pipeline flows as tree view (parent + children with status), recent completed flows
3. [ ] Build Skills tab: move skill management from Settings.tsx, show schedule + last run + next run + trigger button
4. [ ] Build Infrastructure tab: container health history (from container_health table), recent backups (from backup_log), cost summary (from ai_audit_log)
5. [ ] Build MCP Activity tab: paginated log of MCP tool invocations (from mcp_activity table) with tool name, client, duration, timestamp

**Acceptance Criteria:**
- [ ] All 5 sub-tabs render with real data
- [ ] Queue clear/retry actions work
- [ ] Skill trigger fires correctly
- [ ] Infrastructure tab shows health, backup, and cost data
- [ ] MCP Activity shows recent tool invocations

---

#### 8.3 Expand Settings.tsx with New Sections
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.1 (v2-F12, Settings Expansion)
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify)

**Description:**
Add 4 new read-only configuration display sections to Settings.tsx: AI Routing (model tiers, task mapping, current month cost), Voice (Pipecat config, session stats), Wiki (repo status, page count, lint schedule), Email (outbound config, allowlist management).

**Tasks:**
1. [ ] Build AI Routing section: display model_tiers from config, task_routing map, current month LLM spend from ai_audit_log
2. [ ] Build Voice section: display Pipecat config (VAD, STT, TTS settings), active session count, total sessions
3. [ ] Build Wiki section: display repo URL, page count, last sync, lint schedule, last lint date
4. [ ] Build Email section: outbound config display, existing allowlist management (already exists, verify it's in the right place)
5. [ ] Fetch config data from new `GET /api/v1/config/ai-routing` and `GET /api/v1/config/wiki` endpoints (or read from existing APIs)

**Acceptance Criteria:**
- [ ] AI Routing section shows tiers and current cost
- [ ] Voice section shows Pipecat configuration
- [ ] Wiki section shows repo status and page count
- [ ] Email section shows outbound config and allowlist
- [ ] All sections handle "not configured" state gracefully

---

#### 8.4 Consolidate Settings and System Pages
**Status: PENDING**
**Requirement Refs:** PRD-UNIFIED §12.1 (Navigation Structure v2)
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify) -- remove moved sections
- `packages/web/src/pages/System.tsx` (modify) -- receive moved sections
- `packages/web/src/components/Layout.tsx` (verify) -- nav already has System entry

**Description:**
Move operational management (queues, skills) from Settings to System page. Settings retains: version/uptime, service health, configuration displays (AI, voice, wiki, email), autonomy level, triggers. System becomes the operational hub.

**Tasks:**
1. [ ] Move QueueStatusSection from Settings.tsx to System.tsx Queues tab
2. [ ] Move SkillsSection from Settings.tsx to System.tsx Skills tab
3. [ ] Clean up Settings.tsx: remaining sections are Version/Uptime, Service Health, AI Routing, Voice, Wiki, Email, Autonomy Level, Triggers
4. [ ] Verify Layout.tsx navigation: System and Settings both accessible
5. [ ] Test that all moved functionality works in new location

**Acceptance Criteria:**
- [ ] Queue management accessible in System → Queues tab
- [ ] Skill management accessible in System → Skills tab
- [ ] Settings page is cleaner with configuration-focused sections
- [ ] No broken links or missing functionality after move

---

### Phase 8 Testing Requirements

- [ ] StatusStrip, activity feed, MCP activity verified in production
- [ ] All 5 System.tsx sub-tabs render with real data
- [ ] All 4 new Settings sections display correctly
- [ ] Queue/skill management works after move to System page
- [ ] All existing tests pass
- [ ] All new code has >80% test coverage

### Phase 8 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Dashboard verified on brain.troy-davis.com
- [ ] All planned v2 features either implemented or verified
- [ ] No regressions introduced
- [ ] LAB_NOTEBOOK.md entry created
- [ ] PRD-UNIFIED feature status annotations updated

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (all) | Phase 2 (all) | Completely independent -- pipeline vs. model routing |
| Phase 1 (all) | Phase 7 (all) | Pipeline infra independent of voice/email |
| 1.1-1.2 (pipeline) | 1.3-1.6 (infra skills) | Different code paths within Phase 1 |
| 2.1-2.2 (config) | 2.4 (docker) | Config types independent of container setup |
| 3.1-3.2 (wiki setup) | 3.4 (Wiki.tsx) | Backend setup independent of frontend |
| 4.1 (scorer) | 4.2-4.3 (DM mode) | Scorer enhancement independent of DM wiring |
| 5.1 (rclone/Python) | 5.5 (API extension) | Infrastructure independent of API changes |
| 7.1-7.3 (voice) | 7.4-7.6 (email) | Completely independent feature sets |
| 8.1 (verify) | 8.3-8.4 (Settings) | Verification independent of new sections |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Ollama Gemma 4 classification quality insufficient on i7-9700 CPU | Medium | Medium | Fallback chain to T1 Haiku. 50-example validation suite (item 2.6) must pass 90% before cutover. Task stays on T1 if quality fails. |
| Gemma 4 12B q4_K_M OOM on 128GB shared system | Low | High | 16GB mem_limit in docker-compose. Monitor RSS via container-health skill. Kill/restart policy. |
| FlowProducer edge cases with concurrent flows | Low | Medium | BullMQ built-in retry handles most cases. Pipeline-health skill monitors every 6 hours. Legacy queue bridging code preserved for emergency revert. |
| Gitea instance unreachable during wiki operations | Low | Low | WikiGitService has graceful degradation. MCP wiki tools registered conditionally. Wiki-ingest failures don't fail parent pipeline flow. |
| 10K file extraction takes longer than estimated | Medium | Low | Domain-by-domain batching with progress checkpoints. Can pause/resume. DGX Spark for bulk, Ollama for smaller batches. |
| Wiki sprawl -- too many pages, index unwieldy | Medium | Medium | WIKI_SCHEMA.md strict page creation criteria. Wiki-lint flags orphans. FTS search over markdown when page count exceeds 200. |
| Auto-response posts incorrect information in channels | Medium | High | Three-phase progression (shadow → DM → threaded). Confidence threshold 0.85. 2+ corroboration required. Attribution disclaimer. Per-channel disable. |
| Pipecat voice latency exceeds 2s round-trip | Medium | Medium | Deepgram cloud STT offloads CPU-intensive processing. TTS also cloud-based. Only LLM runs against Claude API. Monitor per-turn latency. |
| Himalaya SMTP configuration issues | Low | Low | Nodemailer fallback. Email drafts preserved in DB regardless of send method. |
| LLM cost overrun during wiki construction | Medium | Low | Budget circuit breaker at $35/month. DGX Spark (free) for bulk wiki-ingest. Haiku for daily incremental. Cost-analysis skill monitors daily. |

---

## Success Metrics

- [ ] All 8 phases completed
- [ ] All acceptance criteria met across 39 work items
- [ ] Daily captures: 5+ captures/day across all inputs (existing metric maintained)
- [ ] Query response time: <5 seconds for semantic search (existing metric maintained)
- [ ] Wiki coverage: every file in raw/ has a source summary page within 30 days of batch completion
- [ ] Wiki cross-referencing: <5% orphan pages after initial ingestion
- [ ] Monthly LLM cost: <$20 soft limit under three-tier routing (down from ~$25)
- [ ] Classification quality: equivalent or better after T0 migration (90% accuracy)
- [ ] Voice conversation latency: <2s round-trip (STT + LLM + TTS)
- [ ] Auto-response accuracy: validated via shadow mode review (50+ responses reviewed before DM promotion)
- [ ] Autonomous operation: 7+ days without manual intervention
- [ ] Container count: 9 (current 9 + Ollama - voice-capture - faster-whisper)
- [ ] Test suite: 1,800+ unit tests (up from 1,569) + 95+ regression tests

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Pipeline modernization (FlowProducer DAGs) | PRD-UNIFIED §4.4, v2-F3 | 1 | 1.1, 1.2 |
| Infrastructure skills (backup, health, cost) | PRD-UNIFIED §18.8, v2-F14 | 1 | 1.3, 1.4, 1.5, 1.6 |
| Three-tier model routing | PRD-UNIFIED §7.2-7.8, F37 | 2 | 2.1-2.6 |
| Dual-client model routing | PRD-UNIFIED §7.3, v2-F4 | 2 | 2.1, 2.3 |
| Wiki layer (Karpathy pattern) | PRD-UNIFIED §5.1-5.7, v2-F2 | 3 | 3.1-3.4 |
| Wiki browser UI | PRD-UNIFIED §12.1, v2-F8 | 3 | 3.4 |
| Slack auto-response (shadow, DM, threaded) | PRD-UNIFIED §8.5, F42-F44 | 4 | 4.1-4.4 |
| Confidence scoring framework | PRD-UNIFIED §8.6, F46 | 4 | 4.1 |
| OneDrive file migration | PRD-UNIFIED §6.1, doc1-P1 | 5 | 5.1-5.5 |
| Wiki construction from files | PRD-UNIFIED §6.2-6.3, doc1-P2 | 6 | 6.1-6.4 |
| Wiki scheduled intelligence | PRD-UNIFIED §9.1-9.3, v2-F5 | 3, 6 | 3.3, 6.2 |
| Pipecat conversational voice | PRD-UNIFIED §12.4, v2-F1 | 7 | 7.1-7.3 |
| Voice conversations UI | PRD-UNIFIED §12.1, v2-F9 | 7 | 7.3 |
| Email outbound (Himalaya) | PRD-UNIFIED §18.10, v2-F13 | 7 | 7.4-7.6 |
| Email dashboard view | PRD-UNIFIED §12.1, v2-F15 | 7 | 7.6 |
| System health strip | PRD-UNIFIED §12.1, v2-F6 | 8 | 8.1 |
| Unified activity feed | PRD-UNIFIED §12.1, v2-F7 | 8 | 8.1 |
| Agent activity log | PRD-UNIFIED §12.1, v2-F10 | 8 | 8.1 |
| Enhanced System page | PRD-UNIFIED §12.1, v2-F11 | 8 | 8.2 |
| Settings expansion | PRD-UNIFIED §12.1, v2-F12 | 8 | 8.3, 8.4 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-11 14:00:00*
*Source: /create-plan command, fed by /ultra-plan Phase 1-4 analysis*
*Requirements: docs/PRD-UNIFIED.md v1.1 Unified (34,487 tokens, 52 questions resolved)*
