# Implementation Plan — P15a: Version sync script + initial doc alignment

**Phase:** P15a
**Issue:** #111 (subset — automation + trivial alignment)
**Wave:** 3
**Severity:** High
**Dependencies:** None
**Estimated effort:** 1 day
**Generated:** 2026-04-19

---

## Scope Diff vs. PHASED_PLAN.md Card

The P15a card is accurate in its deliverables list but understates the doc-drift problem.
Several drifts identified below are larger than "trivial alignment" — they have accumulated
across CS1–CS5 (OpenAI migration), the 45-phase orchestrator cycle (P01–P07), and the
arch-review hardening. The following scope diff documents what is actually drifted.

### Scope drift items

| # | Item | Card assumption | Reality |
|---|------|-----------------|---------|
| SD-1 | `package.json` version | "bump to 1.5.0 per CLAUDE.md" | Root `package.json` is `1.2.0`; CLAUDE.md says `v1.5.0`; CHANGELOG last tagged entry is `1.2.0`; README says "Status: v1.5.0"; there is no git tag for 1.3/1.4/1.5 |
| SD-2 | PRD says LiteLLM in 80 places | "trivial alignment" | 80 `LiteLLM` refs in PRD.md covering architecture, F07/F07a feature table, product principles, health check specs, budget enforcement. P15b owns the full rewrite; P15a scope: update version header, status, document the drift in a scope note — do NOT do the full LiteLLM→OpenAI sweep here (that's P15b) |
| SD-3 | TDD says LiteLLM in 118 places | same | Same — P15a should not rewrite TDD body; header + version + doc-history are in scope |
| SD-4 | `source` values in docs | card silent | PRD (line 261) and TDD (line 219) enumerate `source` as `slack|voice|web|api|email|document` (6 values). Canonical current code has 9 values: `slack`, `voice`, `api`, `document`, `mcp`, `email`, `file`, `consolidation`, `system`. Missing: `mcp`, `file`, `consolidation`, `system` in both docs. TDD line 1310 explicitly says "source values: slack | voice | api | document (not web | email)" — this contradicts both the Zod enum (line 2148) and reality. |
| SD-5 | Budget numbers | card silent | PRD (line 832) and TDD say soft $30 / hard $50 circuit breaker. CLAUDE.md current budget table says API budget < $35/month total. `ai-routing.yaml` has a `budget` section. These numbers reflect the original LiteLLM budget design, not the current split (OpenAI embeddings < $10, Anthropic API < $10, other < $10, total < $35 beyond subscription). Docs should note current budget architecture. |
| SD-6 | CHANGELOG `[Unreleased]` block | card says "backfill 1.3.0/1.4.0/1.5.0" | Correct — the Unreleased block has CS1–CS5 + OpenAI migration changes that never got tagged. Need 3 new version entries. |
| SD-7 | `scripts/sync-docs.sh` | new script needed | Does not exist. CI `doc-sync` job does not exist in `.github/workflows/ci.yml`. |
| SD-8 | TDD version in doc header | TDD header says v0.6, `Last Updated: 2026-03-10` | TDD version string and last-updated need bumping to reflect arch-review sync even without the full LiteLLM scrub (P15b does that). Leave major version bump (0.7) for P15b; bump minor marker only or add a doc-history entry. |
| SD-9 | PRD version in doc header | PRD header says v0.6, date 2026-03-05, `Status: Draft — Architectural Review v2 Applied` | Same — add a doc history entry noting P15a alignment pass. Leave 0.7 for P15b. |
| SD-10 | README TDD ref | README line 258 says `docs/TDD.md` is `v0.5` | README actually points to TDD v0.6 but displays `v0.5` in the reference table. Minor fix. |

**Operator guidance on SD-2/SD-3:** The card anticipated P15a would be "trivial alignment" — the LiteLLM reference count makes a full-sweep impossible in one day. This plan splits cleanly: P15a = version strings + source enum + CHANGELOG + sync script + CI job + doc-history entries; P15b = full LiteLLM→OpenAI body rewrite. This matches the original PHASED_PLAN card split (`P15a` → "automation + trivial alignment"; `P15b` → "LiteLLM scrub + architectural refresh").

---

## Deliverables

### 1. `scripts/sync-docs.sh` (new)

Version-sync validation script. Reads version strings from the four authoritative surfaces and
fails non-zero on mismatch.

**File:** `scripts/sync-docs.sh`

**Logic:**
```
# 1. Extract root package.json version
PACKAGE_VERSION=$(node -p "require('./package.json').version")

# 2. Extract PRD version from header line: "**Version**: X.Y.Z"
PRD_VERSION=$(grep -m1 '^[*][*]Version[*][*]:' docs/PRD.md | sed 's/.*: //' | tr -d '[:space:]')

# 3. Extract README version — look for "v1." pattern in the Status section
README_VERSION=$(grep -m1 'Status:.*v[0-9]' README.md | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | tr -d 'v')

# 4. Extract CHANGELOG latest released version (first "## [X.Y.Z]" line)
CHANGELOG_VERSION=$(grep -m1 '^## \[[0-9]' CHANGELOG.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

# 5. Compare all four — fail non-zero if any diverge
# Print which surfaces disagree on failure
```

**Behavior:**
- Exits 0 if all four match
- Exits 1 with a human-readable diff table if any diverge
- Does NOT check TDD version (TDD version is a doc-internal string, not the software version)
- Usable both in CI and locally: `bash scripts/sync-docs.sh`

**Limitations this PR does not add:**
- Does not cross-check CLAUDE.md (CLAUDE.md is operational notes, not a semver surface)
- Does not parse sub-package `package.json` files (all are `0.1.0` by design; root is the product version)

---

### 2. `.github/workflows/ci.yml` — new `doc-sync` job

Add a lightweight job after the existing jobs:

```yaml
doc-sync:
  name: Doc version sync check
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v5
    - name: Check version strings agree
      run: bash scripts/sync-docs.sh
```

**Wire-in notes:**
- Job name `doc-sync` is intentional (matches PHASED_PLAN card)
- Does NOT block merge initially — add `continue-on-error: true` for the first 2 PRs, then promote per same pattern as `integration-test`
- Runs on every push and PR (same `on:` trigger as the rest of CI)

---

### 3. `package.json` root version bump: `1.2.0` → `1.5.0`

**File:** `package.json` line 3

**Change:** `"version": "1.2.0"` → `"version": "1.5.0"`

**Rationale:** CLAUDE.md states v1.5.0. README Status says v1.5.0. CHANGELOG `[Unreleased]` block documents the delta. Bumping root `package.json` makes `sync-docs.sh` parseable.

---

### 4. `CHANGELOG.md` — backfill version entries

Promote the `[Unreleased]` block to `[1.5.0]` and backfill `[1.3.0]` and `[1.4.0]` to close the gap from `1.2.0`.

**Version mapping (from CLAUDE.md MEMORY.md + merged PRs):**

| Version | Content |
|---------|---------|
| 1.3.0 | CS1–CS5: switched to OpenAI API (`gpt-5.4` + `text-embedding-3-large`), removed LiteLLM proxy dependency, Node 22 LTS base images, CI action upgrades |
| 1.4.0 | Arch-review hardening (P01–P07): mem_limits, init-schema.sql, drift-guard (CaptureSource), Zod config validation, callClaude removal, cost estimator widening, Composio quota, admin reset two-step, backup secrets redaction, autonomy gate via BaseSkill, cognitive memory producer (Hebbian), internal traffic hygiene (rate-limit + scheduler spread) |
| 1.5.0 | P08–P15a: load-secrets.sh BWS reconciliation, sibling enum CHECKs (P09a/b/c), CI integration test job, CI voice-pipecat + file-ingestion pytest, Loki log driver, Prometheus alert rules, search perf LIMIT push-down + hnsw.ef_search, SafePromptBuilder + SECURITY.md, doc sync script |

**Approach:** Add `1.3.0`, `1.4.0`, `1.5.0` sections above the existing `1.2.0` section. The
`[Unreleased]` block becomes empty (or is removed with a pointer to 1.5.0). Backfill link
anchors at the bottom of CHANGELOG.md.

---

### 5. `docs/PRD.md` — minimal alignment pass (NOT the full LiteLLM scrub)

**Scope:** Only the doc header, version, and `source` enum correction. Full LiteLLM→OpenAI
body rewrite deferred to P15b.

**Changes:**

**5.1 Header version + status line (line 5–6):**
```
**Version**: 0.6  →  **Version**: 0.6 (P15a alignment pass — full v0.7 rewrite in P15b)
**Date**: 2026-03-05  →  **Date**: 2026-04-19
**Status**: Draft — Architectural Review v2 Applied  →  Draft — Architectural Review v2 Applied; P15a alignment in progress
```

**5.2 Add doc-history note** — insert after the header block a one-paragraph note:
```
> **Doc status note (2026-04-19):** This document is PRD v0.6 with a P15a partial alignment
> pass. The LiteLLM proxy architecture documented throughout this file reflects the original
> design (through v1.2.0). The current system (v1.5.0) uses the OpenAI API directly
> (`gpt-5.4` + `text-embedding-3-large`) with no LiteLLM proxy. The full replacement of
> LiteLLM references with the current architecture is planned for PRD v0.7 (P15b). See
> `docs/TDD.md` and `README.md` for current architecture.
```

**5.3 Fix `source` enum (line 261)** — the `"source"` field description in the Ingest Payload
section:
```
"source": "slack|voice|web|api|email|document"
→
"source": "slack|voice|api|document|mcp|email|file|consolidation|system"
```

Also update the ingest payload table row (line 219 in TDD, analogous in PRD):
```
One of: `slack`, `voice`, `web`, `api`, `email`, `document`
→
One of: `slack`, `voice`, `api`, `document`, `mcp`, `email`, `file`, `consolidation`, `system`. See `CaptureSource` type in `packages/shared/src/types/capture.ts`.
```

---

### 6. `docs/TDD.md` — minimal alignment pass

**Same principle as PRD: header + source enum only. Body LiteLLM scrub deferred to P15b.**

**Changes:**

**6.1 Document History — add a new row:**
```markdown
| P15a | 2026-04-19 | Troy Davis / Claude | P15a alignment pass: source enum corrected (9 values), doc-status note added, LiteLLM scrub deferred to P15b (v0.7) |
```

**6.2 `source` enum corrections** — three locations in TDD:

- Line 219 (POST /api/v1/captures request table, `source` row): same fix as PRD §5.3
- Line 1273 (Drizzle schema comment): `// slack | voice | api | document` → `// slack | voice | api | document | mcp | email | file | consolidation | system`
- Line 1310 (note "source values: slack | voice | api | document (not web | email)"): update to the canonical 9-value list and remove the incorrect parenthetical

**6.3 Add doc-status note** — same pattern as PRD, insert after the Related Documents table:
```
> **Doc status note (2026-04-19):** TDD v0.6 reflects the LiteLLM proxy architecture. The
> system has since migrated to direct OpenAI API calls (`gpt-5.4` + `text-embedding-3-large`).
> TDD v0.7 (P15b) will replace all LiteLLM references. See `README.md` and `config/ai-routing.yaml`
> for current architecture.
```

---

### 7. `README.md` — fix TDD version reference

**File:** `README.md` line 258 (reference table)

Change:
```
| `docs/TDD.md` | Technical design (v0.5) |
```
To:
```
| `docs/TDD.md` | Technical design (v0.6) |
```

---

## Work Items

| # | Item | File(s) | Effort |
|---|------|---------|--------|
| 1.1 | Write `scripts/sync-docs.sh` | `scripts/sync-docs.sh` (new) | 30 min |
| 1.2 | Add `doc-sync` job to CI | `.github/workflows/ci.yml` | 15 min |
| 1.3 | Bump root `package.json` to 1.5.0 | `package.json` | 5 min |
| 1.4 | Backfill CHANGELOG 1.3.0/1.4.0/1.5.0 | `CHANGELOG.md` | 45 min |
| 1.5 | PRD minimal alignment (header + source enum + doc-note) | `docs/PRD.md` | 30 min |
| 1.6 | TDD minimal alignment (doc-history row + source enum × 3 + doc-note) | `docs/TDD.md` | 30 min |
| 1.7 | README TDD version ref fix | `README.md` | 5 min |
| 1.8 | Run `sync-docs.sh` locally and confirm exit 0 | — | 10 min |
| 1.9 | Run CI and verify `doc-sync` job passes | — | 10 min |

**Total estimated effort:** ~3 hours (under the original 1-day estimate; the scope is narrower
than the card implied because the LiteLLM body rewrite is cleanly deferred to P15b).

---

## Acceptance Criteria

- [ ] `bash scripts/sync-docs.sh` exits 0 on main after this PR merges
- [ ] CI `doc-sync` job appears and is green on the PR
- [ ] `package.json` root version is `1.5.0`
- [ ] `CHANGELOG.md` has released entries for 1.3.0, 1.4.0, and 1.5.0 (no gap between 1.2.0 and current)
- [ ] `docs/PRD.md` has a doc-status note and the `source` enum shows all 9 values
- [ ] `docs/TDD.md` has a doc-history row for P15a, 3 source-enum fixes, and a doc-status note
- [ ] `README.md` reference table shows TDD as v0.6
- [ ] `grep -c -i "litellm" docs/PRD.md` returns 80 (unchanged — full scrub deferred to P15b)
- [ ] CI existing jobs (`build-and-test`, `python-lint`, `validate-schema`) remain green

**Note:** The LiteLLM reference count in PRD/TDD does NOT change in this PR. That is the
explicit scope boundary between P15a and P15b. If a reviewer finds a LiteLLM reference that
is trivially a one-line fix with zero blast radius, it can be included — but bulk substitution
of the 80/118 references stays in P15b.

---

## Dependencies on Prior Phases

- None. P15a is self-contained (doc + script work only; no migrations, no runtime code changes).
- P15b (`PRD + TDD v0.7: LiteLLM scrub`) depends on P15a landing first (so `sync-docs.sh` is in place before the version tag changes in v0.7 docs).

---

## Operator Approval Matrix

P15a touches `docs/PRD.md` and `docs/TDD.md` — per ORCHESTRATOR.md approval matrix, this
**requires operator approval before merge** (criterion: "Edits CLAUDE.md / PRD.md / TDD.md").

---

## Rollback Plan

All changes are documentation and script files tracked in git. `git revert <merge-sha>` on
main restores prior state. No migrations, no runtime changes, no homeserver deploy needed.
The `doc-sync` CI job failing is non-blocking (will be set `continue-on-error: true` initially).

---

## Post-Merge Actions Required

**Homeserver deploy:** None — no migrations, no Docker changes, no config changes.

**PHASED_PLAN.md update:** Mark P15a ✅ and add Cross-Phase Tracking row update.

**CLAUDE.md update:** No new operational rules expected unless `sync-docs.sh` logic reveals
a pattern worth capturing.

**GitHub:** Close partial #111 (P15b closes it fully). Comment: "P15a merged — sync script +
CI job + initial alignment complete. P15b to follow for full LiteLLM→OpenAI body rewrite."

---

## LAB_NOTEBOOK Pre-Action Entry (required before first commit)

Implementer MUST write a LAB_NOTEBOOK entry before the first commit covering:

```
## Entry NNN — P15a: Version sync script + initial doc alignment  [doc] [config]

**Objective:** Establish a machine-checkable version-sync invariant between package.json,
README, PRD, and CHANGELOG; close the version gap (1.2.0 → 1.5.0); fix source enum drift
in PRD + TDD; document the LiteLLM body-rewrite scope boundary for P15b.

**Hypothesis:** sync-docs.sh exits 0 after package.json is bumped to 1.5.0 and CHANGELOG
entries 1.3.0/1.4.0/1.5.0 are added. PRD/TDD source enum corrections pass grep verification.
CI doc-sync job green.

**Rollback plan:** git revert the merge SHA. No runtime or DB impact.
```
