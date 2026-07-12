# Implementation Plan

**Generated:** 2026-07-12 18:55:00
**Based On:** arch-review/reports/remediation-analysis-2026-07-12.md (ultra-plan Phase 0–4), arch-review/reports/executive-summary.md (v5), arch-review/findings/*.md (9 domains), LAB_NOTEBOOK Entry 184/185
**Total Phases:** 8
**Estimated Total Effort:** ~4,500 LOC across ~120 files (test-heavy; ~40% is CS-F workers test catch-up)

---

## Executive Summary

This plan remediates the 2026-07-12 v5 architecture review (CONDITIONAL GO — 1 Critical, 12 unique High, ~48 Medium, ~58 Low). The review's central finding is not a design defect — pattern fit is 5/5 — but a **"configured but not armed"** operating pattern: controls that exist but are disengaged (dormant coverage gate, unset voice secret, observe-only doc-sync, unverified DR) plus dated operator actions with no forcing function. One instance already produced a live production failure (the weekly retention prune has been FK-blocked and failing since 2026-07-05).

Work is grouped into 8 change sets that address shared root causes as single cohesive units rather than isolated patches: the retention FK fix, per-table isolation, and the dead-function drop ship in one migration (CS-A); every runbook/doc-truth correction ships together with the doc-sync promotion that prevents re-drift (CS-B, CS-G); the workers test catch-up and coverage-gate arming are sequenced with a hard barrier so CI is never bricked (CS-F); and the systemic fix — a machine-surfaced operator-actions register with heartbeat reminders (CS-D) — is prioritized early because it is the forcing function that keeps the other fixes from silently regressing.

Owner decisions are pre-resolved (LAB_NOTEBOOK Entry 185): voice-pipecat :8765 stays as an explicit risk acceptance (D135, documentation-only); mobile ingress (SEC-A2) is verify-CF-Access-then-decide with both branches pre-designed; the repo flips private (RC-10); and this plan supersedes the archived A132 plan. Investigation corrected several review items — SA-5 was half-misdiagnosed, naive embedBatch wiring would regress, and `operational-followups.md` never existed — so those work items are scoped to the true gap.

---

## Plan Overview

Phases map 1:1 to the ultra-plan change sets. Ordering follows fail-fast on the live failure (CS-A first — the retention job fails again every Sunday until fixed), then documentation truth (CS-B — a booby-trapped rollback runbook is the sole Critical and must be fixed before the next deploy or incident), then the forcing function (CS-D — without it every later fix risks silent regression), then the code and test hardening (CS-C/E/F/G), then the structural 90-day work (CS-H).

**Critical path:** CS-A (retention hotfix, ships today) → CS-B (runbook safety) → CS-D (forcing function) → CS-F (test the spine, arm the gate — the longest phase). CS-C, CS-E, CS-G are largely parallel to the CS-D→CS-F spine. CS-H is deferred structural work gated on CS-F's full-stack compose and an owner CF-Access verification (U3).

**Root-cause groupings** (multiple findings → one work item): DA-1 = SW5-H3 = SA-14 → CS-A.1/A.2; #204 = SW5-H2 = PE-H1 = SA-10 → CS-E.1; #217 = PE-M3 = IA-M5 → CS-E.3; QA-1 = SW5-H1 = SA-9 = PE-M6 → CS-F.2/F.3; doc drift (PLT-C1 + PLT-H1 + PLT-H3 + SA-6 + SA-12 + QA-15-docs) → CS-B; doc-sync-observe-mode meta-cause → CS-G.5.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies | Execution Mode |
|-------|------------|------------------|-----------------|--------------|----------------|
| 1 (CS-A) | Retention integrity hotfix | Migration 0036 (FK SET NULL + drop dead fn), per-table isolation, regression test, prod verify | M (~5 files, ~250 LOC) | None | Sequential |
| 2 (CS-B) | Runbook & docs truth | deploy.md rewrite, slo-alert.md, SA-6 sweep, cleanup batch, close #226 | M (~14 files, ~400 LOC docs) | None | Sequential |
| 3 (CS-D) | Governance forcing function | OPERATOR_ACTIONS.md, secret-rotation reminders, monthly-audit surfacing, BWS token wiring | S (~5 files, ~250 LOC) | None | Sequential |
| 4 (CS-C) | Voice & edge hardening | Spool 409-as-success, proxy AbortSignal, hono bump, D135 acceptance docs | S (~7 files, ~200 LOC) | None | Sequential |
| 5 (CS-E) | Agent & runtime guardrails | runAgent budget (#204), offset cap, #217 reconciliation, SMTP timeouts, SA-5, embedBatch | L (~14 files, ~700 LOC) | None | Sequential |
| 6 (CS-F) | Test the spine, arm the gate | 4-file workers catch-up → barrier → --coverage; QA-5 fixture; email-worker CI; required-checks | L (~20 files, ~1500 LOC test) | Phase 1, 5 (rebase) | Sequential |
| 7 (CS-G) | Automation & alerting gates | build-images alert, dependabot pip/docker, alert-rules CI, doc-sync promote, backup dead-man switch, live-host session | M (~12 files, ~350 LOC) | Phase 2, 6 | Sequential |
| 8 (CS-H) | Structural (90-day) | Full-stack e2e → web tests, SEC-A2 decision + ADR-0005, response types, outbound metrics, settings split, USER dirs | L (~30 files, ~1200 LOC) | Phase 6 | Parallel |

### Execution Hints

| Phase | Model Tier | Context Budget | Notes |
|-------|------------|----------------|-------|
| All (default) | `sonnet` | Standard | Per-item Model Tier fields take precedence over this row |
| 2 (CS-B) | `sonnet` | Extended | Large doc rewrite touching 14 files; needs cross-reference between CLAUDE.md, ADRs, and runbooks |
| 5 (CS-E) | `opus` | Extended | runAgent budget design + BullMQ reconciliation are judgment-heavy, cross-cutting, affect 5 skills |
| 8 (CS-H) | `opus` | Extended | Architectural: full-stack compose, SEC-A2 ingress decision, response-contract design |

### Milestones

| Milestone | Phases | Description |
|-----------|--------|-------------|
| Go-conditions cleared | 1–4 | Retention no longer failing; rollback runbook safe; forcing function live; voice/edge hardened; repo private. Clears every v5 Go-condition. |
| Hardened & gated | 1–7 | Runtime guardrails, armed coverage gate, automation alerting, backup dead-man switch, live-host RIs closed. |
| Complete | 1–8 | Full-stack e2e + web tests, mobile ingress decided, response contracts, outbound metrics, encryption/USER hardening. |

<!-- BEGIN PHASES -->

---

## Phase 1: Retention Integrity Hotfix (CS-A)

**Estimated Complexity:** M (~5 files, ~250 LOC)
**Dependencies:** None
**Execution Mode:** Sequential

### Goals

- Stop the weekly `data-retention-prune` job from FK-failing on the `skills_log` DELETE (failing in production since 2026-07-05).
- Make the prune loop fault-isolated so one table's failure never aborts the others silently.
- Verify the two presumed production failures and clear the stuck jobs.

### Work Items

#### 1.1 Migration 0036 — briefs FK ON DELETE SET NULL + drop dead fts_search ✅ Completed 2026-07-12
**Status:** COMPLETE 2026-07-12
**Model Tier: sonnet**
**Requirement Refs:** DA-1, SW5-H3, SA-14 (arch-review v5); A135; GitHub #204 sibling
**Files Affected:**
- `packages/shared/drizzle/0036_briefs_fk_and_cleanup.sql` (create)
- `scripts/init-schema.sql` (modify — regenerated, not hand-edited)

**Description:**
The FK `briefs_source_skill_log_id_fkey` (init-schema.sql:1816, origin 0030_briefs.sql:25) has no ON DELETE action, so any brief referencing a >60d skills_log row blocks that row's deletion → SQLSTATE 23503. Briefs are never pruned, so this recurs weekly. Migration 0036 drops and re-adds the constraint with `ON DELETE SET NULL` (column is nullable; the partial unique index `WHERE source_skill_log_id IS NOT NULL` tolerates multiple NULLs — SET NULL is safe). Fold in `DROP FUNCTION IF EXISTS public.fts_search(text, integer)` (DA-7: dead — defined only in the snapshot at init-schema.sql:130-133; live functions are `fts_only_search`/`hybrid_search`, do NOT touch). Migration must be idempotent under `ON_ERROR_STOP=1` (use `DROP CONSTRAINT IF EXISTS`). After writing the SQL, run `bash scripts/regenerate-init-schema.sh` and commit both files together.

**Tasks:**
1. [ ] Write `0036_briefs_fk_and_cleanup.sql`: `ALTER TABLE briefs DROP CONSTRAINT IF EXISTS briefs_source_skill_log_id_fkey;` then `ALTER TABLE briefs ADD CONSTRAINT briefs_source_skill_log_id_fkey FOREIGN KEY (source_skill_log_id) REFERENCES skills_log(id) ON DELETE SET NULL;` then `DROP FUNCTION IF EXISTS public.fts_search(text, integer);`
2. [ ] Run `bash scripts/regenerate-init-schema.sh`; confirm clean round-trip self-verify
3. [ ] Commit `0036_*.sql` + regenerated `init-schema.sql` together

**Acceptance Criteria:**
- [ ] WHEN a brief references a skills_log row that is then deleted THEN the brief SHALL survive with `source_skill_log_id` set to NULL
- [ ] WHEN `scripts/validate-init-schema.sql` (CI two-DB parity) runs THEN it SHALL pass (snapshot == init-schema + all migrations through 0036)
- [ ] WHEN the migration is applied twice THEN the second apply SHALL NOT error (idempotent under ON_ERROR_STOP=1)
- [ ] `fts_search(text, integer)` no longer exists; `fts_only_search` and `hybrid_search` are unchanged

**Notes:**
Migration is auto-discovered by glob (migrate-manual.sh:60,109-116) — dropping the file is sufficient, no registration. Simple ALTER — no PGOPTIONS/shm workaround needed (not a parallel index build).

#### 1.2 Per-table fault isolation in pruneRetentionData ✅ Completed 2026-07-12
**Status:** COMPLETE 2026-07-12
**Model Tier: sonnet**
**Requirement Refs:** DA-1, SW5-H3, SA-14
**Depends On:** 1.1
**Files Affected:**
- `packages/workers/src/jobs/data-retention-prune.ts` (modify — loop at :74-119)
- `packages/workers/src/__tests__/data-retention-prune.test.ts` (modify)

**Description:**
Wrap each `RETENTION_POLICY` entry's DELETE + retention_audit INSERT in try/catch: record a per-table success/failure audit row, continue the loop, and throw an aggregate error at the end if any table failed (so pipeline-health's `failed>5` alert still fires — never swallow). This makes the job resilient to any single-table failure (not just the now-fixed FK), and removes the array-ordering luck that currently lets the first 4 tables prune.

**Tasks:**
1. [ ] Refactor the loop so each entry runs in try/catch; on failure, record a failure audit row (or log + Pushover) and continue
2. [ ] Accumulate failures; after the loop, throw if any occurred
3. [ ] Update the call-count assertions (test:73,168) deliberately to match the new per-table behavior
4. [ ] Add a regression test: mock db to reject ONLY the skills_log DELETE (inspect rendered SQL via PgDialect.sqlToQuery, cf. existing test:137,152); assert the other 4 tables prune + a failure is surfaced not swallowed

**Acceptance Criteria:**
- [ ] WHEN one table's DELETE throws THEN pruneRetentionData SHALL still prune the remaining tables AND record a failure for the throwing table AND throw at the end
- [ ] WHEN all tables prune successfully THEN the job SHALL complete without throwing and write one retention_audit row per table
- [ ] The `admin_audit` exclusion invariant tests (test:53-66,192-196) remain green
- [ ] `table_name` stays parameterized; identifiers stay `sql.raw()` from static config only

**Notes:**
`skills_log` is the LAST policy entry (:34) — that ordering is why the other 4 still prune today. Do not rely on it after this fix; the try/catch is the real guard.

#### 1.3 Deploy + production verification (operator)
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** DA-1, RI-A; A135
**Depends On:** 1.1, 1.2
**Files Affected:**
- `LAB_NOTEBOOK.md` (append deploy-result entry)

**Description:**
Deploy 0036 via a migrate container per CLAUDE.md homeserver mechanics (host has no psql; run migrate-manual.sh from a throwaway pgvector container on the open-brain network), then recreate workers (`--no-deps`). Verify prod state: query `retention_audit` for missing skills_log rows on 2026-07-05 and 2026-07-12; clear the ~2 stuck `data-retention-prune` failed BullMQ jobs. Resolves unknown U1.

**Tasks:**
1. [ ] Write LAB_NOTEBOOK entry BEFORE deploy (objective/hypothesis/rollback)
2. [ ] Apply migration via container; confirm `migrate-manual.sh --status` shows 0036 applied
3. [ ] `docker compose up -d --force-recreate --no-deps workers`
4. [ ] `SELECT table_name, ran_at FROM retention_audit ORDER BY ran_at DESC LIMIT 20` — confirm/note the skills_log gaps
5. [ ] Clear stuck failed jobs; confirm `skill-execution`/prune failed count below alert threshold

**Acceptance Criteria:**
- [ ] WHEN the migration is applied in prod THEN `migrate-manual.sh --status` SHALL list 0036 as applied
- [ ] WHEN the next Sunday 02:00 prune runs THEN retention_audit SHALL contain a skills_log row (no FK failure)
- [ ] The 2026-07-05/07-12 production impact is documented in LAB_NOTEBOOK (U1 resolved)

**Notes:**
This is the only work item in the plan requiring live homeserver access. Rollback: reverse migration re-adds the bare FK; revert the workers PR.

### Phase 1 Testing Requirements

- [ ] Regression test proves per-table isolation (skills_log-only failure does not abort the job)
- [ ] admin_audit exclusion invariant tests still pass
- [ ] `scripts/validate-init-schema.sql` parity check passes
- [ ] All new code has >80% coverage on changed files

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] init-schema regenerated + committed
- [ ] Production migration applied + verified
- [ ] No regressions introduced

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/data-retention-prune.test.ts` | Exit code 0 |
| Types | `pnpm --filter @open-brain/workers exec tsc --noEmit` | Exit code 0 |
| Schema parity | `bash scripts/validate-init-schema.sh` | Exit code 0 |

<!-- END DOD -->

---

## Phase 2: Runbook & Docs Truth (CS-B)

**Estimated Complexity:** M (~14 files, ~400 LOC docs)
**Dependencies:** None
**Execution Mode:** Sequential

### Goals

- Remove the empty-DB landmine from the rollback runbook (the sole Critical, PLT-C1).
- Bring every deploy/architecture doc into agreement with the post-ADR-0004 reality.
- Author the missing SLO runbook; batch the repo-hygiene cleanup.

### Work Items

#### 2.1 Rewrite deploy.md (encode Entry 183 procedure)
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-C1, PLT-H1 (arch-review v5); A134
**Files Affected:**
- `docs/runbooks/deploy.md` (modify — §§ inventory/2/3/4/5/7/8)

**Description:**
Rewrite per the investigation §-map. §5 rollback (:181-210) currently `cat >`-truncates (:192) then `rm`s (:205) the production `docker-compose.override.yml` — the file pinning postgres/redis raw binds — re-arming the ADR-0004 empty-DB landmine. Replace wholesale with Entry 183's sha-tag re-pull + GHCR digest-verified rollback anchors (LAB_NOTEBOOK :12665,:12672 — tag strings are insufficient; a slack-bot tag guess was proven wrong). Fix §8:267 false `postgres_data` volume claim (live DB is on the ADR-0004 raw bind). §4 migration step → via container (host has no psql) + fold in the config-diff gate and `--remove-orphans` prohibition (currently CLAUDE.md-only). Inventory:27-30 + §7:235-259 → external observability project, not a local profile.

**Tasks:**
1. [ ] Replace §5 with the Entry 183 procedure (record running sha- tags as anchors, digest-verify, re-pull prior sha on failure, `up -d --force-recreate --no-deps`; never touch the override)
2. [ ] Correct §8 volume claim; mark the 4 GPL containers external in inventory + §7
3. [ ] §4: container-based migration + config-diff gate + `--remove-orphans`/bare-`up -d` prohibitions
4. [ ] Add GHCR digest verification to §3

**Acceptance Criteria:**
- [ ] WHEN an operator follows the rewritten §5 THEN no step SHALL delete or truncate `docker-compose.override.yml`
- [ ] `grep -n 'cat >.*override\|rm .*override' docs/runbooks/deploy.md` returns zero hits
- [ ] deploy.md no longer references a local `--profile observability` or claims `postgres_data` holds the live DB

**Notes:**
Entry 183's deploy explicitly prohibited §5 verbatim — the safe procedure is proven; this item institutionalizes it. Do not rewrite the migration step into a different-but-still-host-psql form.

#### 2.2 observability.md, slo-alert.md, web-rollback.md
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-H1, PLT-H3, PE-L5
**Files Affected:**
- `docs/runbooks/observability.md` (modify)
- `docs/runbooks/slo-alert.md` (create)
- `docs/runbooks/web-rollback.md` (modify or delete)
- `scripts/post-compose-up.sh` (modify — header comment)

**Description:**
Rewrite observability.md to describe the external `observability` project + client-join (currently documents the retired in-repo P12 profile). Author slo-alert.md covering the 3 alerts (slo.yml:79/102/124 — api_p99/search_p99/mcp_p99) using capture-flow-alert.md as the structural template (condition table → numbered diagnosis with exact commands → per-mode mitigation → related; cross-link docs/SLO.md). Fix or delete the decayed web-rollback.md (references the sunset `web` package) + its deploy.md refs. Fix post-compose-up.sh:10-13 retired-profile header.

**Tasks:**
1. [ ] Rewrite observability.md for the external-stack topology
2. [ ] Author slo-alert.md (3 alerts, per the diagnosis hints in slo.yml:75-123)
3. [ ] Delete web-rollback.md (or rewrite for web-next); remove stale deploy.md references
4. [ ] Fix post-compose-up.sh header comment

**Acceptance Criteria:**
- [ ] WHEN an SLO latency alert fires THEN its `runbook:` annotation SHALL resolve to an existing file
- [ ] `ls docs/runbooks/slo-alert.md` succeeds
- [ ] No runbook references the deleted `web` package or a local observability profile

**Notes:**
slo-alert.md must cover all three alerts in one file, mapping each `slo:` label.

#### 2.3 SA-6 architecture-claims sweep
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SA-6, SA-12, SA-11, QA-15 (docs half)
**Files Affected:**
- `docs/TDD.md` (modify — :4035, :1918, :3837-3838)
- `docs/PRD.md` (modify — :1532, :1893, :1531)
- `README.md` (modify — :222, :35, :69-70)
- `docs/adr/ADR-0003-similarity-scan-knn.md` (modify — status)
- `CLAUDE.md` (modify — :188 coverage figure)
- `docker-compose.yml` (modify — :412-414 comment, SA-11)

**Description:**
Correct the dangerous and stale doc claims. TDD:4035/1918/3837-3838 "migrations run automatically" → mirror CLAUDE.md:32 ledger model verbatim (this is a deploy-safety hazard — an operator who believes it skips the manual migration). README:222 "17 containers"→13 + external observability; README:35 observability rows; README:69-70 v0.6→v0.7 (self-contradiction with :271-272). PRD:1532/1893 + TDD:3984 retired `--profile observability` refs. ADR-0003 status Proposed→Accepted (deployed Phase 7). PRD:1531 nonexistent "circuit breaker on external API calls" → name the real mechanisms (budget hard-stop + fallback chains + maxRetries:0). CLAUDE.md:188 "85.57%"→"81.52%" (QA-15). SA-11 compose:412-414 NEXT_PUBLIC_API_URL comment contradiction.

**Tasks:**
1. [ ] Fix all 4 TDD auto-migration claims to the ledger model (verbatim from CLAUDE.md:32)
2. [ ] Fix README container count + version refs + observability rows
3. [ ] Remove retired-profile refs from PRD/TDD; flip ADR-0003 to Accepted
4. [ ] Reword PRD:1531 circuit-breaker claim; correct CLAUDE.md coverage figure; fix compose:412-414

**Acceptance Criteria:**
- [ ] WHEN a reader consults TDD §4 on migrations THEN it SHALL describe the manual `migrate-manual.sh` ledger, not an automatic entrypoint
- [ ] README states 13 containers + external observability and both PRD/TDD refs read v0.7
- [ ] ADR-0003 status is Accepted; no doc references a `--profile observability` local stack

**Notes:**
Do NOT edit LAB_NOTEBOOK historical entries carrying "85.57%" — they are a dated audit trail. Only forward-looking docs (CLAUDE.md, CHANGELOG, IMPLEMENTATION_PLAN if it recurs) get corrected.

#### 2.4 Repo-hygiene cleanup batch
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** SEC-A7, RC-14, QA-15; GitHub #226
**Files Affected:**
- `.gitignore` (modify — add `._*`)
- `CHANGELOG.md` (modify — [Unreleased])
- `OPEN_ITEMS.md` (modify — reconcile)

**Description:**
Add `._*` (AppleDouble junk) to .gitignore. Refresh CHANGELOG [Unreleased] with everything since 2026-07-01 (ADR-0004/#231, #230, Dependabot Waves #232-234, grouped-updates config) and correct the "85.6%" figure to 81.52%. Reconcile OPEN_ITEMS.md (currently claims "Waves 3-4 remain" — false; A132 fully deployed). Close GitHub #226 with a comment citing PR #230 / commit 1710c54 and the attribution nuance (issue said core-api; fix landed in the workers daily-connections skill — same query/error/timing).

**Tasks:**
1. [ ] Add `._*` to .gitignore OS-artifacts block; `git rm --cached` the tracked `._*` files if any
2. [ ] Update CHANGELOG [Unreleased]; fix coverage figure
3. [ ] Reconcile OPEN_ITEMS.md to A132-deployed reality
4. [ ] `gh issue close 226` with the evidence comment (escalate to sonnet only if the closure needs judgment on the attribution wording)

**Acceptance Criteria:**
- [ ] WHEN `git status` runs THEN no `._*` file SHALL appear as untracked
- [ ] CHANGELOG [Unreleased] lists ADR-0004, #230, and the three Dependabot waves
- [ ] Issue #226 is closed with a comment citing 1710c54

**Notes:**
Model Tier haiku — mechanical edits from a clear spec; escalate the #226 closure comment to sonnet if attribution wording needs care.

### Phase 2 Testing Requirements

- [ ] `bash scripts/sync-docs.sh` passes (version strings consistent post-edit)
- [ ] All internal doc cross-references resolve (no dead runbook links)

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] deploy.md rollback is non-destructive
- [ ] slo-alert.md exists; observability docs match reality
- [ ] Cleanup batch done; #226 closed

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Doc sync | `bash scripts/sync-docs.sh` | Exit code 0 |
| Landmine grep | `grep -n 'cat >.*override\|rm .*override' docs/runbooks/deploy.md` | Zero matches |

<!-- END DOD -->

---

## Phase 3: Governance Forcing Function (CS-D)

**Estimated Complexity:** S (~5 files, ~250 LOC)
**Dependencies:** None
**Execution Mode:** Sequential

### Goals

- Give dated operator actions a forcing function so they stop lapsing (the RC-19 meta-cause of all four Go-conditions).
- Wire the secret-rotation staleness control's missing bootstrap credential (RC-13).

### Work Items

#### 3.1 BWS_ACCESS_TOKEN wiring (bootstrap exception)
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** RC-13
**Files Affected:**
- `deploy/.env.secrets.template` (modify)
- `docker-compose.yml` (modify — workers env)

**Description:**
`BWS_ACCESS_TOKEN` is only a comment (compose:469) and absent from the template; the secret-rotation skill (monthly, 90-day staleness Pushover) can't run `bws secret list` without it. Add it to the template as a documented, hand-populated entry and wire it into the `workers` service env. CRITICAL: it must NOT go into `scripts/lib/secrets-map.sh` REQUIRED/OPTIONAL_SECRETS — it is the bootstrap credential for BWS itself; putting it there creates a chicken-and-egg (load-secrets.sh would exit 2 refusing a partial file).

**Tasks:**
1. [ ] Add `BWS_ACCESS_TOKEN=` with an explanatory comment to `deploy/.env.secrets.template`
2. [ ] Add `BWS_ACCESS_TOKEN` to the `workers` service env in docker-compose.yml (batch into the Phase 7 compose window if a deploy is deferred)
3. [ ] Document in the OPERATOR_ACTIONS.md register (3.2) that the operator must provision it on the host

**Acceptance Criteria:**
- [ ] WHEN the workers container starts with the token set THEN the secret-rotation skill SHALL be able to run `bws secret list`
- [ ] `BWS_ACCESS_TOKEN` does NOT appear in `scripts/lib/secrets-map.sh`
- [ ] `deploy/.env.secrets.template` documents the token as a bootstrap exception

**Notes:**
Precondition for both the secret-rotation staleness alert AND the 3.3 reminder host.

#### 3.2 OPERATOR_ACTIONS.md register
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** RC-19
**Files Affected:**
- `OPERATOR_ACTIONS.md` (create)

**Description:**
Create a machine-readable, dated register (columns: ID | Action | Due | Owner | Source | Status) seeded from the live operator actions currently buried in LAB_NOTEBOOK:148: A131 (verify first scheduled offsite/rehearsal runs), voice Bearer rollout, RC-10 repo-private flip, Gmail OAuth re-consent, RI-3 provider-terms quarterly verification, postgres shm_size next-restart-window, plus this plan's own deferred operator steps. This is the surfaced register the review recommends (LAB_NOTEBOOK:148 has the right schema but no automation reads it; `operational-followups.md` never existed).

**Tasks:**
1. [ ] Create OPERATOR_ACTIONS.md with the dated table schema + seed rows
2. [ ] Add a header note: authoritative for operator/ops actions; GitHub issues remain authoritative for feature work
3. [ ] Reference it from README + OPEN_ITEMS.md

**Acceptance Criteria:**
- [ ] WHEN an operator action has a deadline THEN it SHALL appear in OPERATOR_ACTIONS.md with a Due date and Status
- [ ] The register is parseable by the 3.3 reminder skill (stable column format)

**Notes:**
Must be surfaced automatically (3.3/3.4) or it rots exactly like OPEN_ITEMS.md.

#### 3.3 secret-rotation reminder extension
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** RC-19
**Depends On:** 3.1, 3.2
**Files Affected:**
- `packages/workers/src/skills/secret-rotation.ts` (modify)
- `packages/workers/src/skills/__tests__/secret-rotation*.test.ts` (modify/create)

**Description:**
Extend the monthly secret-rotation skill (already runs on the monthly cadence, already shells to bws, already has a Pushover path) to also parse OPERATOR_ACTIONS.md and emit Pushover reminders for overdue or approaching-deadline items. Must be graceful when the file is absent (warn + skip, never fail the skill). Smallest-delta reminder host (shares the RC-13 BWS dependency).

**Tasks:**
1. [ ] Parse OPERATOR_ACTIONS.md; compute overdue/approaching items against the run date
2. [ ] Emit a Pushover summary for those items via the existing path
3. [ ] Handle missing/malformed file gracefully (log + skip)
4. [ ] Tests: overdue item triggers reminder; absent file no-ops; malformed rows skipped

**Acceptance Criteria:**
- [ ] WHEN an OPERATOR_ACTIONS.md row is past its Due date THEN the skill SHALL send a Pushover reminder naming it
- [ ] WHEN OPERATOR_ACTIONS.md is absent THEN the skill SHALL complete normally without error
- [ ] Never overrides `BaseSkill.execute()`; keeps its `minimum_autonomy` unchanged

**Notes:**
Do NOT create a new skill or cron slot — reuse the existing monthly skill (no scheduler-slots.test.ts change).

#### 3.4 monthly-audit register surfacing
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** RC-19
**Depends On:** 3.2
**Files Affected:**
- `.github/workflows/monthly-audit.yml` (modify)

**Description:**
Add a step to the monthly-audit workflow (cron 1st 10:00, already posts a Slack Block Kit summary) that renders OPERATOR_ACTIONS.md into `$GITHUB_STEP_SUMMARY` and the existing Slack block, dated. Reuses the proven Slack path + existing secret; no new secret.

**Tasks:**
1. [ ] Add a step reading OPERATOR_ACTIONS.md → GITHUB_STEP_SUMMARY
2. [ ] Append the register to the existing Slack Block Kit payload

**Acceptance Criteria:**
- [ ] WHEN monthly-audit runs THEN the workflow summary SHALL include the current operator-actions register
- [ ] Uses only the existing SLACK_BOT_TOKEN/SLACK_CHANNEL secrets

**Notes:**
Verify via `workflow_dispatch` after merge.

### Phase 3 Testing Requirements

- [ ] secret-rotation reminder unit tests (overdue / absent / malformed)
- [ ] monthly-audit workflow validated via workflow_dispatch

### Phase 3 Completion Checklist

- [ ] OPERATOR_ACTIONS.md created + seeded + referenced
- [ ] secret-rotation emits reminders
- [ ] monthly-audit surfaces the register
- [ ] BWS token wired (template + workers env)

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm --filter @open-brain/workers exec vitest run src/skills/__tests__/secret-rotation` | Exit code 0 |
| Types | `pnpm --filter @open-brain/workers exec tsc --noEmit` | Exit code 0 |

<!-- END DOD -->

---

## Phase 4: Voice & Edge Hardening (CS-C)

**Estimated Complexity:** S (~7 files, ~200 LOC)
**Dependencies:** None
**Execution Mode:** Sequential

### Goals

- Stop the voice spool 409 poison-pill (a duplicate memo retries forever).
- Bound the voice proxy upstream fetch; patch the serveStatic advisory; record the SEC-A1 risk acceptance.

### Work Items

#### 4.1 Voice spool 409-as-terminal-success
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** IA-M1
**Files Affected:**
- `packages/voice-capture/src/services/ingest.ts` (modify — :79-83)
- `packages/voice-capture/src/lib/transcript-spool.ts` (modify — retry loop)
- `packages/voice-capture/src/__tests__/*` (modify/create)

**Description:**
ingest.ts:79-83 throws on all 4xx including 409 (core-api's content-hash dedup response); the spool retains any throwing file and retries every 30 min forever. Treat 409 as terminal success — parse the 409 body, extract the existing id (tolerate a missing id — the DB-constraint path may omit it), return an IngestResult so removeSpooled runs. Mirror slack-bot's `okStatuses:[409]` pattern (core-api-client.ts:44-50,94-96,129-149). Add a max-age/max-attempts dead-letter with a Pushover alert in the retry loop for genuinely stuck non-409 files (parallels the existing corrupt-file discard at :75-78). Only 409 is safe-terminal — 400/422 stay terminal-throw but get the max-age backstop.

**Tasks:**
1. [ ] Treat 409 as success in ingest.ts (parse body, tolerate missing id)
2. [ ] Add max-age dead-letter + Pushover in transcript-spool retry loop
3. [ ] Tests: 409 → spool file deleted; other 4xx + max-age → dead-lettered with alert

**Acceptance Criteria:**
- [ ] WHEN core-api returns 409 for a spooled transcript THEN ingest SHALL treat it as success AND the spool file SHALL be deleted
- [ ] WHEN a spooled file exceeds max age/attempts THEN it SHALL be dead-lettered with a Pushover alert, not retried forever
- [ ] INT-M4 at-least-once + write-ahead durability semantics preserved

**Notes:**
Do not treat all 4xx as success — only 409 (would silently drop malformed 400/422 payloads).

#### 4.2 Voice proxy AbortSignal + hono bump
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** IA-L1, SEC-B1
**Files Affected:**
- `packages/core-api/src/routes/voice-captures.ts` (modify — :47-51)
- `packages/core-api/package.json` (modify — @hono/node-server floor)
- `packages/voice-capture/package.json` (modify — @hono/node-server floor)
- `pnpm-lock.yaml` (modify)

**Description:**
Add `signal: AbortSignal.timeout(150_000)` to the voice proxy upstream fetch (currently unbounded). Bump `@hono/node-server` floor to `^1.19.13` in both packages (GHSA-92pp-h63x-v22m serveStatic bypass — live path is core-api's Bull Board static assets). Caret already permits it — `pnpm update @hono/node-server` + re-lock.

**Tasks:**
1. [ ] Add AbortSignal.timeout to voice-captures.ts upstream fetch
2. [ ] Bump @hono/node-server floor in both package.json files
3. [ ] `pnpm install` to update lockfile; commit pnpm-lock.yaml

**Acceptance Criteria:**
- [ ] WHEN the upstream voice-capture service hangs THEN the proxy fetch SHALL abort after 150s
- [ ] `@hono/node-server` resolves to ≥1.19.13 in pnpm-lock.yaml
- [ ] pnpm-lock.yaml committed with the package.json changes

**Notes:**
150s (not the 15s convention) because voice transcription is legitimately slow; matches VOICE_MAX_UPLOAD sizing.

#### 4.3 SEC-A1 risk-acceptance documentation (D135)
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SEC-A1, SA-4; A136; D135
**Files Affected:**
- `docs/adr/ADR-0002-lan-exposure-model.md` (modify — port table)
- `docs/SECURITY.md` (modify)
- `arch-review/reports/executive-summary.md` (modify — risk-acceptance register)

**Description:**
Per owner decision (D135), voice-pipecat :8765 stays as-is — an explicit risk acceptance, not a code change. Record it: add :8765/:8766 to ADR-0002's port table with the acceptance rationale (nothing connects in prod — iOS is HTTP→:3001, mobile is batch, streaming A81 never built, soak test P24 never run; trusted-LAN posture consistent with D131/D132); note it in SECURITY.md; add a row to the arch-review risk-acceptance register. This converts an open finding into a decided acceptance so future reviews stop re-flagging it.

**Tasks:**
1. [ ] Add :8765/:8766 rows to ADR-0002 port table with acceptance rationale
2. [ ] Document in SECURITY.md
3. [ ] Add the register row (mirror the D131/D132 entries)

**Acceptance Criteria:**
- [ ] WHEN a future review inspects the pipecat port THEN ADR-0002 and SECURITY.md SHALL show a documented, dated risk acceptance (D135)
- [ ] No code or compose change is made to voice-pipecat

**Notes:**
Owner chose "leave as-is" over profile-gate/loopback/handshake. This item makes the acceptance auditable.

### Phase 4 Testing Requirements

- [ ] voice-capture suite passes (spool 409 + dead-letter)
- [ ] core-api suite passes (voice proxy)

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] Spool no longer poison-pills on 409
- [ ] hono bumped + locked
- [ ] D135 acceptance documented

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests (voice) | `pnpm --filter @open-brain/voice-capture test` | Exit code 0 |
| Tests (core-api) | `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/voice` | Exit code 0 |
| Types | `pnpm --filter @open-brain/voice-capture exec tsc --noEmit && pnpm --filter @open-brain/core-api exec tsc --noEmit` | Exit code 0 |

<!-- END DOD -->

---

## Phase 5: Agent & Runtime Guardrails (CS-E)

**Estimated Complexity:** L (~14 files, ~700 LOC)
**Dependencies:** None
**Execution Mode:** Sequential

### Goals

- Give `runAgent` a context budget so #204's token blowup cannot recur (fixes the class, not the symptom).
- Bound search pagination; reconcile orphaned repeatable jobs; add SMTP timeouts; fix the reload-validation gap; make batch embedding safe to wire.

### Work Items

#### 5.1 runAgent context budget (#204 root cause)
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** SW5-H2, PE-H1, SA-10; GitHub #204
**Files Affected:**
- `packages/shared/src/services/run-agent.ts` (modify — loop :270,:339,:395-423)
- `packages/shared/src/services/__tests__/run-agent.test.ts` (modify)
- `packages/workers/src/skills/monthly-reflection.ts` (modify — :164)

**Description:**
runAgent has no context budget — the only bound is `maxIterations` (default 10). Tool results append fully untruncated (:414-423). monthly-reflection returns up to 200 full captures/call across 5 views → the 6.5M-token blowup. Add: (1) a per-tool-result char cap (default 12KB, configurable per-call) with a truncation marker, applied at :395-419 — all 5 agent skills inherit it, protecting the two unbounded ones (monthly-reflection, wiki-ingest); (2) a cumulative input-token budget (default ~150K, per-call override) checked after accumulateUsage (:339), triggering an early stop ON AN ITERATION BOUNDARY (:270) with a synthetic "context budget exhausted — summarize now" turn — never mid-toolResults assembly; (3) skill-level defense: truncate monthly-reflection's per-capture content to 400 chars at :164 (email-compose precedent is 300). Entry 180's 120s timeout bump was the symptom patch — this is the cause.

**Tasks:**
1. [ ] Add per-tool-result char cap + truncation marker (per-call option, default 12KB)
2. [ ] Add cumulative token budget + iteration-boundary early stop with synthetic summarize turn
3. [ ] Truncate monthly-reflection per-capture content to 400 chars
4. [ ] Tests: cap truncates + marks; budget triggers early stop; existing 30 cases stay green

**Acceptance Criteria:**
- [ ] WHEN a tool returns content exceeding the per-result cap THEN runAgent SHALL truncate it and append a truncation marker
- [ ] WHEN cumulative input tokens exceed the budget THEN runAgent SHALL stop at the next iteration boundary with a summarize prompt, never mid-tool-result
- [ ] WHEN monthly-reflection runs against 200+ captures THEN total context SHALL stay bounded (no 6.5M-token blowup)
- [ ] The Anthropic-only client assertion (:238) and all 30 existing run-agent tests remain green

**Notes:**
Both knobs are per-call options with defaults — wiki-lint/email-compose (already ≤300-char items) are unaffected. Too-tight a cap degrades reflections/wiki edits; 12KB/150K are generous defaults.

#### 5.2 Search offset cap
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** PE-M1
**Files Affected:**
- `packages/core-api/src/schemas/search.ts` (modify — :12)
- `packages/core-api/src/__tests__/*` (modify — schema test)

**Description:**
`offset` has no `.max()` (search.ts:12) while `limit` is capped at 50. The route computes `match_count = offset + limit`, and the SQL CTEs scan `LIMIT match_count * 4` — so `offset=100000` materializes ~400K rows per CTE. Cap `offset: .max(450)` (bounds offset+limit ≤ 500 → match_count ≤ 500 → CTE scan ≤ 2000, comfortably above any single-user pagination depth). MCP path already safe (no offset param).

**Tasks:**
1. [ ] Add `.max(450)` to the offset schema
2. [ ] Add a test asserting offset 451 is rejected

**Acceptance Criteria:**
- [ ] WHEN a search request specifies offset > 450 THEN the API SHALL reject it with a validation error
- [ ] MCP search (no offset) is unaffected

**Notes:**
450 not 490 — 490+50 (max limit) would exceed the 500 bound.

#### 5.3 BullMQ repeatable-job reconciliation (#217)
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** PE-M3, IA-M5; GitHub #217
**Files Affected:**
- `packages/workers/src/scheduler.ts` (modify)
- `packages/workers/src/__tests__/*` (create reconciliation test)

**Description:**
Cron schedule changes leave orphaned repeatable jobs firing forever (no reconciliation exists). After all `.add({repeat})` registrations, for each of the 5 queues: build the desired set of keys from the registrations, call `getRepeatableJobs()`, and `removeRepeatableByKey()` any returned key not in the desired set. Use the legacy API (matches the `.add({repeat})` registration style — do NOT mix in the newer JobScheduler API). Run per-queue, AFTER registration (so current keys are guaranteed present), matching by exact key.

**Tasks:**
1. [ ] Build desired-key set per queue from registrations
2. [ ] getRepeatableJobs() + removeRepeatableByKey() for orphans, per queue, after registration
3. [ ] Log removals; test with a mock queue returning an orphan key

**Acceptance Criteria:**
- [ ] WHEN a cron schedule is changed and workers restart THEN the old repeatable job SHALL be removed
- [ ] WHEN reconciliation runs THEN it SHALL never remove a currently-registered repeatable
- [ ] The `const *Cron = '...'` literal declarations are preserved (scheduler-slots.test.ts regex needs ≥15)

**Notes:**
Off-by-one in key matching could delete live schedules — match by exact freshly-registered key, reconcile after registration.

#### 5.4 SMTP timeouts + SA-5 reload validation + SW5 small fixes
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** IA-L6, SA-5, SW5-L1, SW5-L2, SW5-L4, SW5-L5, SW5-L6
**Files Affected:**
- `packages/workers/src/services/email.ts` (modify — :63-71)
- `packages/shared/src/config/loader.ts` (modify — reload :115)
- `packages/workers/src/main.ts` (modify — redis listeners :162,:175)
- `packages/workers/src/jobs/skill-execution.ts` (modify — :261 hardcoded channel, :13/:41 comments)
- `packages/voice-capture/src/services/notification.ts` (modify — Pushover env)

**Description:**
Batch of small correctness fixes. (a) IA-L6: add connectionTimeout/greetingTimeout/socketTimeout: 15_000 to createTransport (repo convention). (b) SA-5 (corrected): `reload()` never runs the throwing `validateAiRoutingConfig` (load() already does at :82) — run it in reload() but COLLECT errors into ReloadResult and reject the reload keeping the old config (do NOT let reload throw — a bad hot-reload must not crash the process). (c) SW5-L1: add `.on('error')` to dedupRedis/composioMeterRedis (main.ts:162,175). (d) SW5-L2: MORNING_BRIEF_SLACK_CHANNEL unset → warn+skip, not the hardcoded DM id. (e) SW5-L4: fix stale skill-count comments (22 actual). (f) SW5-L5: unify Pushover env var names (adopt shared PUSHOVER_APP_TOKEN/USER_KEY in voice-capture, keep old as deprecated fallback one release). (g) SW5-L6: hotmail console.log → logger.

**Tasks:**
1. [ ] Add SMTP timeouts to email.ts createTransport
2. [ ] Run validateAiRoutingConfig in reload() with errors→ReloadResult (non-fatal)
3. [ ] Add redis error listeners; fix hardcoded Slack channel; fix comment counts; unify Pushover env; route hotmail log

**Acceptance Criteria:**
- [ ] WHEN an SMTP peer hangs THEN sendMail SHALL time out at 15s
- [ ] WHEN a hot config reload introduces an invalid tier/fallback THEN reload SHALL reject it into ReloadResult AND keep the old config running (not crash)
- [ ] WHEN an ad-hoc redis client errors THEN the worker SHALL log it, not crash on an unhandled error event

**Notes:**
Availability over strictness for reload() and the Slack channel — degrade gracefully, don't throw/hardcode.

#### 5.5 embedBatch safety (prerequisite for wiring)
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PE-M2
**Files Affected:**
- `packages/shared/src/services/embedding.ts` (modify — :196-232)
- `packages/workers/src/jobs/document-pipeline.ts` (modify — :302-322 inline path)
- `packages/shared/src/services/__tests__/*` (modify)

**Description:**
embedBatch (embedding.ts:196) uses NON-adaptive truncation (:200 fixed 16K slice) and is all-or-nothing (:212-232) — a chunk that adaptive truncation would rescue instead fails the whole batch. Before wiring it anywhere: add per-chunk fallback on batch failure (retry failed sub-batch via single-item `embed()` which has adaptive truncation), OR add adaptive truncation to the batch path. Then wire the inline document-pipeline path (:302-322) to batch. Do NOT restructure the production per-chunk-job fan-out (flagged out of scope — it's a queue-model change).

**Tasks:**
1. [ ] Add per-chunk fallback (or adaptive truncation) to embedBatch so one bad chunk can't fail the batch
2. [ ] Wire the inline document-pipeline embed loop to embedBatch
3. [ ] Tests: batch with one over-limit chunk still succeeds for the rest

**Acceptance Criteria:**
- [ ] WHEN one chunk in a batch exceeds the token limit THEN embedBatch SHALL still embed the other chunks (fallback or adaptive), not fail the whole batch
- [ ] The single-item `embed()` real-time path is unchanged
- [ ] Spend recording remains one row per batch

**Notes:**
This is the safety prerequisite; the production per-chunk job path already fans out — batching it is separate (flagged out).

### Phase 5 Testing Requirements

- [ ] runAgent budget + truncation tests; monthly-reflection bounded
- [ ] Offset cap + reconciliation + embedBatch-fallback tests
- [ ] shared + workers + core-api suites green; shared rebuilt before dependents typecheck

### Phase 5 Completion Checklist

- [ ] All work items complete
- [ ] #204 and #217 resolved
- [ ] shared rebuilt; all dependent packages typecheck
- [ ] No regressions

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests (shared) | `pnpm --filter @open-brain/shared test` | Exit code 0 |
| Tests (workers) | `pnpm --filter @open-brain/workers exec vitest run` | Exit code 0 |
| Tests (core-api) | `pnpm --filter @open-brain/core-api exec vitest run` | Exit code 0 |
| Types | `pnpm -r exec tsc --noEmit` | Exit code 0 |

<!-- END DOD -->

---

## Phase 6: Test the Spine, Arm the Gate (CS-F)

**Estimated Complexity:** L (~20 files, ~1500 LOC test)
**Dependencies:** Phase 1, Phase 5 (rebase — those phases add code to the workers coverage denominator)
**Execution Mode:** Sequential

### Goals

- Backfill tests for the 0%-coverage workers execution spine, then arm the dormant coverage gate — in that order, so CI is never bricked.
- Give the email-worker CI teeth before merging its Dependabot PRs; promote the schema/python required checks.

### Work Items

#### 6.1 Flake + real-sleep cleanup
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** QA-9, QA-13
**Files Affected:**
- `packages/workers/src/__tests__/drift-monitor.test.ts` (modify — :724)
- `packages/workers/src/__tests__/weekly-brief.test.ts` (modify — :261)
- `packages/core-api/src/__tests__/mcp-activity-logger.test.ts` (modify — :212,233,253,271)
- `packages/core-api/src/__tests__/voice-session-service.test.ts` (modify — :152,250)
- `packages/shared/src/services/__tests__/run-agent.test.ts` (modify — :574)

**Description:**
Two one-line flake fixes: `toBeGreaterThan(0)` → `toBeGreaterThanOrEqual(0)` on durationMs (drift-monitor:724, weekly-brief:261 — the correct form already exists at weekly-brief:634). Convert the 7 real-sleep sites to fake timers / injected clock (couples with the >=0 relaxation).

**Tasks:**
1. [ ] Fix the two `durationMs>0` assertions
2. [ ] Convert 7 real-sleep sites to fake timers (per-site, carefully — fake timers + real async DB can hang)

**Acceptance Criteria:**
- [ ] WHEN a mocked skill completes in <1ms THEN the durationMs assertion SHALL still pass
- [ ] No test uses a real `setTimeout` delay to force positive duration

**Notes:**
Convert sleep sites one at a time; back out any that hang with fake timers.

#### 6.2 Workers spine test catch-up
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-1, SW5-H1, SA-9, PE-M6
**Files Affected:**
- `packages/workers/src/__tests__/scheduler.test.ts` (create — for registerScheduledJobs)
- `packages/workers/src/__tests__/skill-execution.test.ts` (create)
- `packages/workers/src/__tests__/ingest-process.test.ts` (create)
- `packages/workers/src/__tests__/memory-consolidation-query.test.ts` (create)

**Description:**
Backfill tests for the 4 lowest-coverage files in the execution spine (deficit ~493 lines to clear the 78% floor): scheduler.ts 0/307 (mock bullmq Queue, assert each repeatable job upserts with its documented cron), skill-execution.ts 2/486 (mock Worker + 26-case switch — hardest), ingest-process.ts 0/202 (mock db+fetch; `processIngestProcessJob` is exposed for testing; imitate data-retention-prune.test.ts), memory-consolidation-query.ts 8/170 (buildClusters is pure union-find — cheap; invert the existing vi.mock in memory-consolidation.test.ts to test the real impl). Both Entry-180 production incidents lived in this band.

**Tasks:**
1. [ ] scheduler.test.ts — registerScheduledJobs (mock Queue)
2. [ ] ingest-process.test.ts (mock db+fetch, PgDialect render pattern)
3. [ ] memory-consolidation-query.test.ts (buildClusters + querySimilarPairs)
4. [ ] skill-execution.test.ts (Worker closure + dispatch switch)
5. [ ] Run `vitest run --coverage` locally; confirm ≥78% lines / ≥81% funcs

**Acceptance Criteria:**
- [ ] WHEN `pnpm --filter @open-brain/workers exec vitest run --coverage` runs THEN lines SHALL be ≥78% AND functions ≥81%
- [ ] The four per-file 100% locks remain green
- [ ] scheduler.ts, skill-execution.ts, ingest-process.ts each rise from ~0% to meaningful coverage

**Notes:**
Rebase after Phases 1 and 5 (they add lines to the denominator). skill-execution.ts may run to the high end (~1-1.5d) due to the Worker closure. This is a HARD prerequisite for 6.3.

#### 6.3 Arm the workers coverage gate (BARRIER)
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** QA-1, SW5-H1, SA-9
**Depends On:** 6.2
**Files Affected:**
- `packages/workers/package.json` (modify — test script)
- `packages/workers/vitest.config.ts` (modify — :27 stale comment)

**Description:**
ONLY after 6.2 proves local coverage ≥78%: add `--coverage` to the workers `test` script. This is a hard-ordered barrier — adding the flag while coverage is below the floor instantly reds the required `build-and-test` check and blocks every PR. Also fix the stale "Vitest 2.x feature" comment at vitest.config.ts:27 (per-file thresholds are enforced under vitest 3).

**Tasks:**
1. [ ] Verify `vitest run --coverage` is green locally (gate: do not proceed otherwise)
2. [ ] Add `--coverage` to the workers test script
3. [ ] Fix the stale config comment

**Acceptance Criteria:**
- [ ] WHEN CI runs the workers test step THEN it SHALL enforce the 78/81 coverage gate
- [ ] The `build-and-test` required check passes with the gate armed

**Notes:**
BARRIER: must not land until 6.2's local coverage run is green. Constitution: never lower the threshold to make it pass.

#### 6.4 QA-5 embedding fixture
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-5
**Files Affected:**
- `packages/core-api/src/__tests__/integration/setup.ts` (modify — :166-168)
- `packages/core-api/src/__tests__/integration/fixtures/embeddings.json` (create)

**Description:**
The integration embedding stub returns all-zero 768-d vectors, so the vector/HNSW/RRF half of hybrid search has no behavioral assertion (cosine distance is identical for every row). Generate a small fixture of real 768-d embeddings from the actual embedder (a keyed text→vector map), commit it, and return real vectors from the stub. Add 2-3 ordering assertions to an existing hybrid-search integration test.

**Tasks:**
1. [ ] Generate the fixture from the real embedder (small keyed set); commit it
2. [ ] Wire the stub to return fixture vectors
3. [ ] Add HNSW/RRF ordering assertions

**Acceptance Criteria:**
- [ ] WHEN hybrid search runs in integration tests THEN vector ranking SHALL produce a meaningful (non-degenerate) order
- [ ] Integration tests still send `X-Open-Brain-Caller: integration-test`; 768 dims preserved

**Notes:**
Fixture MUST be generated from the real embedder, not fabricated (fabricated vectors bake in false geometry).

#### 6.5 email-worker CI + Dependabot merge
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-7, SW5-L13, PE-M2 (platform); GitHub #235, #237, #238
**Files Affected:**
- `cloudflare/email-worker/src/index.ts` (modify — export pure fns)
- `cloudflare/email-worker/*.test.ts` (create)
- `cloudflare/email-worker/.npmrc` (create)
- `cloudflare/synthetic-monitor/.npmrc` (create)
- `.github/workflows/ci.yml` (modify — new email-worker job)

**Description:**
The email-worker merges Dependabot bumps (postal-mime, workers-types 4→5 major) on a CI that never compiles or runs it. Add a new ci.yml job (npm-based, outside the pnpm workspace): `npm ci && tsc --noEmit && vitest run`. Export the module-private pure functions (or test via the handler with mocked fetch/PostalMime); ~10 cases: isTransientStatus (500/499/200), isSenderAllowed (exact/@domain/case-insensitivity/reject), allowlist parse, base-URL derivation (trailing /captures and /captures/). Add `legacy-peer-deps=true` .npmrc to both cloudflare dirs (SW5-L13). THEN merge #235/#237/#238.

**Tasks:**
1. [ ] Add `.npmrc` (legacy-peer-deps) to both cloudflare dirs
2. [ ] Add email-worker vitest suite (~10 cases) + export/handler-test decision
3. [ ] Add the ci.yml email-worker job (npm ci + tsc + vitest)
4. [ ] Merge Dependabot #235/#237/#238 after the job is green

**Acceptance Criteria:**
- [ ] WHEN a PR touches cloudflare/email-worker THEN CI SHALL typecheck and run its tests
- [ ] WHEN `npm ci` runs in either cloudflare dir THEN it SHALL succeed without a manual `--legacy-peer-deps` flag
- [ ] Dependabot PRs #235/#237/#238 merge only after the new job passes

**Notes:**
Keep `X-Open-Brain-Caller: email-worker` + INT-M3 transient/permanent semantics.

#### 6.6 Promote required checks
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-4
**Depends On:** 6.5
**Files Affected:**
- (repo settings via `gh api` — no file; document in OPERATOR_ACTIONS.md + CLAUDE.md)

**Description:**
Add "Validate init-schema.sql" (ci.yml:127-128 — sole automated defense for the schema-drift class) and "Python lint & typecheck" (:146-147) to branch protection required contexts via `gh api repos/davistroy/open-brain/branches/main/protection` (Phase 5b precedent; keep enforce_admins=false, strict=false, required_pull_request_reviews=null). Confirm 2 consecutive green runs first.

**Tasks:**
1. [ ] Confirm both checks have 2 recent green runs
2. [ ] PATCH branch protection to add the two contexts
3. [ ] Record in CLAUDE.md (branch-protection rule) + OPERATOR_ACTIONS.md

**Acceptance Criteria:**
- [ ] WHEN `gh api .../branches/main/protection` is queried THEN required contexts SHALL include "Validate init-schema.sql" and "Python lint & typecheck"
- [ ] enforce_admins/strict settings are unchanged

**Notes:**
Verify the exact check-name strings match the `name:` values before adding (a mistyped context silently fails to gate).

### Phase 6 Testing Requirements

- [ ] Workers coverage ≥78/81 locally before the gate is armed
- [ ] email-worker suite + CI job green
- [ ] All existing suites remain green after new tests

### Phase 6 Completion Checklist

- [ ] Spine tests written; coverage gate armed
- [ ] Flakes + real-sleep sites fixed
- [ ] Embedding fixture in place
- [ ] email-worker CI live; Dependabot PRs merged; required checks promoted

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Coverage (workers) | `pnpm --filter @open-brain/workers exec vitest run --coverage` | ≥78% lines, ≥81% funcs |
| Tests (core-api) | `pnpm --filter @open-brain/core-api exec vitest run` | Exit code 0 |
| email-worker | `cd cloudflare/email-worker && npm ci && npx tsc --noEmit && npx vitest run` | Exit code 0 |
| Required checks | `gh api repos/davistroy/open-brain/branches/main/protection --jq '.required_status_checks.contexts'` | Contains the 4 contexts |

<!-- END DOD -->

---

## Phase 7: Automation & Alerting Gates (CS-G)

**Estimated Complexity:** M (~12 files, ~350 LOC)
**Dependencies:** Phase 2, Phase 6
**Execution Mode:** Sequential

### Goals

- Stop silent image-publish failures; extend Dependabot to the invisible ecosystems.
- Add the backup dead-man's switch; run the single live-host session that closes A131, PLT-H2, and RI-A.
- Promote doc-sync so the CS-B doc corrections can't silently re-drift.

### Work Items

#### 7.1 build-images alerting + Dependabot actions majors
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PE-M9 (platform); GitHub #239, #240, #241, #242, #236
**Files Affected:**
- `.github/workflows/build-images.yml` (modify)

**Description:**
build-images.yml has no CI gate and no failure alert — a broken merge silently leaves `:latest` stale. Add a final `if: failure()` job that curls Pushover (secret exists). Then merge the 5 GH Actions major PRs ONE AT A TIME, watching one post-merge build-images run each (#242 build-push-action 6→7 touches all 8 build steps — highest risk). Optionally add a `workflow_run` CI-success gate.

**Tasks:**
1. [ ] Add failure-notification job to build-images.yml
2. [ ] Merge #239/#240/#241/#236, then #242 — one at a time, verify each post-merge build run
3. [ ] (Optional) add workflow_run gate on CI success

**Acceptance Criteria:**
- [ ] WHEN a build-images run fails THEN a Pushover alert SHALL fire
- [ ] Each GH Actions major PR is verified against a successful post-merge build before the next merges

**Notes:**
A misconfigured workflow_run gate can silently stop all publishes — add the alert job first, gate second (optional).

#### 7.2 Dependabot pip + docker ecosystems
**Status: PENDING**
**Model Tier: haiku**
**Requirement Refs:** PE-L6 (platform)
**Files Affected:**
- `.github/dependabot.yml` (modify)

**Description:**
dependabot.yml covers only npm×3 + github-actions. Add `pip` (8 dirs: /, packages/voice-pipecat, packages/file-ingestion, docker/ingest-sidecar/tests, packages/voice-pipecat/tests, scripts, scripts/tests) and `docker` (6 Dockerfiles: /, packages/web-next, packages/voice-pipecat, packages/file-ingestion, docker/ingest-sidecar, scripts/Dockerfile.repair). Add a comment noting compose third-party pins need separate periodic manual review.

**Tasks:**
1. [ ] Add pip ecosystem blocks for the 8 directories
2. [ ] Add docker ecosystem blocks for the 6 Dockerfile locations
3. [ ] Add the compose-pins manual-review note

**Acceptance Criteria:**
- [ ] WHEN Dependabot next scans THEN it SHALL open PRs for outdated Python deps and base images
- [ ] The config parses (Dependabot validates on push)

**Notes:**
Confirm Dependabot per-directory vs `directories:` list syntax (U6).

#### 7.3 alert-rules CI + container-health + doc-sync promotion
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PE-M8, PE-M3 (platform), PE-M7, QA-10
**Files Affected:**
- `.github/workflows/ci.yml` (modify — alert-rules job, doc-sync promotion)
- `packages/workers/src/skills/container-health.ts` (modify — :53-61)

**Description:**
Add a CI job invoking `scripts/validate-alert-rules.sh` (exists, wired to nothing). Fix container-health.ts: drop the dead `litellm:4000` probe, add faster-whisper with its real health path, fix the stale web comment. Promote doc-sync per its embedded checklist (2 green runs → remove continue-on-error → add to required checks) AND note in the job comment that it is version-string-only and structurally can't catch procedure drift (the PLT-C1 class).

**Tasks:**
1. [ ] Add alert-rules validation CI job
2. [ ] Fix container-health endpoint list (drop litellm, add faster-whisper, fix comment)
3. [ ] Promote doc-sync (remove continue-on-error, add to required checks) + scope note

**Acceptance Criteria:**
- [ ] WHEN a Prometheus alert-rule file is malformed THEN CI SHALL fail
- [ ] container-health probes faster-whisper and no longer probes the dead litellm endpoint
- [ ] doc-sync is a required check with a comment documenting its version-only scope

**Notes:**
doc-sync promotion is what stops CS-B's corrections from silently re-drifting — but it only catches version skew, so the note matters.

#### 7.4 Backup dead-man's switch
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PE-H4, RC-12, SA-13; A131
**Files Affected:**
- `docker-compose.yml` (modify — workers ro-mount)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `config/prometheus/alerts/backup.yml` (create)
- `docs/runbooks/backup-alert.md` (create)

**Description:**
All backup alerting is push-on-failure from the scripts — a dead cron or unreadable `.env.secrets` in cron context produces zero signal. Add: (1) workers ro-mount `/mnt/user/backup/openbrain/latest:/backup-latest:ro`; (2) in pipeline-health, stat `/backup-latest/manifest.json`, compute age, emit `openbrain_backup_age_seconds` via the existing push-metrics (reaches pushgateway:9091 on the shared net); (3) Prometheus rule >93600s (26h) in a new backup.yml + runbook; (4) a Pushover branch in sendAlert for `backupStale` (independent of PLT-H2's unproven Prometheus delivery).

**Tasks:**
1. [ ] Add workers ro-mount (batch into the Phase 7 compose window)
2. [ ] pipeline-health: stat manifest + emit backup-age gauge
3. [ ] backup.yml rule + backup-alert.md runbook
4. [ ] Pushover branch for backupStale

**Acceptance Criteria:**
- [ ] WHEN the latest backup manifest is older than 26h THEN a Pushover alert SHALL fire (via the app-layer path, independent of Prometheus)
- [ ] `openbrain_backup_age_seconds` appears in the pushgateway payload
- [ ] The gauge push failure never breaks the pipeline-health skill (errors swallowed, per push-metrics convention)

**Notes:**
The Pushover branch is deliberate redundancy — PLT-H2's Prometheus delivery is unverified, so don't depend solely on the rule.

#### 7.5 Live-host verification session (operator)
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-H2, PLT-H4, RC-12; A131; RI-A/U4
**Files Affected:**
- `LAB_NOTEBOOK.md` (append), `OPERATOR_ACTIONS.md` (mark A131 verified)

**Description:**
One SSH session closes three RIs: (a) A131 — check offsite-backup + restore-rehearsal cron logs / Pushover history, confirm at least one scheduled run passed; (b) PLT-H2 — test WorkersMetricsAbsent delivery (briefly stop workers or fire a test rule) to prove the shared-stack alert path actually notifies; (c) confirm the CS-A retention verification if not already done in 1.3. Also batch the deferred compose changes (workers backup-mount from 7.4, BWS token from 3.1) through the two-gate config-diff procedure.

**Tasks:**
1. [ ] Verify A131 backup/rehearsal runs in logs; note in LAB_NOTEBOOK + mark register
2. [ ] Test alert delivery for a dead-workers scenario (PLT-H2)
3. [ ] Deploy the batched compose window (config-diff gate; postgres/redis untouched)

**Acceptance Criteria:**
- [ ] WHEN the workers container is stopped THEN an alert SHALL be observed delivering (PLT-H2 delivery proven or its gap documented)
- [ ] A131 scheduled-run status is confirmed and recorded
- [ ] The compose window deploy touches only the intended services (config-diff diff shows only the mount/env delta)

**Notes:**
Only work item besides 1.3 needing live homeserver access. Batch all compose changes here to minimize deploy windows.

### Phase 7 Testing Requirements

- [ ] alert-rules CI job fails on a deliberately broken rule
- [ ] backup dead-man's switch fires on a stale manifest (test with a backdated fixture)
- [ ] pipeline-health tests still green

### Phase 7 Completion Checklist

- [ ] build-images alerting live; actions majors merged + verified
- [ ] Dependabot pip/docker added
- [ ] alert-rules CI, container-health fix, doc-sync promoted
- [ ] Backup dead-man's switch deployed; live-host RIs closed

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests (workers) | `pnpm --filter @open-brain/workers exec vitest run --coverage` | ≥78/81, exit 0 |
| Alert-rules | `bash scripts/validate-alert-rules.sh` | Exit code 0 |
| Types | `pnpm --filter @open-brain/workers exec tsc --noEmit` | Exit code 0 |

<!-- END DOD -->

---

## Phase 8: Structural (90-day) (CS-H)

**Estimated Complexity:** L (~30 files, ~1200 LOC)
**Dependencies:** Phase 6 (full-stack compose enables e2e/web tests)
**Execution Mode:** Parallel

### Goals

- Bring the full-stack ingest e2e and web-next tests online (the largest untested surfaces).
- Resolve mobile ingress (SEC-A2) after verifying CF Access; add response contracts, outbound metrics, and the deferred data/security hardening.

### Work Items

#### 8.1 Full-stack e2e compose + web-next tests
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** QA-2, QA-3, QA-11
**Files Affected:**
- `docker-compose.test.yml` (modify — add test-core-api + test-workers)
- `.github/workflows/ci.yml` (modify — INGEST_E2E=1)
- `packages/web-next/vitest.config.ts` (modify — broaden include, keep .next exclusion)
- `packages/web-next/**/__tests__/*` (create — top-page component tests)
- `packages/web-next/playwright.config.ts` + smoke wiring

**Description:**
Add test-core-api + test-workers services to docker-compose.test.yml (the sidecar already targets test-core-api:3000) and set INGEST_E2E=1 (ci.yml:211-217 explicitly deferred this). Broaden web-next's vitest include glob to components (KEEP the .next exclusion), add top-page component tests (RTL+jsdom+msw — all already installed), and wire the existing Playwright smoke into CI on the full stack.

**Tasks:**
1. [ ] Add test-core-api + test-workers to docker-compose.test.yml with healthchecks
2. [ ] Enable INGEST_E2E=1 in the integration job
3. [ ] Broaden web-next vitest include; add top-page component tests
4. [ ] Wire the Playwright smoke into CI

**Acceptance Criteria:**
- [ ] WHEN the ingest e2e suite runs in CI THEN it SHALL exercise the full Capture→pipeline path against real core-api + workers
- [ ] WHEN web-next CI runs THEN it SHALL execute component tests for the top pages
- [ ] The `.next/` exclusion is preserved (no Jest-global test bleed)

**Notes:**
Reuse TEST_POSTGRES_URL/TEST_REDIS_URL gating (no new required check); healthchecks/`--wait` to avoid racing the stack.

#### 8.2 SEC-A2 mobile ingress decision + ADR-0005
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** SEC-A2 (RI); U3
**Files Affected:**
- `docs/adr/ADR-0005-mobile-ingress.md` (create)
- (Option 1) `config/cloudflare/tunnel.yaml`, `packages/mobile/src/lib/config.ts`
- (Option 2) `packages/core-api/src/middleware/mobile-auth.ts`, `packages/core-api/src/app.ts`, related tests, `scripts/lib/secrets-map.sh`, `deploy/.env.secrets.template`

**Description:**
FIRST resolve U3: verify whether the native app currently passes CF Access on brain.troy-davis.com (CF dashboard or the 7.5 live-host session). If it works WITHOUT a CF Access service token, mobile has NO auth control today → Option 1. Then execute: Option 1 = dedicated api.brain.troy-davis.com → core-api tunnel hostname + repoint mobile config + preserve CF Access + isInternalIp defense; OR Option 2 = delete the dead mobile-auth path + unwind MOBILE_API_KEY from the lockstep + simplify the mobile rate tier. Author ADR-0005 documenting the decision and the rejected alternative.

**Tasks:**
1. [ ] Verify CF Access enforcement for the native app (resolve U3)
2. [ ] Execute the chosen option
3. [ ] Author ADR-0005 (Accepted) with the rejected alternative

**Acceptance Criteria:**
- [ ] WHEN U3 is resolved THEN the plan SHALL execute the branch matching the finding (no-CF-Access → Option 1; CF-Access-enforced → Option 2 acceptable)
- [ ] Mobile ingress has a documented, effective auth control (ADR-0005)

**Notes:**
BLOCKED on U3 (High). Do not execute either branch before verifying CF Access — Option 2 without CF Access would leave mobile with no control.

#### 8.3 Response contracts + outbound metrics
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** IA-M3, IA-M4
**Files Affected:**
- `packages/shared/src/types/api-responses.ts` (create)
- `packages/slack-bot/src/lib/core-api-client.ts` (modify — :174-176,:277-280)
- `packages/shared/src/services/metrics-outbound.ts` (create)
- `packages/shared/src/services/llm-gateway.ts` (modify — :487,555,709)
- `packages/shared/src/services/embedding.ts` (modify — outbound wrap)
- `packages/core-api/src/routes/metrics.ts` (modify), `packages/workers/src/lib/push-metrics.ts` (modify)

**Description:**
IA-M3: no response zod schemas exist anywhere — author a shared response-types module and have slack-bot import it (removes the hand-maintained `items→captures` / entity-field-rename shims). Keep web-next/mobile drift tests (they deliberately don't import shared). IA-M4: add an `openbrain_outbound_request_duration_seconds{provider,operation,status_class}` histogram — 3 gateway sites cover OpenAI/openai_compat/Anthropic; add a separate wrap for embeddings (bypass the gateway); register into core-api's pull registry AND the workers pushgateway payload. No URL labels (cardinality).

**Tasks:**
1. [ ] Create shared response-types module; wire slack-bot to it
2. [ ] Create shared outbound-metrics histogram; instrument the 3 gateway sites + embeddings
3. [ ] Register into core-api metrics + workers push-metrics payload

**Acceptance Criteria:**
- [ ] WHEN core-api renames a response field THEN slack-bot SHALL fail typecheck (shared type is the single source)
- [ ] WHEN an outbound LLM/embedding call completes THEN a duration metric SHALL be recorded with {provider, operation, status_class} labels
- [ ] Labels never include URL/host (bounded cardinality)

**Notes:**
Response types cover only what the shims need first; full OpenAPI is out of scope. Workers has no prom registry — the histogram goes into the pushgateway payload there.

#### 8.4 Settings GET/PUT split + retention expansion
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** DA-2, DA-3, RC-15, DA-9
**Files Affected:**
- `packages/core-api/src/routes/settings.ts` (modify — :15-38)
- `packages/core-api/src/__tests__/settings-routes.test.ts` (modify)
- `packages/workers/src/jobs/data-retention-prune.ts` (modify — RETENTION_POLICY)
- `packages/workers/src/queues/*.ts` (modify — removeOnFail age)

**Description:**
DA-2: split VALID_SETTINGS_KEYS into READABLE_KEYS (GET, excludes the 3 OAuth token keys) and WRITABLE_KEYS (PUT) so `GET /api/v1/settings/gmail_credentials` no longer returns plaintext tokens (workers hydrate via direct Drizzle — unaffected). DA-3/RC-15: expand RETENTION_POLICY (container_health, email_classifications, voice_sessions, retention_audit self-prune, captures deleted_at>90d GATED on a backup-age precondition); move the count-based test assertions in lockstep; verify each timestamp column against init-schema. DA-9: add `age` to the ~9 count-only removeOnFail queue configs.

**Tasks:**
1. [ ] Settings GET/PUT whitelist split + tests (token keys rejected on GET)
2. [ ] Expand RETENTION_POLICY with verified columns + windows; update count assertions
3. [ ] Add removeOnFail age to the count-only queues

**Acceptance Criteria:**
- [ ] WHEN GET /api/v1/settings is called for an OAuth token key THEN it SHALL be rejected (not return plaintext)
- [ ] WHEN the retention prune runs THEN newly-added tables SHALL be pruned per their windows, and captures-purge SHALL only run when a recent backup exists
- [ ] Workers token hydration (direct Drizzle) is unaffected

**Notes:**
captures hard-purge MUST be gated on backup-age (could destroy the only copy of consolidation-originals). Builds on Phase 1's per-table isolation.

#### 8.5 Container USER directives + smaller hardening
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SEC-A6, SW5-M2, SW5-M1, SW5-L14, DA-4, SA-7, SA-8, PE-L1
**Files Affected:**
- `Dockerfile` (modify — core-api/slack-bot/workers targets), `packages/web-next/Dockerfile`, `docker/ingest-sidecar/Dockerfile`
- `packages/core-api/src/routes/*.ts` (parseUUIDParam rollout), `packages/core-api/src/middleware/rate-limit.ts` (XFF/IPv6)
- `packages/core-api/src/routes/briefs.ts` (TTS size guard), `.env.example`, `docker-compose.yml` (healthcheck)

**Description:**
Staged USER directives (SEC-A6): safe trio first (core-api/slack-bot/web-next — no writable volumes, use the built-in `node` user), then voice-capture (chown the spool dir before USER), then ingest-sidecar last (host-UID coordination for bind mounts). Plus: SW5-M2 parseUUIDParam rollout to the 28 route files (malformed :id → 400 not 500); SW5-M1 XFF rightmost-hop + tighter IPv6 regexes; SW5-L14 annotate the 5 unscoped pnpm.overrides pins; DA-4 TTS cache size guard; SA-7 web-next healthcheck → static route; SA-8 dev-portability (document `docker network create observability`, parameterize inbox paths); PE-L1 .env.example refresh.

**Tasks:**
1. [ ] USER directives staged (safe trio → voice-capture+chown → ingest-sidecar+host-UID)
2. [ ] parseUUIDParam rollout; XFF/IPv6 tightening
3. [ ] TTS size guard; healthcheck route; .env.example; override annotations; dev-portability docs

**Acceptance Criteria:**
- [ ] WHEN a container starts THEN it SHALL run as non-root (or the exception is documented)
- [ ] WHEN a malformed UUID is passed as a route :id THEN the API SHALL return 400, not a pg-22P02 500
- [ ] voice-capture spool + ingest-sidecar inbox writes still succeed after the USER change (volume/bind ownership handled)

**Notes:**
USER on voice-capture/ingest-sidecar WITHOUT pre-chowning the volume/bind breaks writes silently — order matters; ingest-sidecar last with host coordination.

### Phase 8 Testing Requirements

- [ ] Full-stack e2e green in CI; web-next component tests green
- [ ] settings GET rejects token keys; retention expansion tested
- [ ] Container USER changes verified against writable volumes/binds

### Phase 8 Completion Checklist

- [ ] All work items complete (or explicitly deferred with rationale)
- [ ] SEC-A2 decided + ADR-0005 written
- [ ] Response contracts + outbound metrics live
- [ ] Hardening staged safely

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| e2e | `INGEST_E2E=1 node scripts/test-integration.mjs` | Exit code 0 |
| Tests (all) | `pnpm -r test` | Exit code 0 |
| Types | `pnpm -r exec tsc --noEmit` | Exit code 0 |
| Web-next | `pnpm --filter @open-brain/web-next test` | Exit code 0 |

<!-- END DOD -->

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 2 (CS-B) | Phase 3, 4 | Docs-only; no code-file overlap with CS-C/CS-D |
| Phase 3 (CS-D) | Phase 2, 4 | Governance files distinct from voice/docs |
| Phase 4 (CS-C) | Phase 2, 3 | Voice/edge files distinct |
| Phase 5 (CS-E) | Phase 2, 3, 4 | Runtime code; only shares data-retention-prune with Phase 1 (Phase 1 lands first) |
| 8.1 / 8.3 / 8.4 / 8.5 | each other | Phase 8 items touch mostly disjoint files; 8.4 builds on Phase 1's retention loop |

Sequencing constraints (NOT parallel): Phase 6.3 (arm gate) after 6.2 (tests); Phase 6 after Phases 1+5 (coverage denominator); Phase 7 after Phase 6 (email-worker CI) and Phase 2 (doc-sync); compose changes (3.1, 7.4) batched into ONE gated window (7.5).

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy | Status |
|------|------------|--------|---------------------|--------|
| Arming coverage gate before tests bricks all PRs | High | High | Hard barrier: 6.3 depends on 6.2's local `--coverage` run being green; never lower the threshold | Open |
| 0036 uses CASCADE instead of SET NULL → brief data loss | Low | High | Acceptance criterion pins SET NULL; regression test verifies brief survives with NULL | Mitigated 2026-07-12 (1.1: `pg_get_constraintdef` + live insert/delete against regenerated init-schema.sql confirm `ON DELETE SET NULL`, brief row survives with NULL) |
| try/catch swallows retention errors → hides failures | Med | Med | Design records per-table failure + throws aggregate at end; alert semantics preserved | Mitigated 2026-07-12 (1.2: per-table try/catch continues the loop on failure, logs at error level, and throws one aggregate error after all entries run — rejects the BullMQ job so pipeline-health's failed-job alerting still fires; regression tests prove isolation + surfacing) |
| Voice secret set on server before clients updated → all captures 401 | Med | Med | Operator runbook order (clients first); this plan documents it, doesn't set the secret | Open |
| runAgent cap too tight → degraded reflections/wiki | Med | Med | Per-call options with generous defaults (12KB/150K); truncation marker preserves signal | Open |
| BullMQ reconciliation deletes a live schedule | Low | High | Match by exact freshly-registered key, reconcile AFTER registration | Open |
| Container USER breaks writable volume/bind silently | Med | Med | Stage: safe trio → voice-capture+chown → ingest-sidecar+host-UID last | Open |
| workflow_run gate on build-images misconfigured → stops all publishes | Low | Med | Add failure-alert job first; workflow_run gate optional/second | Open |
| Compose changes trip the ADR-0004 empty-DB landmine | Low | High | Two-gate config-diff procedure; `--no-deps`; postgres/redis never recreated (CLAUDE.md) | Open |

## Unknowns Register

| ID | Unknown | Severity | Affects | Resolution Strategy | Status |
|----|---------|----------|---------|---------------------|--------|
| U1 | Did the prod retention prune actually fail on 2026-07-05 and 2026-07-12? | High | Phase 1, Item 1.3 | Query prod retention_audit + BullMQ failed set during 1.3 deploy | Open |
| U2 | Is pushgateway host-reachable for a host-run script? | Low | Phase 7, Item 7.4 | Avoided by design — workers container mount reaches pushgateway on the shared net | Accepted |
| U3 | Does the native mobile app pass CF Access on brain.troy-davis.com without a service token? | High | Phase 8, Item 8.2 | Verify via CF dashboard or the 7.5 live-host session BEFORE executing either SEC-A2 branch | Open |
| U4 | Do WorkersMetricsAbsent/PushgatewayStale alerts actually deliver (shared-stack Alertmanager)? | Med | Phase 7, Item 7.5 | Test delivery in the live-host session (stop workers / fire test rule) | Open |
| U5 | Actual complexity of the skill-execution.ts Worker-closure test | Low | Phase 6, Item 6.2 | Time-box; may run to the ~1.5d high estimate | Open |
| U6 | Dependabot pip/docker per-directory vs `directories:` list syntax | Low | Phase 7, Item 7.2 | Confirm current Dependabot config schema before writing 8 blocks | Open |

## Success Metrics

- [ ] All phases completed
- [ ] All acceptance criteria met
- [ ] All four v5 Go-conditions cleared: retention prune succeeds weekly (DA-1), rollback runbook non-destructive (PLT-C1), voice-pipecat exposure documented as accepted (SEC-A1/D135), repo private (RC-10)
- [ ] Workers coverage gate armed and passing (≥78/81) — no dormant gates remain in the required CI path
- [ ] #204 (context blowup) and #217 (orphan repeat-jobs) closed; #226 closed
- [ ] Backup dead-man's switch fires on stale manifest; A131 verified
- [ ] Operator-actions register live with monthly heartbeat reminders (RC-19)
- [ ] Zero open Critical or High findings from the v5 review remain unaddressed or unaccepted

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| DA-1 / A135 (retention FK) | data-architect.md, exec-summary | 1 | 1.1, 1.2, 1.3 |
| DA-7 (dead fts_search) | data-architect.md | 1 | 1.1 |
| PLT-C1 / A134 (rollback landmine) | platform-engineer.md | 2 | 2.1 |
| PLT-H1/H3 (runbook drift, slo-alert) | platform-engineer.md | 2 | 2.1, 2.2 |
| SA-6/SA-12/SA-11 (doc truth) | solutions-architect.md | 2 | 2.3 |
| QA-15 (coverage figures) | qa-architect.md | 2 | 2.3, 2.4 |
| SEC-A7 / #226 (cleanup) | security-architect.md | 2 | 2.4 |
| RC-19 (operator forcing function) | risk-compliance.md, exec-summary | 3 | 3.2, 3.3, 3.4 |
| RC-13 (BWS token) | risk-compliance.md | 3 | 3.1 |
| IA-M1 (spool 409) | integration-architect.md | 4 | 4.1 |
| IA-L1 / SEC-B1 (proxy timeout, hono) | integration/security | 4 | 4.2 |
| SEC-A1 / A136 / D135 (pipecat acceptance) | security-architect.md | 4 | 4.3 |
| SW5-H2 / PE-H1 / SA-10 / #204 (runAgent) | software/performance | 5 | 5.1 |
| PE-M1 (offset cap) | performance-engineer.md | 5 | 5.2 |
| PE-M3 / IA-M5 / #217 (reconciliation) | performance/integration | 5 | 5.3 |
| IA-L6 / SA-5 / SW5-L* (small fixes) | integration/solutions/software | 5 | 5.4 |
| PE-M2 (embedBatch) | performance-engineer.md | 5 | 5.5 |
| QA-9 / QA-13 (flakes, sleeps) | qa-architect.md | 6 | 6.1 |
| QA-1 / SW5-H1 / SA-9 / PE-M6 (coverage) | qa/software/solutions/platform | 6 | 6.2, 6.3 |
| QA-5 (embedding fixture) | qa-architect.md | 6 | 6.4 |
| QA-7 / SW5-L13 (email-worker CI) | qa/software | 6 | 6.5 |
| QA-4 (required checks) | qa-architect.md | 6 | 6.6 |
| PE-M9 / PE-L6 (build-images, dependabot) | platform-engineer.md | 7 | 7.1, 7.2 |
| PE-M8 / PE-M3 / PE-M7 / QA-10 (CI gates) | platform/qa | 7 | 7.3 |
| PE-H4 / RC-12 / SA-13 / A131 (backup switch) | platform/risk/solutions | 7 | 7.4, 7.5 |
| PLT-H2 (alert delivery) | platform-engineer.md | 7 | 7.5 |
| QA-2 / QA-3 / QA-11 (e2e, web tests) | qa-architect.md | 8 | 8.1 |
| SEC-A2 (mobile ingress) | security-architect.md | 8 | 8.2 |
| IA-M3 / IA-M4 (contracts, metrics) | integration-architect.md | 8 | 8.3 |
| DA-2 / DA-3 / RC-15 / DA-9 (settings, retention) | data/risk | 8 | 8.4 |
| SEC-A6 / SW5-M1/M2 / DA-4 / SA-7/8 (hardening) | security/software/data/solutions | 8 | 8.5 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-07-12 18:55:00*
*Source: /create-plan command (fed by /ultra-plan analysis of arch-review v5)*
