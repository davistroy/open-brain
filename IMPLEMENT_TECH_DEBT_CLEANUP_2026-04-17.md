# Implementation Plan — Tech Debt Cleanup (post-Waves 2026-04-17)

**Source:** `/ultra-plan` session 2026-04-17 (immediately post-merge of PR #88 "Waves 2026-04-17: CS1-CS5"). Phase 4 solution design approved by user.
**Branches off:** `main` at `0d64d38` (post-PR #94 LAB_NOTEBOOK Entry 077 merged; homeserver live at `09ac073`).
**Scope:** 5 change sets closing out the 7-item tech-debt inventory + 4 discovered follow-ups (F1-F4). All work is laptop-only (no homeserver deploys). Every change set = one feature branch + one PR.

**Input inventory addressed:**

| # | Item | Resolved in |
|---|------|-------------|
| 1 | `FileUploadStatus` enum drift (web declares `completed`, DB enum is `parsed`) | Phase 2 (CS-α) |
| 2 | No sidecar integration test (PRs #91/#92/#93 were all deploy-discovered) | Phase 4 (CS-γ) |
| 3 | Hardcoded Anthropic model in `EmailComposeAssistService` + sibling in workers skill | Phase 3 (CS-β) |
| 4 | Schwab per-position gain fields zeroed in `toPositionsRecord` (frontend bug, not pipeline) | Phase 2 (CS-α) |
| 5 | Vite `@azure/msal-node` build error (no longer reproduces; docs cleanup only) | Phase 5 (CS-ε) |
| 6 | Windows ioredis hookTimeout flakes in unit tests | Phase 1 (CS-δ) |
| 7 | `punycode` DEP0040 warning (cosmetic; scope narrower than CLAUDE.md claimed) | Phase 5 (CS-ε) |
| F1 | End-to-end ingest integration test (upload → worker → sidecar → parsed) | Phase 4 (CS-γ) |
| F2 | Drift-guard test preventing future web/shared type drift | Phase 2 (CS-α) |
| F3 | Audit `CLAUDE.md` + `MEMORY.md` for other stale claims | Phase 5 (CS-ε) |
| F4 | `import type` experiment to eliminate web redeclarations | Flagged out-of-scope |

---

## Phase tracker

<!-- BEGIN TABLES -->

| Phase | Ref | Name | Branch | Status | PR |
|---|---|---|---|---|---|
| 1 | CS-δ | Test-infra stability (unblocks reliable CI for rest of plan) | `fix/vitest-unit-stability` | PENDING | — |
| 2 | CS-α | Contract drift fix + prevention (Items 1, 4 + F2) | `fix/web-contract-drift` | PENDING | — |
| 3 | CS-β | LLM model alias resolution (Item 3) | `refactor/email-compose-model-alias` | PENDING | — |
| 4 | CS-γ | Sidecar test coverage (Items 2 + F1) | `test/sidecar-coverage` | PENDING | — |
| 5 | CS-ε | Stale-docs cleanup (Items 5, 7 + F3) | `docs/stale-cleanup-2026-04-17` | PENDING | — |

**Sequencing:**

```
Phase 1 (CS-δ)  ───── must land first (~20 min)
                      ├─ Phase 2 (CS-α) ─── fast, independent
                      ├─ Phase 3 (CS-β) ─── medium, independent
                      └─ Phase 4 (CS-γ) ─── medium, independent
                                            │
                                     Phase 5 (CS-ε) ─── docs cleanup after 1-4 land
```

**Hard gates:** Phase 1 PR must be CI-green + merged before Phase 2/3/4 branches open (so Phase 2-4 CI runs are stable). Phase 2, 3, 4 can ship in any order once Phase 1 lands. Phase 5 requires all prior phases merged so the docs reflect final state.

**Process rules (carried from Waves 2026-04-17):**
- No direct-to-main pushes — every change via feature branch + PR + CI + review.
- LAB_NOTEBOOK Rule 1: Hypothesis + Rollback entry BEFORE any system-modifying action.
- LAB_NOTEBOOK Rule 11: entry covering the change BEFORE every `git commit` touching app code.
- Barrel-clobber rule (Entry 073): shared files (lib/api.ts, App.tsx, Layout.tsx, ai-routing.yaml) edited by ONE subagent per wave; testing subagent grep-verifies wiring before commit.

---

<!-- END TABLES -->

<!-- BEGIN PHASES -->

## Phase 1 — CS-δ Test-infra stability

**Branch:** `fix/vitest-unit-stability`
**PR title:** `fix(test): stabilize unit-test runner on Windows (forks pool + 30s hookTimeout)`
**Est wall-clock:** 20 min
**Est diff:** +12 / −2 LOC in 1-2 files
**Addresses:** Item 6 (Windows ioredis hookTimeout flakes in `admin-queue-clear.test.ts`, `slack-channel-routes.test.ts`).

### Intent
The unit-test vitest config uses default `threads` pool + default 10s hookTimeout. Under parallel thread execution on Windows, `new Redis(...)` mocks race against each other (thread startup is slower than Linux) and hooks that spin up bullmq+bullboard consume beyond 10s. Tests pass in isolation with `--hookTimeout=30000`. Integration config already runs `pool: 'forks'` + `hookTimeout: 30_000` stably. Apply the same profile to unit config.

### Work items

- [x] **1.1** Edit `packages/core-api/vitest.config.ts`: ✅ Completed 2026-04-17
  - Add `pool: 'forks'`
  - Add `poolOptions: { forks: { singleFork: false, maxForks: 4 } }`
  - Add `hookTimeout: 30_000`
  - Add `testTimeout: 30_000`
  - Preserve all existing config (environment, exclude, coverage).
  - **Status:** COMPLETE 2026-04-17
  - **Ref:** Item 6, ultra-plan CS-δ step 1
  - **Notes:** Added `minForks: 1` alongside `maxForks: 4` to avoid vitest 1.6 Tinypool "minThreads and maxThreads must not conflict" RangeError. Verified `pnpm --filter @open-brain/core-api test` green: 41 test files / **718 tests passed**, 81.96s wall-clock.
- [x] **1.2** Edit `packages/workers/vitest.config.ts` with identical additions (defensive — not currently flaking but uses same bullmq+ioredis pattern). ✅ Completed 2026-04-17
  - **Status:** COMPLETE 2026-04-17
  - **Ref:** ultra-plan CS-δ step 2
  - **Notes:** Added `pool: 'forks'`, `poolOptions.forks: { minForks: 1, maxForks: 4 }`, `hookTimeout: 30_000`, `testTimeout: 30_000`. Mirrors 1.1 pattern (needed `minForks: 1` to avoid Tinypool "minThreads and maxThreads must not conflict" RangeError on vitest 1.6). Verified `pnpm --filter @open-brain/workers test` green: 46 test files / **941 tests passed**, 94.97s wall-clock.
- [x] **1.3** Run `pnpm --filter @open-brain/core-api test` and `pnpm --filter @open-brain/workers test` 3 times back-to-back locally on Windows. Record pass/fail per run in the PR description. Zero flake required. ✅ Completed 2026-04-17
  - **Status:** COMPLETE 2026-04-17
  - **Ref:** ultra-plan CS-δ verification
  - **Results:** ZERO_FLAKE. core-api: 3/3 green, 41 files / 718 tests each run, durations 30.49s / 26.59s / 27.96s. workers: 3/3 green, 46 files / 941 tests each run, durations 35.27s / 34.95s / 31.53s. No timeouts, no unhandled rejections, no "test suite failed to run". Identical pass counts across all 6 runs confirms the `pool: 'forks'` + `minForks: 1` / `maxForks: 4` + `hookTimeout/testTimeout: 30_000` profile from 1.1/1.2 eliminates the Windows ioredis/bullmq race.

### Acceptance criteria
- `pnpm --filter @open-brain/core-api test` green 3/3 consecutive runs with <2× slowdown vs. previous threads-pool baseline.
- `pnpm --filter @open-brain/workers test` green 3/3.
- No test file modifications — config-only fix.
- Coverage thresholds (if any) still met.

### File changes
- **Modified:** `packages/core-api/vitest.config.ts`, `packages/workers/vitest.config.ts`

### Test plan
- Verified via 3× consecutive local runs during PR verification.
- No new tests needed (this phase is itself a test-infra fix).

### Rollback
Single `git revert`; both files are config-only with no API-surface impact. Worst case: revert restores prior threads+10s profile and flakes resume.

---

## Phase 2 — CS-α Contract drift fix + prevention

**Branch:** `fix/web-contract-drift`
**PR title:** `fix(web): align FileUploadStatus + IngestSourceType with @open-brain/shared; wire Schwab per-position gains`
**Est wall-clock:** 60 min
**Est diff:** +120 / −25 LOC across ~4 files
**Addresses:** Items 1, 4, F2.

### Intent
Resolve type drift between the web package and `@open-brain/shared`. The web bundle redeclares types locally (per CLAUDE.md note: Vite-bundle boundary); two literals drifted: `FileUploadStatus` declares `completed` while DB + Zod use `parsed`, and `IngestSourceType` declares 6 values while Zod only accepts 2. Also fix an incorrect assumption in `toPositionsRecord` that zeroes out per-position Schwab fields the Python pipeline DOES emit. Add a minimal drift-guard test so future redeclarations get caught.

### Work items

- [x] **2.1** Fix `packages/web/src/lib/api.ts`:
  - Line 859-863: `FileUploadStatus` — replace `'completed'` with `'parsed'`.
  - Line 791-797: `IngestSourceType` — narrow to `'financial' | 'utility'` (drop `'document'`, `'image'`, `'email'`, `'other'` — none are accepted by the backend Zod schema).
  - Line 1122-1134: `toPositionsRecord` — replace hardcoded `cost_basis: 0`, `gain_dollar: 0`, `gain_pct: ''` with `p.cost_basis ?? 0`, `p.gain_dollar ?? 0`, `p.gain_pct ?? ''`. Update the stale comment.
  - Verify `tsc --noEmit` green after each change.
  - **Status:** COMPLETE 2026-04-17
  - **Resolution:** `FileUploadStatus` narrowed to `'pending' | 'processing' | 'parsed' | 'failed'` (matches `FileUploadStatusSchema` in `packages/shared/src/schema/ingest.ts`). `IngestSourceType` narrowed to `'financial' | 'utility'` (matches `IngestSourceTypeSchema`). `toPositionsRecord` now reads `p.cost_basis`, `p.gain_dollar`, `p.gain_pct` via `typeof`-guarded coercion — same defensive pattern used for adjacent `qty`/`price`/`mkt_val` fields; compiles cleanly against the `number | null | undefined` shape added by 2.4 and correctly treats `null` (cash rows from `_num_or_none`) as 0 / empty. Stale comment updated to reflect that per-position fields ARE emitted by the Python pipeline when available. Remaining tsc errors live exclusively in `Ingest.tsx` and are in scope for 2.2.
  - **Ref:** Items 1, 4; ultra-plan CS-α steps 1
- [x] **2.2** Audit `packages/web/src/pages/Ingest.tsx` source-type dropdown:
  - Grep for string literals `'document'`, `'image'`, `'email'`, `'other'` in the Ingest page.
  - For each dropdown option not in the narrowed set: either remove it OR map it client-side to an accepted value before calling `ingestApi.upload`.
  - Preferred UX: keep `auto` (client-side = no `source_type` passed) + the 2 accepted values only. Remove the others.
  - **Status:** COMPLETE 2026-04-17
  - **Resolution:** `SOURCE_TYPE_OPTIONS` reshaped to `{ value, label }[]` with only 3 entries: `auto (classify)`, `Financial data (CSV)`, `Utility bill` — all `'document' | 'image' | 'email' | 'other'` literals removed. Dropdown render updated to read `opt.value` / `opt.label`. All 5 `status === 'completed'` comparisons (in `statusPercent`, `statusBadgeVariant`, SSE refresh trigger, and the two `useMemo` filters for active/finished trackers) swapped to `'parsed'` — canonical terminal-success state per the narrowed `FileUploadStatus` union. Default `sourceType` state left at `'auto'` (unchanged — still valid in narrowed set). Module JSDoc updated to drop the obsolete `document, image, email, other` enumeration and mention `parsed` (not `completed`) in the SSE flow description. `pnpm --filter @open-brain/web exec tsc --noEmit` exits 0.
  - **Ref:** Item 1 blast radius; ultra-plan CS-α step 2
- [x] **2.3** Audit any other consumers of the narrowed types:
  - Grep `packages/web/src` for `IngestSourceType` and `FileUploadStatus` usage.
  - Check status-badge rendering code for `'completed'` (should show `'parsed'`).
  - Check any switch/if that branches on these literals.
  - **Status:** COMPLETE 2026-04-17
  - **Resolution:** Grep audit: `IngestSourceType` and `FileUploadStatus` are imported ONLY by `packages/web/src/pages/Ingest.tsx` (owned by 2.2) and declared in `packages/web/src/lib/api.ts` (owned by 2.1). No other TS consumers to narrow. Literal `'completed'` string audit: all non-Ingest occurrences are in unrelated domains — BullMQ queue state (`api.ts:305 clearQueue`), skill/pipeline status rendering (`Dashboard.tsx`, `SkillHistoryCard.tsx`, `Briefs.tsx`, `Intelligence.tsx`, `FlowsTab.tsx`), and SSE test fixtures that emit `data: unknown` payloads (`sse.test.ts`) — none are file-upload statuses. Literal `'document'`/`'image'`/`'email'`/`'other'` audit: all non-Ingest occurrences are in unrelated domains (capture source types, email categories, Settings). No consumer fixes required outside 2.2's scope. Narrowing was effectively contravariant — no callers broke.
  - **Ref:** Item 1 blast radius
- [x] **2.4** Verify `SchwabPositionsMetadata` in `packages/web/src/lib/types.ts` declares the per-position fields used by `toPositionsRecord`:
  - Each `SchwabHolding` must have optional `cost_basis?: number`, `gain_dollar?: number`, `gain_pct?: string`, `asset_type?: string` typed so `p.cost_basis ?? 0` compiles.
  - If missing, add them to the interface.
  - **Status:** COMPLETE 2026-04-17
  - **Resolution:** Added `cost_basis?: number | null`, `gain_dollar?: number | null`, `gain_pct?: string` to the inline element type of `SchwabPositionsMetadata.positions[]` in `packages/web/src/lib/types.ts`. `asset_type?: string` was already present. Nullable numerics match the Python parser's `_num_or_none` sentinel (emits `None` for '--' / blank / 'N/A' rows, e.g. cash). `gain_pct` is a pre-formatted string from the CSV. Inline JSDoc pins the fields to `_parse_schwab_position_csv` as the source of truth. Backend canonical shape: `scripts/financial-pipeline.py` lines 2107-2117 (parser) + 2412-2426 (formatter `_format_schwab_position_capture`). `tsc --noEmit` shows zero errors touching `types.ts`, `SchwabHolding`, or `SchwabPositionsMetadata`; remaining tsc errors are all in `src/pages/Ingest.tsx` under items 2.2/2.3 scope.
  - **Ref:** Item 4
- [x] **2.5** Add drift-guard test at `packages/shared/src/__tests__/web-type-drift.test.ts` (F2): ✅ Completed 2026-04-17
  - Read `packages/web/src/lib/api.ts` as a string.
  - Parse out the `FileUploadStatus` and `IngestSourceType` union literals via regex (pattern like `export type FileUploadStatus\s*=\s*([^=]+?)(?=\n\n|\nexport)`).
  - Import `FileUploadStatusSchema.options` and `IngestSourceTypeSchema.options` from the shared package.
  - `expect(webLiterals).toEqual(sharedOptions)` for each.
  - Test includes a clear failure message pointing at the exact literal and file+line to update.
  - **Status:** COMPLETE 2026-04-17
  - **Ref:** F2, ultra-plan CS-α step 3
  - **Resolution:** Added `packages/shared/src/__tests__/web-type-drift.test.ts`. Mechanism: regex-on-source against `packages/web/src/lib/api.ts` — web is a standalone Vite bundle and intentionally does NOT import from `@open-brain/shared` (see the explicit note above the inline type decls at api.ts:847-859). Test imports `FileUploadStatusSchema` + `IngestSourceTypeSchema` from `../schema/ingest.js` and compares sorted `.options` tuples against the web literals. Extractor normalizes CRLF→LF (Windows git checkout emits `\r\n`) and uses a non-multiline regex `/export\s+type\s+${name}\s*=\s*([\s\S]*?)(?=\n\n|\nexport\s|$)/` — crucially without the `m` flag, since `$` under multiline would stop the lazy body at the first `| 'literal'` line. Failure message names both sides verbatim, cites the canonical file (`packages/shared/src/schema/ingest.ts`) as source of truth, and tells reviewers to update the WEB declaration. Validated: `pnpm --filter @open-brain/shared test` → 15 test files / **262 tests passed** (was 14/260 pre-change; +1 file / +2 cases for this guard). Self-verified the failure path during development: while the regex was broken (captured only first literal), the guard surfaced exactly the actionable message — `web: ["pending"]` vs `shared: ["failed","parsed","pending","processing"]` — proving drift is caught with precise remediation text, not a bare `AssertionError`.
- [x] **2.6** Run full test suites for both packages after all edits:
  - `pnpm --filter @open-brain/web exec tsc --noEmit` → PASS
  - `pnpm --filter @open-brain/web test` → all prior tests + new test green
  - `pnpm --filter @open-brain/shared test` → new drift-guard green
  - **Status:** COMPLETE 2026-04-17
  - **Ref:** Acceptance verification
  - **Results:**
    - `pnpm --filter @open-brain/shared build` → PASS (ESM 131.45 KB, DTS 239.22 KB, tsup build success in 97ms / DTS 5182ms, zero TS errors). Rebuilt first so dependent packages consume fresh `.d.ts` per project convention.
    - `pnpm --filter @open-brain/web exec tsc --noEmit` → PASS (zero output = zero errors).
    - `pnpm --filter @open-brain/shared test` → **15 test files / 262 tests passed** in 5.81s — matches expected count (includes new `web-type-drift.test.ts` with 2 cases).
    - `pnpm --filter @open-brain/web test` → **14 test files / 97 tests passed** in 8.22s — no failures, no new regressions from Phase 2 changes.
  - **Verdict:** PHASE_2_VERIFIED. Phase 2 (Web Type Drift Guard + related web/shared alignment) lands clean. No commits from this verification step per scope.

### Acceptance criteria
- Web `tsc --noEmit` green.
- Web test suite green (drift-guard test added; should pass on a correct tree).
- Shared test suite green.
- Drift-guard deliberately fails when a literal is mutated (reviewer spot-checks this by flipping `'parsed'` → `'completed'` locally pre-merge; test must catch it).
- Schwab positions capture in live data renders actual `cost_basis` / `gain_dollar` / `gain_pct` values instead of em-dashes in the frontend Investments table (smoke-test post-merge).

### File changes
- **Modified:** `packages/web/src/lib/api.ts`, `packages/web/src/pages/Ingest.tsx`, `packages/web/src/lib/types.ts` (if 2.4 needs edits)
- **New:** `packages/shared/src/__tests__/web-type-drift.test.ts`

### Test plan
- Unit: drift-guard test covers FileUploadStatus + IngestSourceType alignment.
- Integration: existing vitest suites unchanged; verify green.
- Manual: post-merge on homeserver, browse `/investments` — each Schwab positions card's holdings table renders real cost_basis / gain_dollar values for accounts that have positions snapshots.

### Rollback
`git revert` restores prior literals. No data changes. Vite bundle unaffected (types are erased at compile time). If the Ingest.tsx dropdown narrowing causes UX confusion, a follow-up can reintroduce the dropped values as UI-only aliases that map to `auto`.

---

## Phase 3 — CS-β LLM model alias resolution

**Branch:** `refactor/email-compose-model-alias`
**PR title:** `refactor(email-compose): resolve Anthropic model via ai-routing.yaml task alias`
**Est wall-clock:** 75 min
**Est diff:** +110 / −15 LOC across ~5 files + 1 yaml line
**Addresses:** Item 3 (both `EmailComposeAssistService` in core-api AND `email-compose` worker skill).

### Intent
Both call sites hardcode `claude-sonnet-4-5-20250929`. Swap to tier-resolved lookup via `ai-routing.yaml` so future model rotations are config-only. Introduce a shared `resolveTaskModel(config, taskName)` helper in `@open-brain/shared` so all task-indexed model resolution goes through one path.

### Work items

- [ ] **3.1** Edit `config/ai-routing.yaml`:
  - Add `email_compose: t2_quality` to `task_routing` (the t2_quality tier currently specifies `claude-sonnet-4-6` — a newer Sonnet than the hardcoded 4-5. This is a deliberate upgrade in alignment with the model_tiers canon).
  - Preserve the file's comment structure.
  - **Status:** PENDING
  - **Ref:** Item 3; ultra-plan CS-β step 1
- [ ] **3.2** Create `packages/shared/src/services/model-resolver.ts` (~40 LOC):
  - Export `resolveTaskModel(config: AIConfig, taskName: string): { model: string; tierKey: string }`.
  - Implementation: `const tierKey = config.task_routing[taskName]; if (!tierKey) throw new Error(...); const tier = config.model_tiers[tierKey]; if (!tier) throw new Error(...); return { model: tier.model, tierKey };`
  - Export from `packages/shared/src/index.ts`.
  - **Status:** PENDING
  - **Ref:** ultra-plan CS-β step 2
- [ ] **3.3** Add unit test `packages/shared/src/services/__tests__/model-resolver.test.ts`:
  - Stub config with `task_routing: { email_compose: 't2_quality' }`, `model_tiers: { t2_quality: { model: 'claude-sonnet-4-6', ... } }`.
  - Assert `resolveTaskModel(config, 'email_compose')` returns `{ model: 'claude-sonnet-4-6', tierKey: 't2_quality' }`.
  - Assert unmapped task name throws with a clear message.
  - Assert unmapped tier throws with a clear message.
  - **Status:** PENDING
  - **Ref:** ultra-plan CS-β step 7
- [ ] **3.4** Refactor `packages/core-api/src/services/email-compose-assist.ts`:
  - Add `private configService: ConfigService` to constructor.
  - In `compose()`: `const { model } = resolveTaskModel(this.configService.get('ai'), 'email_compose')`.
  - Pass resolved `model` to `runAgent(...)` instead of the literal.
  - Remove the hardcoded `'claude-sonnet-4-5-20250929'`.
  - **Status:** PENDING
  - **Ref:** Item 3; ultra-plan CS-β step 3
- [ ] **3.5** Wire `ConfigService` into `EmailComposeAssistService` in `packages/core-api/src/index.ts`:
  - Locate the `new EmailComposeAssistService(...)` instantiation.
  - Pass `configService` as a new constructor arg.
  - **Status:** PENDING
  - **Ref:** ultra-plan CS-β step 4
- [ ] **3.6** Refactor `packages/workers/src/skills/email-compose.ts`:
  - Add `configService: ConfigService` to the skill's LLMSkill options / init.
  - Replace the hardcoded model default (line 28) with `resolveTaskModel(configService.get('ai'), 'email_compose').model`.
  - **Status:** PENDING
  - **Ref:** Item 3; ultra-plan CS-β step 5
- [ ] **3.7** Wire ConfigService into the EmailCompose skill in `packages/workers/src/main.ts`:
  - Locate the skill registration.
  - Ensure `configService` is passed.
  - **Status:** PENDING
  - **Ref:** ultra-plan CS-β step 6
- [ ] **3.8** Add unit tests for both refactored call sites:
  - `packages/core-api/src/__tests__/email-compose-assist.test.ts` (new or extended): stub `configService.get('ai')` with a fake tier, stub `runAgent` as a spy, call `service.compose()`, assert `runAgent` received the stubbed model string.
  - `packages/workers/src/__tests__/email-compose.test.ts` (extend existing): same pattern.
  - **Status:** PENDING
  - **Ref:** Acceptance verification

### Acceptance criteria
- `ai-routing.yaml` contains `email_compose: t2_quality` under `task_routing`.
- `resolveTaskModel` exported from `@open-brain/shared`.
- Neither `EmailComposeAssistService` nor `email-compose.ts` contains the literal `'claude-sonnet-4-5-20250929'` anywhere in source.
- `pnpm --filter @open-brain/core-api exec tsc --noEmit` + `pnpm --filter @open-brain/workers exec tsc --noEmit` + `pnpm --filter @open-brain/shared exec tsc --noEmit` all PASS.
- All affected test suites pass.
- Manual: post-deploy smoke — Compose drawer's "Draft with AI" still produces a draft.

### File changes
- **Modified:** `config/ai-routing.yaml`, `packages/core-api/src/services/email-compose-assist.ts`, `packages/core-api/src/index.ts`, `packages/workers/src/skills/email-compose.ts`, `packages/workers/src/main.ts`, `packages/shared/src/index.ts`
- **New:** `packages/shared/src/services/model-resolver.ts`, `packages/shared/src/services/__tests__/model-resolver.test.ts`, `packages/core-api/src/__tests__/email-compose-assist.test.ts` (if not already existing; extend if present)
- **Extended:** `packages/workers/src/__tests__/email-compose.test.ts`

### Test plan
- Unit: resolver test asserts both success and error paths. Call-site tests assert model flows from config.
- Integration: existing email-compose skill integration test (if any) still green.
- Manual smoke on homeserver after merge: open `/email`, click Compose, click "Draft with AI" with a short instruction, confirm body is populated (validates the full agent loop with the new model).

### Rollback
`git revert`. ai-routing.yaml change is additive; reverting re-introduces the hardcoded model at both sites. No data changes. Worst case: model literal drift returns; re-apply fix.

**Risk flag:** If `t2_quality` tier's model string is rotated to something the Anthropic SDK doesn't yet support, `runAgent` will fail on the first Compose-with-AI click. Mitigation: the existing manual smoke step catches this within seconds of deploy. Include the smoke check in the PR test plan.

---

## Phase 4 — CS-γ Sidecar test coverage

**Branch:** `test/sidecar-coverage`
**PR title:** `test(sidecar): add Python unit tests for trigger_server.py + gated e2e ingest smoke`
**Est wall-clock:** 2.5 hours
**Est diff:** +450 / −20 LOC across ~5 files
**Addresses:** Item 2, F1.

### Intent
PRs #91/#92/#93 (env var name, Dockerfile CMD, per-sidecar `INGEST_SOURCE`) were all deploy-discovered defects. Add a Python unit test harness for `trigger_server.py` covering auth, env binding, routing, and lock behavior — fast feedback, no Docker. Add a gated end-to-end integration test that exercises the full upload → worker → sidecar chain against `docker-compose.test.yml`; gate so it skips in per-PR CI but runs on nightly / on-demand.

### Work items

- [ ] **4.1** Refactor `docker/ingest-sidecar/trigger_server.py` for testability (minor):
  - Extract a `Config` dataclass read lazily by a `create_app(config: Config | None = None) -> ThreadingHTTPServer` factory.
  - Module-level `INGEST_TRIGGER_SECRET`, `INGEST_SOURCE`, `PORT`, `BIND_HOST`, `TRIGGER_TIMEOUT_SEC` reads move into `Config.from_env()`.
  - `main()` now calls `create_app(Config.from_env()).serve_forever()`.
  - Existing runtime behavior (when run as `__main__`) unchanged.
  - Verify `python3 -c "import ast; ast.parse(open('docker/ingest-sidecar/trigger_server.py').read())"` passes.
  - **Status:** PENDING
  - **Ref:** Item 2; ultra-plan CS-γ step 1
- [ ] **4.2** Create `docker/ingest-sidecar/tests/` directory with:
  - `__init__.py` (empty, for pytest discovery)
  - `requirements.txt` containing `pytest==8.*` (stdlib for everything else)
  - `conftest.py` with a `tmp_config(secret: str = ..., source: str = ...)` fixture returning a fresh `Config`
  - **Status:** PENDING
  - **Ref:** ultra-plan CS-γ step 3
- [ ] **4.3** Create `docker/ingest-sidecar/tests/test_trigger_server.py` covering:
  - **Auth:** missing `Authorization` header → 401; wrong secret → 401 (verify constant-time comparison isn't shortcut); correct secret → 200.
  - **Env binding:** `Config(source='utility')` surfaces on `GET /healthz` response payload.
  - **Routing:** POST `/process` with no body → uses `Config.source`; POST `/process` with `{"source": "financial"}` body overrides bound source.
  - **Lock contention:** acquire lock in one thread, assert second POST `/process` returns 409.
  - **Subprocess dispatch:** patch `subprocess.run` via `unittest.mock.patch`; assert correct pipeline script (`financial-pipeline.py` vs. `utility-pipeline.py`) is invoked based on effective source.
  - **Error handling:** subprocess exit != 0 → HTTP 500 with structured error body.
  - Target: 8-12 tests, all under 2 seconds total.
  - **Status:** PENDING
  - **Ref:** Item 2; ultra-plan CS-γ step 2
- [ ] **4.4** Add sidecar-test CI job:
  - Edit `.github/workflows/ci.yml` (or whichever CI workflow exists — discover first).
  - New job `sidecar-test`:
    - Runs on `ubuntu-latest`.
    - Uses `actions/setup-python@v5` with Python 3.12.
    - Installs `pip install -r docker/ingest-sidecar/tests/requirements.txt`.
    - Runs `python3 -m pytest docker/ingest-sidecar/tests/ -v`.
    - Caches pip dir.
  - Job runs in parallel with existing node-test matrix.
  - **Status:** PENDING
  - **Ref:** ultra-plan CS-γ step 4
- [ ] **4.5** Add gated end-to-end integration test at `packages/workers/src/__tests__/integration/ingest-e2e.test.ts` (F1):
  - Vitest suite gated with `describe.skipIf(!process.env.INGEST_E2E)(...)`.
  - Uses existing `docker-compose.test.yml` (add a `test-sidecar` service pointing to `docker/ingest-sidecar/Dockerfile` if not present).
  - Test body:
    1. `POST /api/v1/ingest/upload` with a stub 2-line CSV + `source_type=financial`.
    2. Poll `GET /api/v1/ingest/uploads/{id}` until `status != 'pending'` (max 30s).
    3. Assert final status is `'parsed'`.
    4. Assert workers logged a `dispatching to sidecar` + `sidecar dispatch completed` pair for the upload_id.
  - Document in README how to run: `INGEST_E2E=1 pnpm --filter @open-brain/workers test`.
  - **Status:** PENDING
  - **Ref:** F1; ultra-plan CS-γ step 5
- [ ] **4.6** Extend `docker-compose.test.yml` with a `test-sidecar` service if 4.5 requires it:
  - Build from `docker/ingest-sidecar/Dockerfile`.
  - Environment: `INGEST_TRIGGER_SECRET=test-secret`, `INGEST_SOURCE=financial`.
  - Network join with `test-postgres` + `test-redis`.
  - No published ports (internal test-network only).
  - **Status:** PENDING
  - **Ref:** F1 prereq
- [ ] **4.7** Run the Python suite locally:
  - `python3 -m pytest docker/ingest-sidecar/tests/ -v` → all green, under 2 seconds.
  - Run once with a deliberately-broken auth (revert #91 locally) and confirm the test CATCHES the regression.
  - **Status:** PENDING
  - **Ref:** Acceptance verification

### Acceptance criteria
- `python3 -m pytest docker/ingest-sidecar/tests/` green, <2s runtime.
- CI workflow has the new `sidecar-test` job running on every push.
- `INGEST_E2E=1 pnpm --filter @open-brain/workers test` green against `docker-compose.test.yml` (verified locally at least once).
- Manually reverting PR #91 locally (changing env var name back to `TRIGGER_SECRET`) causes at least one unit test to fail — validates the tests would have caught that regression.
- Normal `pnpm -r test` unchanged in runtime (e2e suite skipped without `INGEST_E2E=1`).

### File changes
- **Modified:** `docker/ingest-sidecar/trigger_server.py`, `docker-compose.test.yml`, `.github/workflows/ci.yml` (or equivalent)
- **New:** `docker/ingest-sidecar/tests/__init__.py`, `docker/ingest-sidecar/tests/requirements.txt`, `docker/ingest-sidecar/tests/conftest.py`, `docker/ingest-sidecar/tests/test_trigger_server.py`, `packages/workers/src/__tests__/integration/ingest-e2e.test.ts`

### Test plan
- Python unit tests run on every CI build.
- E2E test runs on demand + nightly (if nightly cron exists; otherwise flagged for a future scheduled workflow).
- Regression test: deliberately revert #91/#92/#93 locally one at a time and confirm the appropriate test catches each.

### Rollback
`git revert`. The refactor at 4.1 is additive (extract `Config` + `create_app`) — backward compatible with the existing `main()` entry point. Tests can be deleted without affecting production runtime.

---

## Phase 5 — CS-ε Stale-docs cleanup

**Branch:** `docs/stale-cleanup-2026-04-17`
**PR title:** `docs: retire stale claims — Vite build works, punycode scope narrower, misc CLAUDE.md audit`
**Est wall-clock:** 45 min
**Est diff:** +60 / −30 LOC in docs + LAB_NOTEBOOK
**Addresses:** Items 5, 7, F3.

### Intent
Several CLAUDE.md / LAB_NOTEBOOK claims are now stale: Vite build is no longer blocked (verified cleanly completing in 9.24s), punycode warning scope is narrower than claimed (only dev-dep path via vitest→jsdom→tr46; not via @slack/bolt or BullMQ), and assorted other references may be stale after PRs #88-#94 landed. Clean up with a comprehensive audit + LAB_NOTEBOOK Entry 078 recording the cleanup.

### Work items

- [ ] **5.1** Audit `CLAUDE.md` (project, at repo root):
  - Search for references to `@azure/msal-node`, `accessSync`, "Vite build error", "build is blocked", "pre-existing Vite".
  - Remove or mark each as historical (pre-PR #90).
  - Search for `punycode` / `DEP0040` / `psl → punycode`. Rewrite the current bullet: keep the note that the warning is cosmetic, but correct the transitive path to `vitest→jsdom→whatwg-url→tr46→punycode` (dev-only). Remove the `@slack/bolt or BullMQ` claim.
  - Search for `LITELLM_API_KEY`, `LITELLM_URL`, `LITELLM_SPEND_URL` — confirm each remaining reference describes historical behavior or a different env var (`LITELLM_SPEND_URL` is a distinct env still documented correctly). Update any that describe current runtime behavior to use `OPENAI_API_KEY` / `OPENAI_BASE_URL`.
  - Search for `sleep infinity` as a current-state description (CS3.8 assumption). Remove or mark as historical.
  - **Status:** PENDING
  - **Ref:** Items 5, 7, F3; ultra-plan CS-ε step 2
- [ ] **5.2** Audit `memory/MEMORY.md` (Claude's auto-memory):
  - Repeat the same searches as 5.1.
  - The `LITELLM_API_KEY (name kept for backward compat)` line was already updated in CS5.9 — verify.
  - Update any other stale references found.
  - **Status:** PENDING
  - **Ref:** F3; ultra-plan CS-ε step 3
- [ ] **5.3** Grep for stale references in other project docs (README, docs/*.md, LAB_NOTEBOOK.md for pre-2026-04-17 entries):
  - Do NOT modify historical LAB_NOTEBOOK entries (they're experiment-log records — leave as-is per Rule 10).
  - Only update active / instructional docs.
  - Record which files were changed in the PR description.
  - **Status:** PENDING
  - **Ref:** F3
- [ ] **5.4** Re-enable `pnpm --filter @open-brain/web build` in CI:
  - Locate the CI workflow(s) that currently skip or don't run the Vite build.
  - Add a `web-build` job (or step) that runs `pnpm --filter @open-brain/web build`.
  - Runs after `web-test` job for fast-fail on type errors before spending build time.
  - **Status:** PENDING
  - **Ref:** Item 5; ultra-plan CS-ε step 4
- [ ] **5.5** Add LAB_NOTEBOOK Entry 078 recording the cleanup:
  - Tags: `[cleanup]` `[docs]` `[decision]`
  - Header: hypothesis (the stale claims are stale; removing them improves future-session accuracy), rollback plan (git revert).
  - Body: list of stale claims removed + why each is stale (Vite build works verified post-PR #90; punycode has no prod path per `pnpm why --prod`).
  - Results: grep verifications showing zero matches for each stale string in active-doc scope.
  - **Status:** PENDING
  - **Ref:** Process rule Rule 1 + Rule 11

### Acceptance criteria
- `grep -in 'accessSync\|azure/msal-node' CLAUDE.md docs/ README.md` returns zero matches describing active state.
- `grep -in 'psl.*punycode\|slack/bolt.*punycode\|BullMQ.*punycode' CLAUDE.md memory/MEMORY.md` returns zero matches.
- `grep -in 'LITELLM_API_KEY' CLAUDE.md memory/MEMORY.md` returns only historical-context matches (with "backward compat" / "retired" / "historical" context words nearby).
- CI runs `pnpm --filter @open-brain/web build` on every push; green on latest `main`.
- LAB_NOTEBOOK Entry 078 committed.

### File changes
- **Modified:** `CLAUDE.md`, `memory/MEMORY.md`, `LAB_NOTEBOOK.md` (new entry 078), CI workflow(s) (enable Vite build step), possibly other `docs/*.md`

### Test plan
- Docs-only phase — grep verification above is the test.
- CI verification: Vite build step green on the PR.

### Rollback
`git revert`. Docs-only phase — no runtime risk. If the Vite build step flakes or finds a regression, revert the CI workflow change and investigate separately.

<!-- END PHASES -->

---

## Risk register

<!-- BEGIN TABLES -->

| Risk | Phase | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Narrowing `IngestSourceType` breaks a hidden UI code path | 2 | Medium | Low | tsc catches it. 2.2+2.3 explicitly audit consumers. |
| Drift-guard regex misses a whitespace/format variant | 2 | Low | Low | Use permissive regex + include fallback assertion on full literal array; test has clear failure message. |
| `t2_quality` tier's `claude-sonnet-4-6` not available / model rotated | 3 | Low | Medium | 3.8 smoke check catches immediately post-deploy. Rollback via `ai-routing.yaml` tier update (config-only). |
| `ConfigService` wiring ripple in core-api/workers constructors | 3 | Low | Low | DI is by construction; tsc catches any missed call site. |
| Python unit tests mock subprocess imperfectly | 4 | Low | Low | Use `unittest.mock.patch` + validate via 4.7 regression-revert check. |
| E2E test depends on Docker availability — flaky on CI | 4 | Medium | Low | Gate with `INGEST_E2E=1`; skips by default. |
| Widening hookTimeout hides future perf regressions | 1 | Low | Low | Monitor p99 test duration in CI summary output. |
| CI build step newly fails due to transient network / dep-resolve issue | 5 | Low | Low | Re-run; gate merge on green. |
| Docs cleanup removes context someone depends on | 5 | Very low | Very low | Git history preserves everything removed. Grep-verify nothing active still references removed strings. |

---

## Parallel work opportunities

| Work Items | Can Run With | Notes |
|---|---|---|
| 2.1, 2.2, 2.3, 2.4 | Within Phase 2 | All touch web package files or types; sequential read-then-write within one subagent avoids clobber. |
| 2.5 | 2.1-2.4 (must follow) | Drift-guard test depends on the fixes landing first. |
| 3.2, 3.3 | Parallel | `model-resolver.ts` + its test can ship together in one commit. |
| 3.4+3.5 vs 3.6+3.7 | Parallel | Core-api pair and workers pair are disjoint packages. |
| 4.1, 4.2, 4.3 | Sequential within Phase 4 | Refactor → fixtures → tests chain. |
| 4.4, 4.5, 4.6 | Parallel after 4.3 | CI job, e2e test, compose service are disjoint files. |
| Phase 2 vs Phase 3 vs Phase 4 | Parallel after Phase 1 | 3 independent feature branches; can ship as 3 concurrent PRs. |
| Phase 5 | Must follow 1-4 | Docs cleanup should reflect final post-fix state. |

---

## Success metrics

| Metric | Target | Source |
|---|---|---|
| Web `tsc --noEmit` | PASS | Phase 2 acceptance |
| Core-api `tsc --noEmit` | PASS | Phase 3 acceptance |
| Workers `tsc --noEmit` | PASS | Phase 3 acceptance |
| Shared `tsc --noEmit` | PASS | Phase 2 + 3 acceptance |
| Unit test flake rate | 0/3 consecutive Windows runs | Phase 1 acceptance |
| Sidecar Python unit tests | 8-12 tests, <2s runtime | Phase 4 acceptance |
| Drift-guard test | Catches a mutated literal in pre-merge spot-check | Phase 2 acceptance |
| Vite `web build` in CI | Green on every push | Phase 5 acceptance |
| Stale doc strings | Zero matches in active-doc scope | Phase 5 acceptance |
| Per-position Schwab gain rendering | Real values instead of em-dashes on `/investments` | Phase 2 post-deploy smoke |
| Email Compose AI-assist | Still produces a draft after model swap | Phase 3 post-deploy smoke |

---

## Requirement traceability

| Requirement | Source | Phase | Work Items |
|---|---|---|---|
| Fix FileUploadStatus enum drift | Item 1 (ultra-plan Phase 1) | 2 | 2.1, 2.5 |
| No sidecar integration test | Item 2 | 4 | 4.1-4.7 |
| Hardcoded Anthropic model | Item 3 (both call sites) | 3 | 3.1-3.8 |
| Schwab per-position gain fields frontend bug | Item 4 | 2 | 2.1 (toPositionsRecord), 2.4 (type check) |
| Vite build error claim stale | Item 5 | 5 | 5.1, 5.3, 5.4 |
| Windows ioredis hookTimeout | Item 6 | 1 | 1.1, 1.2, 1.3 |
| punycode DEP0040 scope inaccurate | Item 7 | 5 | 5.1 |
| End-to-end ingest integration test | F1 (ultra-plan discovery) | 4 | 4.5, 4.6 |
| Drift-guard prevention mechanism | F2 | 2 | 2.5 |
| CLAUDE.md / MEMORY.md audit | F3 | 5 | 5.1, 5.2, 5.3 |
| `import type` from @open-brain/shared experiment | F4 | — | Flagged OUT OF SCOPE |

<!-- END TABLES -->

---

## Scope boundaries

**In scope (this plan):**
- All 7 tech-debt items from the ultra-plan inventory.
- Follow-ups F1-F3 (end-to-end test, drift-guard, docs audit).
- Laptop-only — all changes ship via feature branches + PRs, merged to `main`. Homeserver auto-picks up on next `git pull && docker compose up -d --build` cycle for affected containers.

**Out of scope (flagged for separate planning):**
- **F4 — Replace web type redeclarations with `import type` from `@open-brain/shared`.** Worth a standalone experiment PR to verify Vite bundle size is unchanged. F2's drift-guard is sufficient protection until then.
- **Drizzle `source_type` tightening to `pgEnum`.** `file_uploads.source_type` is `text` in Drizzle but Zod-restricted. DB-level enforcement would add belt + suspenders. Low priority.
- **LLMGatewayService integration for email-compose.** Would require reworking the multi-turn agent loop (`runAgent`) to route tool-use through the gateway. Significant lift; `resolveTaskModel` is the right-sized fix today. Flagged for a future architectural review if gateway audit logging becomes mandatory for email-compose calls.
- **Comprehensive CLAUDE.md audit beyond what this plan discovers.** Phase 5.1-5.3 cleans up items encountered during this audit. A formal top-to-bottom CLAUDE.md review is its own task.
- **Python lint/typecheck infrastructure for `scripts/` + `docker/ingest-sidecar/`.** Currently no `mypy` / `ruff` / `black` in CI for Python. This plan's sidecar tests don't require it but a future plan should.

---

*Source: `/create-plan` command, generated 2026-04-17 from ultra-plan Phase 3 solution design.*
