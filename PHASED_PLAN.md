# Phased Plan — Complete Execution of All 33 Open Items

**Generated:** 2026-04-18
**Based on:** Arch-review findings (`arch-review/reports/executive-summary.md`), carry-forward follow-ups from PR #101, and all GitHub issues open at commit `c0258bf`.
**Scope:** Every one of the 33 open GitHub issues on the board. One phase = one PR. Phases grouped into waves with thematic identity.
**Total phases:** 45 PRs + 1 issue closure (#77).
**Calendar estimate:** ~18-22 weeks of elapsed time if executed sequentially. ~11-13 weeks if selective parallelization across disjoint areas.

**One-PR discipline:** Each phase below is sized for single-PR scope (≤2 days of focused work, reviewable in ≤1 hour). Any item that exceeds that has been split into sub-phases (P02a/b/c, P04a/b, etc.) — see Cross-Phase Tracking table for all splits.

---

## Executive Summary

Three competing pressures shape this plan:

1. **Close the Go/No-Go risk items first.** Four findings from the arch review are load-bearing: cost-tracking (#102), mem_limits (#103), admin blast radius (#104), and init-schema completeness (#105). Every week the first three stay open is a week the $100-class cost incident can silently recur or a runaway container can destabilize the host.

2. **Unblock downstream work early.** #109 (cognitive memory dormant) blocks #71 tuning. #110 (drift-guard for CaptureSource) enables #119 sibling enum CHECKs. #102 cost-tracking fixes remove the justification to keep `callClaude` legacy paths, which simplifies every future skill PR.

3. **Don't stall user-visible value.** The Arc 3 batch source pipelines (#62, #66, #67, #68) are the most direct operator-value items on the board. They should not wait until all hardening is done — Wave 4 can begin in parallel with late Wave 3.

The plan orders phases by **risk-reduction first, value delivery second, and opportunistic polish last**. Each phase is scoped to be implementable in a single PR with clear acceptance criteria.

**Critical path (what must be done before anything else):**
```
P01 (infra hardening kit: mem_limits + init-schema + drift-guard)
  ↓
P02 (cost-tracking pt 1: Zod validation + callClaude removal)
  ↓
P03 (cost-tracking pt 2: estimator widening + Composio meter)
  ↓
P04 (admin reset safety rails + backup secrets redaction)
  ↓
[Go/No-Go conditions closed — rest of plan can parallelize by domain]
```

**Recommended close (no PR needed):**
- **#77 Architectural Refactor: Zero Technical Debt** — stale branch (`refactor/zero-debt-2026-04-16`, paused after Phase 3), 14+ PRs merged to main since. Resuming would require conflict-heavy rebase. Remaining scope has been absorbed into other issues. Close with pointer to Entry 078 + Entry 091.

---

## Inventory: The 33 Open Items

### By severity

| Severity | Count | Items |
|----------|-----:|-------|
| Critical | 2 | #102, #103 |
| High | 14 | #104, #105, #106, #107, #108, #109, #110, #111, #112, #113, #114, #115, #116, #118 |
| Medium | 5 | #117, #119, #121 + 2 pre-existing (#77 is enhancement, not severity-tagged) |
| Low | 2 | #120, #122 |
| Unlabeled feature | 10 | #54, #57, #60, #62, #66, #67, #68, #70, #71, #72, #73, #77 |

### By arc / milestone

| Arc / Milestone | Count | Nature |
|-----------------|------:|--------|
| Arc 0: Infrastructure | 2 | #54, + infra issues in Arc 6 |
| Arc 1: Pipeline & Intelligence | 2 | #57, #77 |
| Arc 2: Wiki & Knowledge | 2 | #60, #73 |
| Arc 3: Batch Data Sources | 4 | #62, #66, #67, #68 |
| Arc 4: Polish & Completion | 2 | #70, #71 |
| Arc 5: Hardware | 1 | #72 |
| Arc 6: Hardening (2026-04-18 arch review) | 17 | #102–#118 |
| No milestone (session follow-ups) | 4 | #119, #120, #121, #122 |

---

## Dependency Graph

Hard dependencies only (soft groupings in phase cards below):

```
                ┌────────────────────────────────┐
                │ P01 — Infra hardening kit      │
                │ (#103 mem_limits,              │
                │  #105 init-schema,             │
                │  #110 drift-guard)             │
                └──────────────────┬─────────────┘
                                   │
                ┌──────────────────┼─────────────────────────┐
                ▼                  ▼                         ▼
       ┌─────────────────┐  ┌──────────────┐         ┌──────────────┐
       │ P02 — Cost pt1  │  │ P09 — Sibling│         │ ...rest of   │
       │ (#102 Zod+      │  │ enum CHECKs  │         │ plan proceeds│
       │  callClaude +   │  │ (#119)       │         │ in parallel  │
       │  #122)          │  │              │         └──────────────┘
       └────────┬────────┘  └──────────────┘
                │
                ▼
       ┌─────────────────┐
       │ P03 — Cost pt2  │
       │ (#102 estimator,│
       │  #106 Composio) │
       └─────────────────┘


       ┌─────────────────┐
       │ P06 — Cognitive │
       │ memory producer │
       │ (#109)          │
       └────────┬────────┘
                │
                ▼
       ┌─────────────────┐
       │ P24 — Memory    │
       │ tuning (#71)    │
       │ +4 wks of data  │
       └─────────────────┘


       ┌─────────────────┐       ┌─────────────────┐
       │ P26 — Pipecat   │──────▶│ P27 — Voice     │
       │ voice soak (#54)│       │ arch decision   │
       │ 2 wk calendar   │       │ (#57)           │
       └─────────────────┘       └─────────────────┘


       ┌───────────────────────┐
       │ External-trigger:     │
       │  P35 Qdrant (#73)     │ ◄── fires at 50K embeddings
       │  P36 RTX PRO (#72)    │ ◄── fires on purchase decision
       └───────────────────────┘
```

---

## Waves & Phases

---

## WAVE 1 — Close Go/No-Go Conditions (≈1.5 weeks, 7 PRs)

**Goal:** Close the four arch-review conditions blocking a clean production posture. Each phase is a small-to-medium PR with clear, bounded scope. Recommended: ship sequentially over ~1.5 weeks; P01 unblocks all others.

---

### P01 — Infra hardening kit  ✅ Completed 2026-04-18 (PR #123)
**Scope:** #103 mem_limits + #105 init-schema.sql + #110 drift-guard for CaptureSource
**Severity:** 2 Critical + 1 High (in one PR because each is tiny + self-contained)
**Dependencies:** None
**Effort:** ~1 day

**Result:** Merged as squash `3afc0a2`. 7 implementation commits + 1 plan + 1 mode-fix. CI all green including new `validate-schema` job (validator ran end-to-end in 15-17s in CI against fresh pgvector container, asserted 23 tables + CHECK constraint). Tests: shared 283/283 (+2 new drift-guard cases), workers 948/948, no regressions. Closed #103, #105, #110. Homeserver deploy deferred (will batch with future phases). See LAB_NOTEBOOK Entry 092.

**Deliverables:**
- `docker-compose.yml`: every service has explicit `mem_limit` (1500m standard, 8GB for postgres + faster-whisper); Node services get `NODE_OPTIONS=--max-old-space-size=1200`
- `scripts/init-schema.sql`: regenerated from current Drizzle schema + all 22 migrations
- `scripts/validate-init-schema.sh`: CI check that round-trips schema against ephemeral Postgres
- `packages/shared/src/__tests__/web-type-drift.test.ts`: extended to cover `CaptureSource` literal
- `packages/web/src/components/SearchFilters.tsx`: literal array updated 6→9 values

**Acceptance:**
- [ ] `docker stats` on homeserver shows no steady-state exceedance
- [ ] Ephemeral Postgres stood up from `init-schema.sql` alone works
- [ ] Drift-guard fails if web `CaptureSource` drifts from shared

**Rollback:** `git revert` the PR. Migration 0022 stays; no data-touching changes.

---

### P02a — Zod config validation for ai-routing.yaml  ✅ Completed 2026-04-18 (PR #124)
**Scope:** #102 subset — Zod startup validation of cost fields
**Severity:** Critical
**Dependencies:** None (gates P02b/P03)
**Effort:** ~1 day

**Result:** Merged as squash `e8f7c52`. Gate 1 surfaced 5 scope drifts (most significant: `ModelTierEntrySchema` was silently stripping cost fields, so P02a also extends the schema). 6 implementation commits + 1 plan + 1 nit-fix (post-Gate-4 Opus review). Tests: shared 283→291 (+8 new validation tests), workers 948 unchanged. CI all 9 green. Captured 3 new operational rules in CLAUDE.md. Bonus fixes at merge: widened `AIClientType` to include `'openai'`+`'deepseek'` (pre-existing drift), eliminated `validateTaskRouting` double-log. Issue #102 remains open (P02b + P03 to close). See LAB_NOTEBOOK Entry 093.

**Deliverables:**
- `packages/shared/src/services/ai-config-schema.ts` (new): Zod schema validating every paid-provider tier has non-null `cost_per_1k_in` / `cost_per_1k_out`; called at `ConfigService.load()`; fail-fast on violation with actionable error
- Unit test: fixture with null cost field causes `ConfigService.load()` to throw
- CI: add a test that loads the PRODUCTION `ai-routing.yaml` as a fixture (catches drift of prod config against the schema)

**Acceptance:**
- [ ] Startup fails with null cost in paid-provider tier
- [ ] Production `ai-routing.yaml` loads clean

**Rollback:** Revert the schema + call site; config loads as before.

---

### P02b — Migrate memory-consolidation + weekly-brief through gateway; remove callClaude  ✅ Completed 2026-04-18 (PR #125)
**Scope:** #102 subset — remove callClaude fallback; both skills go through `completeByTask()`
**Severity:** Critical
**Dependencies:** P02a (Zod validation catches any mis-mapped tier before migrations land)
**Effort:** ~1-1.5 days (actual ~2 hours; scope expanded during Gate 1 — 7 call sites across 5 packages vs. planned 2)

**Result:** Merged as squash `fad793e`. Gate 1 surfaced 5 drifts (largest: 6 callClaude sites, not 2; then Gate 4 found a 7th in voice-capture that was outside the scoped grep). 7 call sites eliminated (6 workers + 1 voice-capture). Cycle 1 REQUEST_CHANGES → Cycle 2 APPROVE after fix. Tests: workers 948→960 (+12 net; +15 new tests, -3 obsolete), shared 291→277 (-14 exact from deleted `call-claude.test.ts`), voice-capture 82 unchanged. Total repo 2,633 passing. CLAUDE.md rule added. 2 pre-merge cleanup commits addressed reviewer nits I1 (orphan `modelAlias` plumbing) + I2 (`_anthropicClient` extract-entities signature). Issue #102 remains open (P03 to close). See LAB_NOTEBOOK Entry 094.

**Deliverables:**
- `packages/workers/src/skills/memory-consolidation.ts`: calls `llmGateway.completeByTask('memory_consolidation', ...)` — single-completion shape (not agent-loop like email-compose)
- `packages/workers/src/skills/weekly-brief.ts`: same pattern
- `packages/workers/src/lib/call-claude.ts`: **deleted**
- Any other skill referencing `callClaude`: migrated or gate-check at constructor
- Unit tests: both skills write `ai_audit_log` rows with correct tier_key
- Integration test: skill runs end-to-end against mocked gateway

**Acceptance:**
- [ ] `callClaude` string appears zero times in `packages/workers/src` (test fixtures OK)
- [ ] memory-consolidation + weekly-brief write audit rows
- [ ] No behavioral regression (outputs match prior versions on fixture inputs)

**Rollback:** Revert skill changes; re-add `call-claude.ts`.

---

### P02c — recordAgentCompletion final-tier plumb-through  ✅ Completed 2026-04-19 (PR #126)
**Scope:** #122 thread `finalTierKey` from runAgent result through to recordAgentCompletion
**Severity:** Low
**Dependencies:** None (additive on #101 gateway work)
**Effort:** ~4 hours (actual ~1 hour — smallest bootstrap phase)

**Result:** Merged as squash `7b8407a`. #122 cleanly closed (sole PR, full closure). ~50 net LoC across 5 files. Gate 1 PROCEEDED (5 drift checks cleared, no schema migration required). Gate 4 APPROVE first cycle (Opus clean). Tests unchanged counts: shared 277/277, workers 960/960 — 4 assertions extended existing tests rather than adding new cases. Semantic refinement: `ai_audit_log.model` for agent-loop rows now reflects the tier that actually served (not initial). 4 legacy `runAgent` callers unaffected via optional `finalTierKey?` field. See LAB_NOTEBOOK Entry 095.

**Deliverables:**
- `packages/shared/src/services/run-agent.ts`: `AgentResult` gains `finalTierKey: string` field; loop tracks which tier served the last iteration
- `packages/shared/src/services/llm-gateway.ts`: `recordAgentCompletion(taskName, tierKey, ...)` — caller passes `result.finalTierKey`
- `packages/workers/src/skills/email-compose.ts`: use `agentResult.finalTierKey` instead of `agentResolution.tierKey`
- `email-compose-fault-injection.test.ts`: updated to assert fallback tier is recorded

**Acceptance:**
- [ ] `ai_audit_log.tier_key` reflects actual serving tier after fallback (not initial)
- [ ] Updated fault-injection test green

**Rollback:** Revert the commit; audit log reverts to initial-tier recording (not incorrect, just imprecise).

---

### P03 — Cost estimator widening + config contract + Composio quota  ✅ Completed 2026-04-19 (PR #127) — **BOOTSTRAP COMPLETE**
**Scope:** #102 subset (widen `estimateTierCostUsd` + config-contract test) + #106 Composio meter
**Severity:** 1 Critical + 1 High
**Dependencies:** P02a (Zod schema)
**Effort:** ~1 day (actual ~2 hours — including 1 cycle of TS lint fix)

**Result:** Merged as squash `32b17f2`. Gate 1 cleared 5 drifts (biggest: config-contract test was redundant with P02a validator; omitted — saved implementer time). Gate 4 cycle 1 REQUEST_CHANGES on 4 TS2322 annotation errors; cycle 2 APPROVE after `5337ff4` fix. Closes #102 (fully; #106 auto-closed). `estimateTierCostUsd()` now computes real cost from tier config — `ai_audit_log.cost_usd` non-zero for Anthropic completions. `ComposioClient.execute()` guards with Redis-backed monthly counter (Pushover warn at 15K, hard-stop `ComposioQuotaExceededError` at >19K). Tests: shared 277→286 (+9 new: 3 estimator + 6 composio-quota), workers 960/960, core-api 722/722. 2 new operational rules in CLAUDE.md. See LAB_NOTEBOOK Entry 096.

**Bootstrap complete post-merge.** `bootstrap_mode` flipped to false. Normal ORCHESTRATOR.md operator-approval matrix applies from P04a onward.

**Deliverables:**
- `packages/shared/src/services/llm-gateway.ts`: `estimateTierCostUsd()` rewritten to use `config.cost_per_1k_in` / `config.cost_per_1k_out` for ALL providers (anthropic, openai, openai_compat, litellm, ollama [zero], deepseek); drop the provider-allowlist path
- New test: `config-contract.test.ts` asserts every task in `ai-routing.yaml` `task_routing` maps to a tier with non-null cost fields (via the Zod schema from P02a)
- Composio quota meter: Redis counter incremented on every `COMPOSIO_MULTI_EXECUTE_TOOL` call; Pushover alert at 15K/20K; hard-stop at 19K via middleware
- `packages/shared/src/services/composio-client.ts` (or similar): quota-guard wrapper

**Acceptance:**
- [ ] `ai_audit_log.cost_usd > 0` for every paid-provider completion
- [ ] Config-contract test green
- [ ] Redis counter increments on Composio call (verified in fixture)
- [ ] Pushover alert fires at 15K threshold

**Rollback:** Estimator revert preserves existing audit rows. Composio meter is additive — remove wrapper to revert.

---

### P04a — /admin/reset-data two-step + audit  ✅ Completed 2026-04-19 (PR #128)
**Scope:** #104 — two-step confirmation + admin_audit table + pg_dump snapshot
**Severity:** High
**Dependencies:** None
**Effort:** ~1-1.5 days (actual ~3 hours including 2 review cycles + NODE_ENV hardening)

**Result:** Merged as squash `7a2f4fb`. Gate 1 cleared 7 scope drifts (biggest: origin is `brain.troy-davis.com` not `web.troy-davis.com` per tunnel.yaml; CF header needs nginx forwarding; postgresql-client needed in core-api image). Gate 4 cycle 1 REQUEST_CHANGES on `vi.fn(async () => 'OK')` type inference (4 TS errors); cycle 2 APPROVE after fix. Pre-merge: NODE_ENV hardened to fail-closed (`development`/`test` explicit bypass; unset = production). 6 new CLAUDE.md operational rules captured. Tests: core-api 722→732 (+10 admin-reset). Closes #104. Gate 5.5 homeserver deploy deferred (A70 — batched). See LAB_NOTEBOOK Entry 097.

**Deliverables:**
- `packages/core-api/src/routes/admin.ts`: reset endpoint two-step (POST returns single-use token + 5-min TTL; second POST with token + same phrase performs wipe); `Origin`/`Referer` check matches `web.troy-davis.com`
- Pre-wipe `pg_dump` snapshot: `/backup/pre-wipe/<timestamp>.sql` before TRUNCATE; path immutable to the endpoint (write-only from container perspective)
- New migration 0023: `admin_audit` table (timestamp, actor from CF Access email header, phrase, affected tables, success/failure)
- Integration test: CSRF vector blocked by Origin check; token is single-use and expires; pg_dump ran before TRUNCATE; admin_audit row written

**Acceptance:**
- [ ] Reset endpoint is two-step and CSRF-proof
- [ ] pg_dump snapshot verified
- [ ] admin_audit row on every attempt

**Rollback:** Revert admin route + `DROP TABLE admin_audit` migration (write a 0024 reverting if data present).

---

### P04b — Backup .env.secrets redaction  ✅ Completed 2026-04-19 (PR #129)
**Scope:** #107 subset — stop leaking `.env.secrets` into backup payload
**Severity:** High
**Dependencies:** None
**Effort:** ~2 hours

**Deliverables:**
- `scripts/backup.sh`: remove or redact the line that copies `.env.secrets` into the backup dir
- Alternative: encrypt the payload with a Bitwarden-held key if redaction isn't practical
- Verify via grep on an ephemeral restore that no secret keys appear in the dump
- Optional: symmetric test for `config/` YAMLs (they don't contain secrets but verify)

**Acceptance:**
- [ ] Fresh backup has zero matches to `BWS_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.

**Rollback:** Revert `backup.sh`. No data consequence.

---

## WAVE 2 — Short-term Hardening (≈3 weeks, 11 PRs)

**Goal:** Close the remaining High-severity findings that lock in durable safety + operational posture. Several phases unblock later waves.

---

### P05 — Autonomy uniform through BaseSkill  ✅ Completed 2026-04-19 (PR #130)
**Scope:** #108 plumb `checkAutonomy('proactive')` through BaseSkill.execute() + per-skill minimum_autonomy declaration
**Severity:** High
**Dependencies:** None (can run parallel to P02-P04)
**Effort:** ~2 days

**Deliverables:**
- `packages/workers/src/skills/base-skill.ts`: `execute()` resolves `checkAutonomy(this.static.minimum_autonomy)` before running body; if current level < minimum, logs + returns `{status: 'gated'}`
- Every proactive skill declares `static minimum_autonomy: AutonomyLevel`:
  - email-compose auto-send: `advise`
  - memory-consolidation: `assist`
  - daily-sweep-skill: `assist`
  - weekly-brief: `observe` (informational, safe at all levels)
  - auto-response (slack-bot): already has the check
- Unit test per skill verifies gate behavior
- CLAUDE.md updated with actual autonomy semantics

**Acceptance:**
- [ ] All proactive skills honor autonomy gate
- [ ] Unit tests verify each skill
- [ ] CLAUDE.md accurate

**Rollback:** Revert `BaseSkill.execute()` changes; skills fall back to previous unguarded behavior.

---

### P06 — Cognitive memory producer + schedule  ✅ Completed 2026-04-19 (PR #132)
**Scope:** #109 wire Hebbian producer in search path + batch upsert + schedule pruneStaleAssociations
**Severity:** High
**Dependencies:** None
**Effort:** ~2 days
**Unblocks:** #71 (P24) after 4 weeks of data

**Deliverables:**
- `packages/core-api/src/services/search.ts` + `packages/core-api/src/mcp/tools/search-brain.ts`: on search completion, enqueue `access-stats` job with top-10 capture IDs (per D26)
- `packages/workers/src/jobs/update-access-stats.ts`: batch INSERT...VALUES 45 rows instead of 45 serial statements
- `packages/workers/src/scheduler.ts`: weekly `pruneStaleAssociations()` at 03:00 Sundays (staggered before memory-consolidation at 04:00)
- Integration test: search invocation populates `access_count` + `capture_associations`

**Acceptance:**
- [ ] Search produces access-stats jobs
- [ ] `capture_associations` populated on search
- [ ] Batch upsert is 1 statement per batch
- [ ] Weekly prune runs

**Rollback:** Revert producer wiring. No schema change (tables already exist, just stay unused as before). Prune schedule removal is trivial.

---

### P07 — Internal traffic hygiene (rate-limit + job thunderstorm)  ✅ Completed 2026-04-19 (PR #133)
**Scope:** #114 internal HTTP caller headers + #117 spread 19 scheduled jobs across the hour
**Severity:** 1 High + 1 Medium
**Dependencies:** None
**Effort:** ~4 hours

**Deliverables:**
- Every internal HTTP caller sets `X-Open-Brain-Caller` (slack-bot, voice-capture, memory-consolidation)
- `packages/core-api/src/middleware/rate-limit.ts`: BYPASS_CALLERS Set extended; each internal caller gets appropriate limit
- `config/cloudflare/nginx.conf` (or wherever the front door is): strips CLIENT-set `X-Open-Brain-Caller` headers
- `packages/workers/src/scheduler.ts`: 19 jobs spread across 06:00-09:00 window (no two on same minute); BullMQ worker concurrency: 2 per queue
- Integration test: 100 parallel internal calls succeed without 429

**Acceptance:**
- [ ] Internal callers never 429 each other under load test
- [ ] Client-set header is stripped
- [ ] `docker stats` no CPU/memory cliff at 07:00

**Rollback:** Header changes revert trivially; schedule spread can be reverted by restoring original times.

---

### P08 — Secret delivery hygiene ✅ Completed 2026-04-19 (PR #134)
**Scope:** #118 implement load-secrets.sh with BWS reconciliation
**Severity:** High
**Dependencies:** None
**Effort:** ~4 hours

**Deliverables:**
- `scripts/load-secrets.sh`: reads `bws secret list` output and writes matching keys into `.env.secrets` with correct variable names
- Checksum verification: hash of `.env.secrets` compared to expected-hash file at deploy time
- Pushover alert on mismatch
- `scripts/verify-secrets.sh`: standalone audit command (run ad-hoc)

**Acceptance:**
- [ ] `load-secrets.sh` pulls every required env var from BWS
- [ ] Checksum verification blocks deploy on drift
- [ ] Pushover alert verified via fixture

**Rollback:** Revert script; manual copy-paste pattern resumes.

---

### P09a — Sibling enum CHECKs: captures table (capture_type + pipeline_status) ✅ Completed 2026-04-19 (PR #138)
**Scope:** #119 subset — 2 columns on captures table
**Severity:** Medium
**Dependencies:** **P01** (drift-guard pattern + CHECK migration template)
**Effort:** ~3 hours

**Deliverables:**
- Pre-flight audits: `SELECT DISTINCT capture_type, COUNT(*) FROM captures`; `SELECT DISTINCT pipeline_status, COUNT(*) FROM captures`
- Migration `0024_captures_enum_checks.sql`: both CHECK constraints in one migration (same table)
- TS unions + Zod enums updated for `CaptureType` + `PipelineStatus`
- Drift-guard extended for both web literals
- Apply to homeserver + verify

**Acceptance:** 2 CHECK constraints active; drift-guard green.

**Rollback:** `ALTER TABLE captures DROP CONSTRAINT ...` on homeserver; revert commit.

---

### P09b — Sibling enum CHECKs: pipeline_events table (stage + status) ✅ Completed 2026-04-19 (PR #139)
**Scope:** #119 subset — 2 columns on pipeline_events table
**Severity:** Medium
**Dependencies:** P01
**Effort:** ~2 hours

**Deliverables:** Pre-flight + migration 0025 + TS/Zod/drift-guard updates. Same pattern as P09a.

**Acceptance:** 2 CHECK constraints active; no application logic touches these columns in user-facing filter lists, so drift-guard scope is limited to type parity only.

---

### P09c — Sibling enum CHECKs: sessions table (session_type + status) ✅ Completed 2026-04-19 (PR #140)
**Scope:** #119 subset — 2 columns on sessions table
**Severity:** Medium
**Dependencies:** P01
**Effort:** ~2 hours

**Deliverables:** Pre-flight + migration 0026 + TS/Zod updates. Governance session type literals are used in `packages/core-api/src/services/session.ts`; drift-guard scope if web surfaces these.

**Acceptance:** 2 CHECK constraints active.

---

### P10a — CI gating: integration tests  ✅ Completed 2026-04-19 (PR #141)
**Scope:** #115 subset — integration-test job in CI
**Severity:** High
**Dependencies:** None
**Effort:** ~1 day

**Deliverables:**
- `.github/workflows/ci.yml`: new `integration-test` job using `docker-compose.test.yml` — starts postgres+pgvector+redis+sidecar containers, runs `pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts`, tears down
- Starts in observe mode (not required) for first 2 PRs, then branch protection promotes to required
- Timeout + cache config tuned for Windows AND ubuntu-latest runners

**Acceptance:** Integration test job green on a fresh PR; observed stable for 2 PRs before promotion.

**Rollback:** Remove the new job.

---

### P10b — CI gating: voice-pipecat + file-ingestion pytest + test-count doc  ✅ Completed 2026-04-19 (PR #142)
**Scope:** #115 subset — Python pytest coverage in CI + README/intake updates
**Severity:** High
**Dependencies:** None
**Effort:** ~0.5 day

**Deliverables:**
- `.github/workflows/ci.yml`: voice-pipecat + file-ingestion pytest jobs added alongside existing sidecar-test (each job installs its own requirements, runs pytest under its package dir)
- README + intake updated with ACTUAL test counts (2,689 unit + 91 regression vs. claimed 1,569+95)

**Acceptance:** Both pytest jobs green; doc counts match.

**Rollback:** Trivial — remove new jobs.

---

### P11a — Observability part 1a: Loki log driver wiring  ✅ Completed 2026-04-19 (PR #143)
**Scope:** #113 subset — route all container logs to Loki
**Severity:** High
**Dependencies:** Loki must be running on homeserver (it is, per PR #76). Confirm before shipping.
**Effort:** ~1 day

**Deliverables:**
- `docker-compose.yml`: `logging: driver: loki` (or `syslog` forwarder → Loki) on every service — 14 services
- Test: run a distinctive log line from each container; verify it appears in Grafana/Loki query
- Document in CLAUDE.md: "All containers log to Loki; use Grafana for log search"

**Acceptance:** Every open-brain-* container visible in Loki within 30s of log event.

**Rollback:** Revert docker-compose logging stanzas; logs go to Docker default.

---

### P11b — Observability part 1b: Prometheus alert rules + Grafana dashboards
**Scope:** #113 subset — initial alert catalog
**Severity:** High
**Dependencies:** P11a (log driver wired first so alerts correlate with logs)
**Effort:** ~1-1.5 days

**Deliverables:**
- Alert rule files in `config/prometheus/alerts/`:
  - `budget.yml` — monthly spend > 80% → Pushover
  - `pipeline.yml` — auto-sweep failure, queue depth > 100 for >5min
  - `capture-flow.yml` — quiet > 6h between 07:00-midnight
  - `container-health.yml` — OOM kill, restart loop (>3 in 10min)
  - `integration.yml` — Composio quota > 15K (depends on P03)
- Grafana dashboard JSON updated to render each alert series
- Runbook stubs in `docs/runbooks/` (one file per alert)
- Each alert verified by staged test (synthetic trigger + confirmation Pushover fires)

**Acceptance:** 5 alert rules active and each verified firing.

**Rollback:** Remove rule files; alerts go silent.

---

## WAVE 3 — Observability IaC + Polish + Security (≈4 weeks, 9 PRs)

---

### P12 — Observability part 2: IaC consolidation
**Scope:** #113 subset (bring Prometheus/Grafana/Loki/Pushgateway into main docker-compose via profile)
**Severity:** High
**Dependencies:** P11 (Loki wired before moving it)
**Effort:** ~2-3 days

**Deliverables:**
- `docker-compose.yml`: new services `prometheus`, `grafana`, `loki`, `pushgateway` with `profiles: [observability]` so they don't run by default
- `scripts/deploy-loki.sh` → **deleted** (folded into compose)
- `scripts/post-compose-up.sh`: reduced to Gitea + Ollama network-attach only (or deleted if those also move into compose)
- `docs/runbooks/observability.md`: how to bring up the observability stack

**Acceptance:**
- [ ] `docker compose --profile observability up -d` brings up the full observability stack
- [ ] post-compose-up.sh footprint minimized
- [ ] Runbook exists

**Rollback:** Revert compose additions; prior imperative scripts still on homeserver filesystem.

---

### P13 — Search perf: LIMIT push-down + hnsw.ef_search
**Scope:** #112 — CLOSED
**Severity:** High
**Dependencies:** None
**Effort:** ~1 day
**Status:** COMPLETE — PR #144 merged `d7e8c92`, migration 0027 applied homeserver 2026-04-19

**Deliverables:**
- `packages/core-api/src/services/search.ts`: `hybrid_search` vector CTE uses `ORDER BY embedding <=> $1 LIMIT $k` (push-down)
- `config/pipeline.yaml`: new `search.hnsw_ef_search` config; `SET LOCAL hnsw.ef_search = N` per query session
- Benchmark script `scripts/benchmark-search.mjs`: runs search at N = 40/60/80/100 on current 11K corpus + synthetic 100K corpus; logs latency + recall
- LAB_NOTEBOOK entry documenting benchmark results + chosen N

**Acceptance:**
- [x] Vector CTE has LIMIT push-down
- [x] `hnsw.ef_search` explicit per session
- [x] Benchmark results in LAB_NOTEBOOK
- [x] No regression in top-N recall on current corpus

**Rollback:** Query change revert; config knob removal.

---

### P14a — Prompt-builder module + threat-model doc
**Scope:** #116 subset — foundational prompt-builder library + docs/SECURITY.md
**Severity:** High
**Dependencies:** None
**Effort:** ~1-1.5 days

**Deliverables:**
- `packages/shared/src/services/prompt-builder.ts` (new): wraps user-content in fenced delimiters (e.g., `<capture id="X">...</capture>`); strips known prompt-injection patterns (`"Ignore previous instructions"`, role-change markers, `[INST]`, `<|im_start|>`, etc.)
- Unit tests: known injection strings either stripped or escaped; delimiter uniqueness (generates session-random delimiter to defeat exact-match evasion)
- `docs/SECURITY.md` (new): threat model, current mitigations, residual risks, process for responding to a confirmed injection

**Acceptance:** prompt-builder tests pass; SECURITY.md reviewed by operator.

**Rollback:** Module removal; no call sites use it yet.

---

### P14b — Route all capture→LLM call sites through prompt-builder
**Scope:** #116 subset — migrate all user-content concatenation sites
**Severity:** High
**Dependencies:** P14a (module must exist)
**Effort:** ~1-1.5 days

**Deliverables:**
- `packages/core-api/src/services/synthesize.ts`: uses prompt-builder
- `packages/workers/src/skills/email-compose.ts`: tool outputs (capture content fetched via search_brain) wrapped
- `packages/workers/src/skills/daily-sweep-skill.ts`, `weekly-brief.ts`, `memory-consolidation.ts`: all wrap user-content
- MCP tool handlers (search_brain, get_capture, list_captures): sanitize before returning to client (defense in depth)
- Integration tests: known injection string does NOT influence LLM output (verify with a synthesized adversarial capture)

**Acceptance:** No production call site concatenates raw capture content into a prompt; adversarial-capture fixture doesn't pivot LLM output.

**Rollback:** Revert call site migrations; SECURITY.md retains the threat model for future work.

---

### P15a — Version sync script + align current drift
**Scope:** #111 subset — automation + trivial alignment
**Severity:** High
**Dependencies:** None
**Effort:** ~1 day

**Deliverables:**
- `scripts/sync-docs.sh`: reads version strings from `package.json`, `CLAUDE.md`, `README.md`, `docs/PRD.md`, `docs/TDD.md`; fails non-zero on mismatch
- `.github/workflows/ci.yml`: new `doc-sync` job runs the script
- `package.json` bumped to align with current state (1.5.0 per CLAUDE.md)
- `CHANGELOG.md` backfilled: 1.3.0 (ops+observability+wiki+email+synthetic wave), 1.4.0 (financial+utility pipelines), 1.5.0 (cognitive memory + proactive intelligence + arch-review hardening)

**Acceptance:** sync-docs.sh passes on main; CI fails on intentional mismatch.

**Rollback:** Trivial — remove script + CI job.

---

### P15b — PRD + TDD v0.7: LiteLLM scrub + architectural refresh
**Scope:** #111 subset — substantive doc rewrite
**Severity:** High
**Dependencies:** P15a (version sync in place so the new v0.7 doesn't immediately drift)
**Effort:** ~2 days

**Deliverables:**
- `docs/PRD.md` v0.7: all 198 LiteLLM references replaced with current OpenAI API + LLMGatewayService architecture; new "Architecture Evolution" section summarizing CS-α through CS-ι + Arc 6 hardening
- `docs/TDD.md` v0.7: LiteLLM references removed; new sections on cognitive memory (Hebbian/spreading activation/consolidation), autonomy levels, cost-tier routing, email pipeline, file ingestion
- Either/or: open an ADR index under `docs/adr/` pointing back at LAB_NOTEBOOK Decision Log D1-D93+

**Acceptance:** `grep -c -i "litellm" docs/PRD.md docs/TDD.md` returns 0; operator reviews and approves.

**Rollback:** Revert; docs return to v0.6 + drift.

---

### P16 — Backup restore rehearsal
**Scope:** #107 subset (weekly pg_restore rehearsal validates backups)
**Severity:** High
**Dependencies:** P04 (.env.secrets redacted before we automate this)
**Effort:** ~1 day

**Deliverables:**
- `scripts/restore-rehearsal.sh`: spins up ephemeral Postgres via `docker run`, pulls latest backup from `/mnt/user/backup/openbrain/`, runs `pg_restore`, validates row counts vs. pre-dump expected ranges, tears down
- Weekly cron entry on homeserver (Sunday 05:00, after memory-consolidation at 04:00)
- Pushover success/failure notification
- `docs/runbooks/restore-rehearsal.md`: what to do if a rehearsal fails

**Acceptance:**
- [ ] Rehearsal script passes manually
- [ ] Cron job installed on homeserver
- [ ] Pushover notification verified
- [ ] Failure test: intentionally corrupt a backup; verify rehearsal fails + alert fires

**Rollback:** Remove cron entry; script can stay in repo.

---

### P17 — Image registry (GHCR)
**Scope:** #107 subset (push images to GitHub Container Registry; homeserver deploy = `docker pull`)
**Severity:** High
**Dependencies:** None
**Effort:** ~2 days

**Deliverables:**
- `.github/workflows/build-images.yml`: on push to main, build every Docker image, tag with SHA, push to `ghcr.io/davistroy/open-brain/*`
- `docker-compose.yml`: services use `image: ghcr.io/davistroy/open-brain/<name>:<sha>` instead of `build:` (keep `build:` as fallback for local dev via `--profile local-build`)
- Homeserver deploy flow: `git pull` + `docker compose pull` + `docker compose up -d` (no `build`)
- Rollback path: `docker compose pull <specific-sha>` reverts in seconds
- `docs/runbooks/deploy.md`: updated deploy + rollback procedure

**Acceptance:**
- [ ] Every merge to main publishes tagged images to GHCR
- [ ] Homeserver deploy works without `build`
- [ ] Rollback to prior SHA tested
- [ ] Runbook exists

**Rollback:** Revert compose to `build:` directive; rebuild on homeserver as before.

---

### P18 — Dashboard & settings polish
**Scope:** #70
**Severity:** (no severity; Arc 4 feature work)
**Dependencies:** None
**Effort:** ~2 days

**Deliverables:** (depend on Troy's direction — this is UX polish)
- Likely candidates based on intake:
  - Settings page: autonomy-level selector (now that P05 actually enforces it)
  - Dashboard: surface current autonomy level + last memory-consolidation timestamp
  - Captures list: filter by source (using new 9-value drift-guarded dropdown from P09)
  - Ingest status: cleaner pending/processed/failed breakdown
  - Search UI: expose `include_related` toggle

**Acceptance:** TBD based on scope negotiation with operator.

**Rollback:** Straightforward component-level revert.

---

## WAVE 4 — Arc 3 Batch Source Pipelines (≈4-5 weeks, 6 PRs)

**Goal:** Deliver the remaining Arc 3 batch source pipelines using the established pattern (Python T0 extract → rule-based classification → CLI T2 synthesis → one capture). High user value; each PR is independently deployable.

**Recommended order** (ascending complexity + Troy-specific value):

---

### P19 — Financial account monitoring (#62)
**Scope:** Daily financial-account health-check pipeline (balances, position changes, anomaly detection)
**Dependencies:** Extends existing `financial-pipeline.py` from PR #75
**Effort:** ~2 days

**Deliverables:**
- Daily balance-diff capture
- Position-change detection (e.g., new holdings, large movements)
- Anomaly detection against trailing 30-day window
- Configurable alert thresholds in YAML

**Acceptance:** Cron-driven daily capture that summarizes changes across all tracked accounts.

**Rollback:** Disable new cron entry; existing financial pipeline unchanged.

---

### P20a — Doctor lab report PDF extraction
**Scope:** #67 subset — structured extraction from lab PDFs
**Dependencies:** None
**Effort:** ~1-1.5 days

**Deliverables:**
- `scripts/lab-report-extract.py`: PDF → structured rows (test name, value, units, reference range, abnormal flag)
- Handles Quest, LabCorp, and hospital-specific layouts (detect + route)
- Writes raw extracted rows to new table `lab_results` (migration)
- Flagging logic for out-of-range values

**Acceptance:** Upload 3 sample lab PDFs, extracted rows match manual reading.

---

### P20b — Lab report trend analysis + historical comparison
**Scope:** #67 subset — synthesis on top of P20a structured data
**Dependencies:** **P20a** (needs structured rows in DB)
**Effort:** ~1-1.5 days

**Deliverables:**
- `scripts/lab-report-synthesis.py`: pulls latest lab_results + prior N reports; T2 CLI synthesizes trend analysis
- Capture records: current state, notable changes (improvement/concern), reference-range trajectory
- Optional: alert on specific values breaching custom thresholds

**Acceptance:** Multi-report trend analysis for a fixture set of labs.

---

### P21 — Financial advisor newsletter assessment (#66)
**Scope:** Email/PDF newsletter ingestion + relevance scoring + actionable-advice extraction
**Dependencies:** None
**Effort:** ~2 days

**Deliverables:**
- Newsletter ingestion hook (email with known advisor senders triggers pipeline)
- Advisor-voice extraction (quoted vs. opinion vs. market data)
- "What changed vs. prior newsletter" diff capture
- Action items: specific recommendations with deadlines

**Acceptance:** Last 5 newsletters processed; operator validates quality of extracted actions.

---

### P22a — Insurance policy PDF extraction + coverage matrix
**Scope:** #68 subset — extract coverage data from policy documents
**Dependencies:** None
**Effort:** ~2 days

**Deliverables:**
- `scripts/insurance-policy-extract.py`: PDF → coverage tree (categories, deductibles, limits, exclusions, co-insurance, OOP-max)
- Handles health, auto, home, umbrella policy formats
- New `insurance_policies` table (migration): policy_id, provider, effective_date, coverage JSONB, extracted_at
- Structured extraction validated against a known-good policy fixture

**Acceptance:** 3 policy fixtures extracted correctly.

---

### P22b — Insurance cross-policy comparison + gap analysis
**Scope:** #68 subset — synthesis + actionable gap report
**Dependencies:** **P22a** (needs structured coverage in DB)
**Effort:** ~1-2 days

**Deliverables:**
- `scripts/insurance-gap-analysis.py`: pulls all active policies; T2 CLI synthesizes gap analysis (under-coverage, over-coverage, redundancy, missing categories)
- Capture: annual summary for policy renewal review
- Optional: triggered by any new policy upload (keeps comparison current)

**Acceptance:** Gap analysis capture for the operator's current policy set; operator validates quality.

---

## WAVE 5 — Cognitive Memory Completion (data-dependent)

### P23 — Cognitive memory tuning
**Scope:** #71 tune spreading-activation weights, temporal-decay half-life, Hebbian threshold based on real usage data
**Dependencies:** **P06** (producer wired) + **≥4 weeks of accumulated data**
**Effort:** ~1-2 days of work + 4-week calendar wait

**Deliverables:**
- Analysis script reading `capture_associations` + `access_count` distributions
- Tuned config values in `config/pipeline.yaml` (decay half-life, activation threshold, Hebbian weight decay)
- LAB_NOTEBOOK entry with before/after quality assessment

**Acceptance:** Operator validates search quality improvement (subjective but important).

---

## WAVE 6 — Voice Path Decision (scheduling-dependent)

### P24 — Pipecat voice soak test
**Scope:** #54 2-week structured soak with latency/quality metrics
**Effort:** 2 weeks calendar, manual
**Dependencies:** None (can run in parallel to other waves)

**Deliverables:** Daily conversation logs; latency distribution; quality subjective assessment; go/no-go on Pipecat as primary voice path.

---

### P25 — Voice architecture decision
**Scope:** #57 make the call based on P24 data
**Dependencies:** P24 (hard)
**Effort:** ~1 day work (write up decision + any config changes)

**Deliverables:** LAB_NOTEBOOK decision entry; config update if any; possibly close-out of voice-capture or Pipecat if one wins definitively.

---

## WAVE 7 — Wiki Completion

### P26 — Wiki construction (Karpathy pattern)
**Scope:** #60 — build out the wiki infrastructure per the planned pattern
**Severity:** Arc 2 feature
**Dependencies:** None
**Effort:** ~1 week

**Deliverables:** (Depends on plan reference in #60 body; sizing uncertain.)

---

## WAVE 8 — Opportunistic Typing Coverage (6 PRs, staged)

### P27 — voice-pipecat pyright re-enable
**Scope:** #121 fix 9 pyright errors; un-scope voice-pipecat
**Severity:** Medium
**Dependencies:** None
**Effort:** ~4-6 hours

**Deliverables:** `types-redis` stubs; Anthropic ContentBlock narrowing; pyright include uncomment; CI green.

---

### P28 — scripts/ pyright part 1: financial + utility pipelines
**Scope:** #120 subset — most-active ops scripts
**Severity:** Low
**Dependencies:** None
**Effort:** ~6 hours

**Deliverables:**
- Type hints added to `scripts/financial-pipeline.py` (3,035 LOC — god module flagged in arch review as SW-M1) and `scripts/utility-pipeline.py`
- `pyproject.toml`: add these two paths to `[tool.pyright].include`
- `pyright` clean on both; no errors on existing tests

**Acceptance:** CI `python-lint` job green with these two added to include.

**Rollback:** Remove include lines; ruff-only coverage resumes.

---

### P29 — scripts/ pyright part 2: email scripts cluster
**Scope:** #120 subset — all email-* scripts
**Severity:** Low
**Dependencies:** None
**Effort:** ~5 hours

**Deliverables:**
- Type hints on `email-pipeline.py`, `email-cleanup.py`, `email-cleanup-pass{2,4,6}.py`, `email-archive-by-year.py`, `enqueue-email-classify.mjs` (last is JS/MJS; scope TBD)
- `pyproject.toml` include extended
- pyright clean

**Acceptance:** All email scripts in include, pyright clean.

---

### P30 — scripts/ pyright part 3: file-* scripts cluster
**Scope:** #120 subset — file categorize/dedup/inventory/reorganize
**Severity:** Low
**Dependencies:** None
**Effort:** ~4 hours

**Deliverables:**
- Type hints on `file-categorize.py`, `file-dedup.py`, `file-inventory.py`, `reorganize-onedrive.py`, `dedup-and-archive.py`, `cleanup-onedrive-junk.py`, `create_reorg_sheet.py`
- pyright clean

---

### P31 — scripts/ pyright part 4: ingestion + Plaid + Deepgram
**Scope:** #120 subset — ingest/financial-data/voice
**Severity:** Low
**Dependencies:** None
**Effort:** ~4 hours

**Deliverables:**
- Type hints on `ingest-onedrive.py`, `ingest-repair.py`, `batch-wiki-ingest.py`, `plaid-link-server.py`, `deepgram-spike.py`
- pyright clean

---

### P32 — scripts/ pyright part 5: remaining scripts + final include
**Scope:** #120 final subset — mop up
**Severity:** Low
**Dependencies:** P28-P31 (lands on top of the accumulated include list)
**Effort:** ~3 hours

**Deliverables:**
- Any remaining `scripts/*.py` files not covered in P28-P31
- Final `pyproject.toml` change: drop the `exclude = ["scripts", ...]` line; scripts/ is now fully included
- pyright clean on all of scripts/
- Documentation update in CLAUDE.md: "scripts/ is fully type-checked"

**Acceptance:** `pyright` clean against full repo include path (sidecar + 3 Python packages + all scripts).

---

## WAVE 9 — External-Trigger / Deferred

### P33 — Qdrant evaluation
**Scope:** #73 evaluate Qdrant vs. pgvector at scale
**Trigger:** When `captures` row count with embeddings crosses ≥50K (currently ~11K per MEMORY)
**Dependencies:** None
**Effort:** ~1 week (benchmark + migration plan or hold)

---

### P34 — RTX PRO 2000 purchase + deployment
**Scope:** #72 hardware purchase + local T1 + local embeddings
**Trigger:** Operator purchase decision + delivery
**Effort:** ~1 week operational after delivery

---

## Close / Archive Recommendations

### Close #77 — Architectural Refactor: Zero Technical Debt
**Status:** Stale. Branch `refactor/zero-debt-2026-04-16` was paused after Phase 3 (per MEMORY). 14+ PRs have merged to main since that branch's last commit. Resuming would require an extensive conflict-laden rebase.

**Evidence remaining scope is covered elsewhere:**
- BaseSkill/LLMSkill inheritance → already landed
- Migration numbering → already standardized (0001-0022 sequential)
- `as any` cleanup → software-engineer finding confirmed 1 `as any` outside tests (done)
- Skill-execution decomposition → covered in session follow-ups (could become its own issue if needed)

**Action:** Comment on #77 citing Entry 078 + Entry 091 + this plan; close with label `wontfix` or `duplicate` depending on user preference.

---

## Cross-Phase Tracking — all 33 items mapped

| GH # | Title | Phase(s) | Wave | Severity |
|-----:|-------|----------|-----:|----------|
| 102 | Theme 1 — Cost-tracking paper tiger | P02a ✅ + P02b ✅ + P03 ✅ | 1 | Critical |
| 103 | Theme 3 — mem_limits | P01 ✅ | 1 | Critical |
| 104 | Theme 4 — /admin/reset-data blast radius | P04a ✅ | 1 | High |
| 105 | Theme 12 — init-schema.sql missing | P01 ✅ | 1 | High |
| 106 | Theme 2 — Composio quota unmetered | P03 ✅ | 1 | High |
| 107 | Theme 5 — Backup hygiene (split 3 ways) | P04b ✅ + P16 + P17 | 1, 3 | High |
| 108 | Theme 6 — Autonomy false-uniform | P05 ✅ | 2 | High |
| 109 | Theme 7 — Cognitive memory dormant | P06 ✅ | 2 | High |
| 110 | Theme 8 — Drift-guard for CaptureSource | P01 ✅ | 1 | High |
| 111 | Theme 9 — Doc drift | P15a + P15b | 3 | High |
| 112 | Theme 10 — Search perf cliff | P13 ✅ | 3 | High |
| 113 | Theme 11 — Observability (split 3 ways) | P11a ✅ + P11b + P12 | 2, 3 | High |
| 114 | Theme 13 — Rate-limit self-contention | P07 ✅ | 2 | High |
| 115 | Theme 14 — CI gating gaps | P10a ✅ + P10b ✅ | 2 | High |
| 116 | Theme 15 — Prompt injection | P14a + P14b | 3 | High |
| 117 | Theme 16 — Job thunderstorm | P07 ✅ | 2 | Medium |
| 118 | Theme 17 — load-secrets.sh stub | P08 ✅ | 2 | High |
| 119 | Sibling enum CHECKs (split by table) | P09a ✅ + P09b ✅ + P09c ✅ | 2 | Medium |
| 120 | scripts/ pyright coverage (staged) | P28 → P32 (5 PRs) | 8 | Low |
| 121 | voice-pipecat pyright re-enable | P27 | 8 | Medium |
| 122 | recordAgentCompletion final-tier | P02c ✅ | 1 | Low |
| 54 | Pipecat voice soak test | P24 | 6 | Feature |
| 57 | Voice architecture decision | P25 | 6 | Feature |
| 60 | Wiki construction | P26 | 7 | Feature |
| 62 | Financial account monitoring | P19 | 4 | Feature |
| 66 | Financial advisor newsletter | P21 | 4 | Feature |
| 67 | Doctor lab reports (split 2 ways) | P20a + P20b | 4 | Feature |
| 68 | Insurance policy analysis (split 2 ways) | P22a + P22b | 4 | Feature |
| 70 | Dashboard & settings polish | P18 | 3 | Feature |
| 71 | Cognitive memory tuning | P23 | 5 | Feature |
| 72 | RTX PRO 2000 | P34 | 9 | Hardware |
| 73 | Qdrant evaluation | P33 | 9 | Feature |
| 77 | Zero Tech Debt Refactor | **CLOSE** | — | — |

**Phase count by wave:** W1=7, W2=11, W3=9, W4=6, W5=1, W6=2, W7=1, W8=6, W9=2 → **45 PRs total**.

---

## Critical Path & Parallelization

**Serial dependency chain (cannot compress):**
```
P01 → P02a → P02b → P03
P01 → P09a / P09b / P09c (sibling CHECKs need drift-guard pattern from P01)
P06 → P23 (tuning needs data + time)
P11a → P11b (alerts after logs are wired)
P14a → P14b (prompt-builder must exist before call-site migration)
P15a → P15b (sync script before big doc rewrite)
P20a → P20b (synthesis needs structured data)
P22a → P22b (gap analysis needs coverage data)
P24 → P25 (voice decision needs soak data)
P04b → P16 (restore rehearsal meaningless until secrets aren't in backup)
```

**Parallelization opportunities (after P01 lands):**
- **Track A (Pipeline safety):** P02a ✅ → P02b ✅ → P02c ✅ → P03 ✅ → P05 ✅ → P06 ✅ → P14a → P14b
- **Track B (Infra/Ops):** P01 ✅ → P07 ✅ → P08 → P10a → P10b → P11a → P11b → P12 → P17
- **Track C (Polish + search):** P13 → P15a → P15b → P18
- **Track D (Disaster recovery):** P04a ✅ → P04b ✅ → P16
- **Track E (Features):** P19 → P20a → P20b → P21 → P22a → P22b (independent of A-D after P02/P03)
- **Track F (Voice, calendar):** P24 (operational, any time) → P25
- **Track G (Typing staged):** P27 → P28 → P29 → P30 → P31 → P32 (interleave with other tracks as filler)

With one person executing sequentially: ~18-22 weeks.
With selective parallelization (disjoint tracks): ~11-13 weeks.

---

## Calendar Estimate

| Window | Calendar | Phases | PRs in window | Cumulative issues closed |
|--------|---------:|--------|--------------:|--------------------------:|
| Week 1 | 5 days | P01, P02a, P02b, P02c, P03, P04a, P04b | 7 | 8 (Go/No-Go gate closed) |
| Weeks 2-4 | 3 weeks | P05, P06, P07, P08, P09a/b/c, P10a/b, P11a/b | 11 | 16 |
| Weeks 5-8 | 4 weeks | P12, P13, P14a/b, P15a/b, P16, P17, P18 | 9 | 24 |
| Weeks 9-12 | 4 weeks | P19, P20a/b, P21, P22a/b | 6 | 28 (Arc 3 done) |
| Weeks 13-14 | 2 weeks | P23 (may need prior data-wait), P24 parallel ops window, P25 | 3 | 30 (voice + tuning) |
| Week 15 | 1 week | P26 (wiki) | 1 | 31 |
| Weeks 16-20 | 5 weeks | P27, P28, P29, P30, P31, P32 (pyright staged, interleaved) | 6 | 37 (all typing coverage) |
| External trigger | — | P33 (Qdrant at 50K embeddings), P34 (RTX at purchase) | 2 | 33 issues + 2 triggers complete |
| — | — | Close #77 (stale refactor) | 0 code | **Backlog zero** |

**Reminders:**
- **Week 1 is the critical window.** All 4 Go/No-Go conditions must close. Block batch source work until done.
- **Memory consolidation + Hebbian data accumulation** takes 4 weeks post-P06 — don't start P23 earlier.
- **Pipecat soak (P24)** is operational, not coding; runs parallel to other work for 2 weeks.
- **Typing (P27-P32)** is filler work — can run any week in parallel with small tracks.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Week 1 (P01-P04b) slips — Go/No-Go conditions stay open | Medium | High (ongoing $100-incident risk) | Prioritize ruthlessly; skip all Wave 2+ work until Wave 1 closes |
| P06 ships but data takes > 4 weeks to become usable for P23 | Medium | Low | Accept; P23 can run any time after data accumulates; write the analysis script in advance |
| P14b prompt-injection migration breaks legitimate capture content | Low | Medium | Comprehensive regression test set; canary to 1% of captures before full rollout; feature flag |
| P12 observability IaC migration causes metric gap during cutover | Medium | Low | Dual-publish: keep old imperative deploy running during transition; tear down after 1 week of parity |
| P22 insurance policy analysis LLM cost higher than budget | Medium | Medium | After P02a/P02b/P03 land, the budget breaker actually enforces; dry-run on 1 policy first, measure, extrapolate |
| P24 Pipecat soak produces ambiguous go/no-go signal | Medium | Low | Pre-commit to a scoring rubric BEFORE starting; revisit #57 with that data + operator subjective verdict |
| P19-P22 batch sources conflict on shared pipeline infra | Low | Medium | Each pipeline self-contained under `scripts/`; any `shared` additions reviewed carefully |
| Homeserver hardware failure during any phase | Low | Critical | P16 backup rehearsal + P17 image registry dramatically reduce recovery time; prioritize BEFORE Wave 4 feature work |
| `callClaude` removal (P02b) accidentally drops a code path needed by an under-tested skill | Low | High | Exhaustive grep for `callClaude` callers + test each before deletion; keep a git tag at pre-removal SHA for 1 week |

---

## Governance: How to Track Progress

- **Update this document** as phases land: mark each phase `✅ COMPLETE <date>` with PR link
- **Update LAB_NOTEBOOK** per CLAUDE.md Rule 1 (Hypothesis + Rollback before action) + Rule 2 (log results)
- **Close GitHub issues** as phases ship (phase ↔ issue mapping in Cross-Phase Tracking table above)
- **Re-review quarterly**: after Wave 3 completes (~week 8), run a lighter `/review-arch` to check if new debt has accrued
- **Monthly 30-min retro**: which phase estimates were wrong? Adjust remaining phases accordingly.

---

## Appendix: One-PR Discipline Checklist

Every phase PR must:
- [ ] Close the GitHub issue(s) mapped to this phase (`Closes #N` in the PR body)
- [ ] Have a LAB_NOTEBOOK entry (Hypothesis + Rollback before the first commit; Results after)
- [ ] Pass CI (all current gates: build-and-test, sidecar-test, python-lint; plus integration-test after P10 lands)
- [ ] Update documentation affected (CLAUDE.md if adding operational rules; README if changing user-facing behavior)
- [ ] Include rollback notes in the PR body
- [ ] Be reviewable in under 1 hour of reading time (split if larger — see P02a/P02b/P02c/P03 split of #102 as the template)

---

## Open Issue → Phase Crosswalk (final verification)

Every one of the 33 open issues maps to at least one phase below. No issue is orphaned.

**33 issues + 45 phases + 1 close (#77) = complete coverage.**

Phases P01–P34 cover all 33 issues. Phases with letter suffixes (a/b/c) are splits of a single issue across multiple PRs. The issue is not closed until all its sub-phase PRs have merged.

---

## Orchestrator-Discovered Action Items (live tracker)

Items surfaced **during** the orchestrator pipeline that don't warrant their own phase but must not be lost. Each has a GitHub issue; status mirrored from there.

| ID | GH | Title | Surfaced during | Status | Notes |
|----|---:|-------|-----------------|--------|-------|
| A70 | [#136](https://github.com/davistroy/open-brain/issues/136) | Batch homeserver deploy for 7 queued phases (P01, P02a-c, P03, P04a, P07) | P01 onwards | ✅ closed by #136 comment — batch deploy 2026-04-19 | P04b/P05/P06/P08 added zero deploy work |
| A71 | [#137](https://github.com/davistroy/open-brain/issues/137) | `memory-consolidation` task-key rename in `ai-routing.yaml` | P02b | open — ~1h work | Suitable as filler between waves |
| A72 | — | PR body `Refs` vs `Closes` keyword discipline | P02b → strengthened P03 | resolved (rule baked into ORCHESTRATOR.md commit-message contract) | #102 was auto-closed by accidental "closes" in section header prose |
| A73 | [#131](https://github.com/davistroy/open-brain/issues/131) | P05.1 — 6 deferred proactive skills for autonomy gate | P05 | open — sub-phase candidate | May fold into P14b or get its own P05.1 sub-phase |
| A74 | [#135](https://github.com/davistroy/open-brain/issues/135) | Tighten `.gitignore` for `.env.secrets*` glob | P08 (Opus review nit) | ✅ closed — bundled with P09b PR #139 | Defense-in-depth; no runtime impact |

**Convention:** when adding a new orchestrator-discovered item, file the GH issue first, then append a row here. Include the phase that surfaced it. Strikethrough + "✅ closed by #N" when resolved (don't delete rows — preserves history).
