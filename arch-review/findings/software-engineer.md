# Software Engineer Findings

**Reviewer:** Senior Software Engineer
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain` (main @ 9443f93)
**Confidence:** High

---

## Executive Summary

Open Brain is a **mature, disciplined single-operator monorepo** with unusually strong engineering hygiene for an evolving personal project. TypeScript discipline is tight (zero `@ts-ignore` in production, one `as any` in production, pervasive `import type`). Error taxonomy is clean (`AppError` -> `NotFoundError`/`ValidationError`/`ConflictError`/`ServiceUnavailableError` + `LLMBudgetExceededError`/`LLMGatewayError`/`ModelResolverError`). Test LOC (~48k) is roughly on par with production LOC (~45k non-test TS), and every dispatchable skill has a corresponding `*.test.ts`. The recent CS1-CS5 refactor wave and PR #96-#101 tech-debt cleanup paid real dividends: Vitest Windows profile codified, `BaseSkill`/`LLMSkill` base classes eliminate per-skill boilerplate, shared `model-resolver` removes alias-resolution duplication, and a `web-type-drift.test.ts` now mechanically prevents the web ↔ shared regression that caused the Wave-A `'completed'` vs `'parsed'` fallout.

Concerns cluster into three visible areas:
1. **A handful of god modules remain** — most consequential is `scripts/financial-pipeline.py` (3,035 LOC, 45 top-level functions) which carries CSV parsing + balance capture + investment reports + inbox processing + monthly synthesis. Secondary: `packages/web/src/lib/api.ts` (1,227 LOC) and `packages/web/src/pages/Email.tsx` (905 LOC).
2. **Dispatch switch in `skill-execution.ts`** (540 LOC, 20+ cases). Works, type-safe, but the 20-case `switch` with near-identical case bodies is ripe for a registry pattern — adding a 21st skill means touching 3 files.
3. **Legacy `callClaude` fallback path** bypasses `ai_audit_log` and `checkBudget`. 5 skills use it (weekly-brief, memory-consolidation, daily-connections, drift-monitor, daily-sweep-skill). They do prefer `LLMGatewayService` first, but the fallback path is invisible to cost accounting — same pattern of cost-blindness that caused the 2026-04-15 $100 Anthropic incident.

No blocker-class findings. Nothing I would gate a merge on. All issues are maintainability / consistency concerns, addressable in dedicated cleanup PRs rather than live-fire debugging.

---

## Codebase Metrics

| Metric | Value |
|--------|-------|
| Total LOC (source, non-test, excluding node_modules/dist) | ~93k TS + ~17k TSX + ~17k Python ≈ 127k |
| Test LOC | ~48k TS (135 `.test.ts` files) + ~850 Python (pytest) |
| Primary languages | TypeScript (8 packages), Python 3.12 (sidecar + voice-pipecat + file-ingestion + scripts), SQL (22 Drizzle migrations) |
| Source file count | 550 (.ts/.tsx/.py/.js/.sql, ex-vendor) |
| Debt markers (TODO/FIXME/HACK) | **8 total** across 3 files — exceptionally low |
| Largest production TS files | `web/src/lib/api.ts` (1,227), `workers/src/skills/monthly-reflection.ts` (923), `shared/src/services/llm-gateway.ts` (844), `workers/src/skills/morning-brief.ts` (711), `workers/src/skills/memory-consolidation.ts` (682) |
| Largest Python files | `scripts/financial-pipeline.py` (**3,035** — god module), `scripts/utility-pipeline.py` (1,009), `scripts/email-pipeline.py` (841), `docker/ingest-sidecar/trigger_server.py` (744) |
| Largest TSX | `web/pages/Email.tsx` (905), `web/pages/Wiki.tsx` (820), `web/pages/Ingest.tsx` (615), `web/pages/Dashboard.tsx` (602) |
| `as any` in production code (ex-tests) | **1** occurrence (regex) — best-in-class |
| `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` in production | **0** — best-in-class |
| `console.log`/`console.error` in production (non-web, non-docstring) | 1 (device-code auth UX prompt in `hotmail-client.ts:161`) |
| Empty `catch {}` blocks | 0 — all swallows are deliberate with structured defaults, some with `/* ignore parse errors */` comments |
| `import type` discipline | 240 files use it; 523 total import type statements |
| Vitest config discipline | All 3 TS test configs (core-api, workers, shared) use `pool: 'forks'` with `minForks/maxForks` + 30s timeouts per CLAUDE.md Windows profile |
| CI test matrix | `build-and-test` (TS), `sidecar-test` (pytest), `python-lint` (ruff + pyright) — clean 3-job pipeline |
| Ruff + pyright | Clean: 0 errors/warnings on scoped Python targets (`docker/ingest-sidecar`, `packages/file-ingestion/src`) |

---

## Complexity and Coupling Analysis

### Hot zones (by size × coupling)

1. **`scripts/financial-pipeline.py` — 3,035 LOC, 45 functions, god module**
   - Mixes: Plaid sync, Schwab CSV parsing, PayPal CSV parsing, Chase/AmEx/Truist/HSA parsing, balance snapshots, investment weekly reports, monthly synthesis, inbox processing (401k PDFs, Amazon CSVs), daily summary generation.
   - Each of these is a distinct concern that deserves its own module under `scripts/lib/financial/`. Currently any change to, say, the Schwab parser forces re-testing everything else — the parser specs are interleaved with regex constants and the daily-summary renderer.
   - Parser filename heuristics are duplicated between this file and `packages/core-api/src/routes/ingest.ts:73` (`localRouteFile()`). There's a CS3.12 note in the latter saying `services/ingest-router.ts` will consolidate; not done yet, and the Python side has its own `scripts/lib/ingest_router.py`.

2. **`packages/workers/src/jobs/skill-execution.ts` — 540 LOC, 20-case switch**
   - `packages/workers/src/jobs/skill-execution.ts:97-504` is a monolithic switch. Each case is structurally identical: parse/validate `input.*`, construct options, `runSkill(SkillClass, opts, input)`, log with skill-specific fields. Adding a 21st skill requires edits here AND `routes/skills.ts` `KNOWN_SKILLS` AND the scheduler.
   - This is the sort of "registry waiting to be extracted" situation where each `BaseSkill` subclass could self-register its name + input schema + log field shape. The author called this out in a JSDoc block (`skill-execution.ts:62-66`) noting the 3-file add procedure — aware of the issue, not addressed.

3. **`packages/web/src/lib/api.ts` — 1,227 LOC, one file = whole API surface**
   - All 200+ frontend-facing call sites live here as property bags (`capturesApi`, `statsApi`, `searchApi`, ...). Fine for single-operator reads, but it's now large enough that changes routinely trigger cross-cutting churn. The redeclared union types (`IngestSourceType`, `FileUploadStatus`, `CaptureSource`) are here because the web package can't runtime-import `@open-brain/shared`. The drift-guard test (`packages/shared/src/__tests__/web-type-drift.test.ts`) covers 2 of the 3 (see High-3 below).

4. **`packages/web/src/pages/Email.tsx` — 905 LOC, ~20 hooks, 1 component**
   - Contains `DraftCard` sub-component inline, thread-building logic, filter state, approve/reject flows, and the outer `<Email>` component. Could cleanly split into `DraftCard.tsx` + `InboundView.tsx` + `ThreadsView.tsx` + outer container — no state would need to be lifted.
   - Same pattern lurks in `web/pages/Wiki.tsx` (820), `web/pages/Ingest.tsx` (615), `web/pages/Dashboard.tsx` (602).

### Coupling graph (healthy)
- `@open-brain/shared` is the correct single-downward dependency for all other packages — no circular imports surfaced.
- Barrel export (`packages/shared/src/index.ts` — 7 lines) cleanly re-exports `types/schema/utils/db/config/services/lib`. No leakage of internal helpers.
- `BaseSkill` (`workers/src/skills/base-skill.ts`) and `LLMSkill` share a consistent constructor contract (`BaseSkillOpts` / `LLMSkillOpts`). All 20 skills inherit appropriately.
- `ConfigService` owns config loading; `LLMGatewayService` owns tier routing; `ModelResolver` owns alias -> tier lookup. Clean separation of concerns.

---

## Critical Path Walkthrough

### Path 1: Capture creation (API ingress -> DB -> pipeline dispatch)
- **Entry point:** `packages/core-api/src/routes/captures.ts:19`
- **Layers:** Hono route -> `zValidator('json', createCaptureSchema)` -> `ConfigService.getBrainViews()` brain-view validation -> `CaptureService.create()` -> BullMQ enqueue.
- **Findings:**
  - Zod schema + Hono's `zValidator` gives a clean 400 for malformed input — no hand-rolled runtime checks.
  - Rate limiting is applied at `app.ts:104-107` with the `strict` tier (20/min). Internal callers (including `'email-worker'`, `'ingest'`, `'financial-pipeline'`, `'utility-pipeline'`, `'integration-test'`, `'web-ui'`) are bypassed via `BYPASS_CALLERS` Set at `middleware/rate-limit.ts:159-167`.
  - Response shape `{ id, pipeline_status, created_at }` is terse by design — documented in CLAUDE.md as the contract (not the full row).
  - No finding.

### Path 2: File upload -> sidecar -> pipeline (CS3 ingest)
- **Entry point:** `packages/core-api/src/routes/ingest.ts:205` (POST `/api/v1/ingest/upload`)
- **Layers:** Content-type fork (multipart vs octet-stream) -> filename-based `localRouteFile()` resolver -> `streamBodyToFile()` with 100 MiB streaming cap -> `file_uploads` row insert -> `ingest-process` BullMQ enqueue (fire-and-forget if queue missing, with daily sweep pickup).
- **Findings:**
  - Streaming-to-disk design respects the 1.5 GB RSS ceiling — uploads never materialize in memory (`streamBodyToFile()` tracks bytes as it writes and aborts at `MAX_UPLOAD_BYTES`).
  - `dispatchToSidecar()` at `ingest.ts:106-116` is explicitly marked as a TODO stub and delegates to the BullMQ `ingest-process` worker. This is the one TODO I found in production TS code that might confuse future maintainers — the comment says "CS3.11's `services/ingest-router.ts` can pull it up." See Medium-5.
  - `sanitizeFilename()` at `ingest.ts:95` strips path separators and control chars — good defense-in-depth even for a single-user system (file would land on disk, not DB, so path traversal would be the attack).
  - No finding above Medium.

### Path 3: LLM call with tier fallback (LLMGatewayService.completeByTask)
- **Entry point:** `packages/shared/src/services/llm-gateway.ts:284`
- **Layers:** `resolveByTask()` (task_routing -> model_tiers) -> `completeWithTierFallback()` (recursive, max 2 hops) -> per-tier client resolution via `getClientForTier()` (caches `openai_compat` clients by tier key) -> SDK call (Anthropic or OpenAI) -> `ai_audit_log` write -> budget check on next call.
- **Findings:**
  - **Positive:** `checkBudget()` short-circuits for `anthropic` (subscription) and `ollama` (free). Only paid-API calls hit the budget path.
  - **Positive:** `isModelLoadingError()` at line 57 narrows to "Loading model / warming up" patterns — llama.cpp cold-start-specific — and retries 3× with 3s/6s/12s backoff on the SAME tier. Transient API errors follow a different path via `shouldAttemptFallback()` at line 688, which correctly matches 429/500/502/503/rate-limit/overloaded/timeout/ECONNREFUSED/ETIMEDOUT.
  - **Positive:** Logs audit entry with `error` field on every failed attempt, so tier-hop debugging has full visibility.
  - **Positive:** Same-provider-only fallback constraint (documented at line 94-96) is explicit — an Anthropic failure will not hop to OpenAI, respecting tool_use block incompatibility.
  - **Concern (High-1):** `estimateTierCostUsd()` at line 38-41 returns 0 for everything. Inline comment says "defaults to $0 until per-tier cost config is added." Combined with the 2026-04-15 $100 incident, this remains a live gap — budget circuit-breaker runs on `getMonthlySpend()` which falls back to `queryLocalMonthlySpend()` aggregating `ai_audit_log.cost_usd`. If cost_usd is always 0, the circuit breaker is blind.
  - **Concern (High-2):** `callClaude` (`packages/shared/src/services/call-claude.ts`) is the legacy fallback path used by 5 skills (weekly-brief, memory-consolidation, daily-connections, drift-monitor, daily-sweep-skill). It does NOT log to `ai_audit_log` or check budget. When the `llmGateway` is available, skills prefer it, but the fallback path exists. If the gateway is not configured (e.g., local dev with only `ANTHROPIC_API_KEY`), the skill silently bypasses cost tracking entirely.

### Path 4: MCP tool dispatch (Streamable HTTP)
- **Entry point:** `packages/core-api/src/mcp/server.ts`
- **Layers:** Hono route at `/mcp` -> Bearer auth -> MCP SDK handler -> tool resolution (`search_brain`, `list_captures`, `brain_stats`, ...) -> activity-logger middleware -> response.
- **Findings:**
  - `get-capture`, `get-entity`, `list-entities`, `get-weekly-brief` all have local try/catch returning `null` on parse errors — defensive and intentional (MCP spec: return null on tool failure).
  - No finding.

### Path 5: Search (hybrid FTS + vector + ACT-R decay + Hebbian + spreading)
- **Entry point:** `packages/core-api/src/routes/search.ts` -> `packages/core-api/src/services/search.ts`
- **Layers:** Zod validation -> `SearchService` -> embedding (via `EmbeddingService`) -> parallel FTS + vector queries + RRF fusion -> ACT-R temporal decay (`applyTemporalDecay` at `services/search.ts:79`) -> Hebbian association boost (`recentCaptureIds`) -> optional `includeRelated` spreading activation via `spreading_activation` SQL function.
- **Findings:**
  - `sql` template usage is parameterized throughout (no `sql.raw` except one numeric-only injection at `update-access-stats.ts:191`).
  - `temporalWeight` defaults to 0.0 (cold-start safe) as documented in CLAUDE.md.
  - No finding.

---

## Error Handling Audit

**Summary:** Error handling is consistently strong. 20 `} catch {` blocks in production TS — I inspected each:
- `workers/lib/backup-retention.ts:115` — `readdir` absence => empty backup list (sensible default).
- `voice-capture/server.ts:57`, `slack-bot/server.ts:46`, `slack-bot/services/dm-blocks.ts:73` — degradation of optional subsystems.
- `core-api/mcp/tools/*.ts` — MCP spec: return `null` on tool failure, don't throw across MCP boundary.
- `workers/jobs/extract-entities.ts:25` — LLM returned non-JSON; log warning + return empty extraction.
- `web/lib/theme.ts:15`, `web/lib/sse.ts:82` — browser storage / SSE parse failures (UI degradation only).
- `slack-bot/lib/safe-handle.ts:22` — explicit `/* swallow double-fault */` comment. Intentional.
- `core-api/services/entity-resolution.ts:294` — LLM JSON parse fallback. Same pattern as extract-entities.

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `workers/src/skills/memory-consolidation.ts:360` | 360 | `callClaude` fallback path bypasses `ai_audit_log` / budget check (only reachable if `llmGateway` not configured) | High |
| `workers/src/skills/weekly-brief.ts:99` | 99 | Same — fallback path silently bypasses cost tracking | High |
| `workers/src/skills/daily-connections.ts:152`, `daily-sweep-skill.ts:166`, `drift-monitor.ts:174` | | Same pattern | High |
| `shared/src/services/llm-gateway.ts:38` | 38 | `estimateTierCostUsd` returns 0 for all tiers — makes budget breaker unreliable | High |
| `core-api/src/routes/ingest.ts:111` | 111 | TODO stub `dispatchToSidecar` marked "CS3.11 owns the service layer extraction" — still stubbed | Medium |
| `scripts/utility-pipeline.py:642` | 642 | TODO: "Parse CSV files, aggregate daily/monthly kWh, store in power_readings table" — missing functionality | Medium |

---

## Technical Debt Register

| ID | Type | Description | File | Business Impact | Remediation Cost |
|----|------|-------------|------|----------------|------------------|
| D1 | Design | `scripts/financial-pipeline.py` is a 3,035-LOC god module mixing 8+ distinct concerns (Plaid sync, 7 CSV parsers, balance snapshots, investment reports, monthly synthesis, inbox processing). 45 top-level functions. | `scripts/financial-pipeline.py` | Any change forces full re-test. High regression risk as new account types added. | Medium (2-3 days): decompose into `scripts/lib/financial/{parsers,plaid_sync,reports,inbox}.py` |
| D2 | Design | `workers/src/jobs/skill-execution.ts` has 540 LOC, 20-case switch. Adding a skill requires edits in 3 files (this + routes/skills.ts + scheduler.ts). Author aware (JSDoc note). | `packages/workers/src/jobs/skill-execution.ts:97-504` | Each new skill is boilerplate ~20 LOC in the switch; small mistakes cascade. | Small (1 day): registry pattern, `BaseSkill.register(name)` + input schema on the class |
| D3 | Design | `packages/web/src/lib/api.ts` — 1,227 LOC single file owns entire API surface. Redeclared union types (`IngestSourceType`, `FileUploadStatus`, `CaptureSource`) with a drift-guard for 2 of 3. | `packages/web/src/lib/api.ts` | Growing churn zone; drift-guard does NOT cover `CaptureSource` (flagged in intake). | Medium: split by domain (`api/captures.ts`, `api/search.ts`, ...) + extend drift-guard to `CaptureSource` |
| D4 | Design | `packages/web/src/pages/Email.tsx` — 905 LOC single component. `Wiki.tsx`, `Ingest.tsx`, `Dashboard.tsx` similar. | web pages | Hard to test in isolation; state refactors risky. | Small per page (~half day each): extract child components |
| D5 | Design | `callClaude` (`shared/src/services/call-claude.ts`) is legacy path used by 5 skills. Bypasses `ai_audit_log` and `checkBudget`. | 5 skill files | **Cost-incident risk (repeat of 2026-04-15 $100 event).** Audit log gaps on fallback path. | Small (1 day): route all `callClaude` callers through `LLMGatewayService.completeByTask`, remove `callClaude` or wrap it with audit write |
| D6 | Design | `estimateTierCostUsd` hard-returns 0. All budget circuit-breaker logic depends on this being accurate. | `packages/shared/src/services/llm-gateway.ts:38-41` | Budget hard-limit ($50) effectively unmonitorable unless `LLM_SPEND_URL` is set. | Small (1 day): populate from tier's `cost_per_1k` field (already present in `ai-routing.yaml`) |
| D7 | Design | Filename-routing heuristics duplicated between `packages/core-api/src/routes/ingest.ts:73-92` and `scripts/financial-pipeline.py` + `scripts/utility-pipeline.py`. Python `scripts/lib/ingest_router.py` exists but TS side has its own copy. | 3 locations | Add a new account type → touch 3 files, easy to forget one. | Medium (2 days): extract TS `services/ingest-router.ts`, import from both the sidecar worker and the upload route |
| D8 | Design | Web UI has three large page files that redeclare status color/icon maps (Email, Ingest, Wiki). | `packages/web/src/pages/*.tsx` | Inconsistent visual language risk. | Small: extract `web/src/lib/status-styles.ts` |
| D9 | Test | `voice-pipecat` pyright scoped out (9 errors per intake: redis.asyncio stubs + Anthropic ContentBlock union narrowing). `scripts/` pyright scoped out entirely (20 ops scripts). | `pyproject.toml` TODO comment | Type regressions in these paths invisible to CI. | Medium: each deferred |
| D10 | Test | `tests/validate-t0-classification.test.ts` is a single top-level test outside the package test runner structure. | `tests/` | Orphaned; may not run in normal CI. | Trivial: move into relevant package or delete |
| D11 | Dependency | `@anthropic-ai/sdk ^0.39.0` is pinned at an older major. Anthropic SDK has shipped several minor bumps since. | All packages | Minor features + bug-fixes unavailable; tool-use format has evolved. | Small (half day): bump + run all skill tests |
| D12 | Dependency | `vitest ^1.6.0`; Vitest 3.x is current. Breaking changes in 2.x (config API) and 3.x. | All packages | Missing perf improvements; eventual upgrade cost grows. | Medium (1-2 days including config migration) |
| D13 | Documentation | `scripts/utility-pipeline.py:642` has an unaddressed TODO about power readings storage. | `scripts/utility-pipeline.py` | Feature gap; power reading CSV ingestion is a known hole. | Small (1 day) if prioritized |
| D14 | Documentation | `senders.xlsx` at repo root is gitignored and contains PII per intake, but its presence in the tree might confuse contributors. | repo root | Low impact — user-facing artifact. | Trivial: move to `data/` or document in CLAUDE.md |
| D15 | Dependency | Some TS packages have `@vitest/coverage-v8 ^1.6.1` but top-level only has `vitest ^1.6.0`. Version drift of ~.1 is fine, but worth validating in the eventual 3.x bump. | `packages/*/package.json` | Nil today, minor future friction. | Trivial |

---

## Code Quality Assessment

| Dimension | Score (1-5) | Evidence |
|-----------|-------------|----------|
| Naming and readability | 5 | `LLMGatewayService`, `MemoryConsolidationSkill`, `BaseSkill`, `createLogger`, `applyTemporalDecay` — all self-documenting. Abbreviations rare (`bws`, `RRF`, `FTS`, `MCP`) and always documented. File names match class names. |
| Layering discipline | 4 | Clean `routes -> services -> shared` in core-api; skills inherit from `BaseSkill`/`LLMSkill`; `ConfigService` owns config; no reverse dependencies. **Minor:** `skill-execution.ts` imports all 20 skill classes directly — a registry would decouple. |
| Error handling | 5 | Centralized `AppError` taxonomy. Global `errorHandler` mounted via `app.onError()`. All `} catch` blocks inspected — either structured-log + defaults, or intentionally swallowed with explanatory comment. Zero `except Exception: pass` in Python. |
| Logging quality | 5 | Single `createLogger()` factory in `shared/src/lib/logger.ts` using pino. Structured fields everywhere (`logger.info({ skillName, durationMs }, 'skill complete')`). CLAUDE.md explicitly forbids per-package logger duplication, and discipline is upheld. Only console.log uses are device-code auth UX and a docstring example. |
| Documentation | 4 | Every service/skill has a file-level JSDoc explaining purpose, constraints, and usage patterns. Complex algorithms (ACT-R decay, RRF, Hebbian weights) have SQL-to-TS comments. Cross-references to `CLAUDE.md` operational rules. **Minor:** `scripts/` Python files have module docstrings but sparse function docstrings. |
| Testability | 5 | Every service takes dependencies via constructor (DI-friendly). Factories (`createApp()`, `createSkillExecutionWorker()`) accept optional dependencies. 135 test files covering all 20 skills and route groups. `BaseSkill` has dedicated unit tests. LLMGatewayService has a 628-line test file. Drift-guard test (`web-type-drift.test.ts`) is a clever correctness test without running code. |

---

## Security-Relevant Code Findings

(Code-level only; defers threat-model to Security Architect's findings.)

| File | Line | Issue | Severity | Remediation |
|------|------|-------|----------|-------------|
| `packages/core-api/src/routes/ingest.ts:95` | 95 | `sanitizeFilename` strips path separators / control chars — defense-in-depth correct | Low | N/A (clean) |
| `packages/workers/src/jobs/update-access-stats.ts:191` | 191 | `sql.raw(String(staleDays))` — numeric cast, parameterized elsewhere — safe | Low | N/A (clean) |
| `docker/ingest-sidecar/trigger_server.py:228` | 228 | `hmac.compare_digest` for bearer token — constant-time compare, correct | Low | N/A (clean) |
| `packages/core-api/src/middleware/rate-limit.ts:136-146` | 136 | `getClientKey` trusts `X-Forwarded-For` first-hop, acceptable behind Cloudflare Tunnel | Low | N/A — document the trust boundary if reverse proxy ever changes |
| `packages/core-api/src/middleware/rate-limit.ts:159-167` | 159 | `BYPASS_CALLERS` Set widens with each integration (`email-worker`, `ingest`, `financial-pipeline`, `utility-pipeline`). Any service that sets `X-Open-Brain-Caller: internal:X` is fully bypassed. Single-user system, low risk. | Low | Document: bypass callers are trusted-only; never accept this header from unauthenticated public endpoint (currently, only MCP auth + Cloudflare Tunnel protects) |
| `scripts/lib/capture_api.py:70` | 70 | `allow_redirects=False` + explicit 3xx logging — correct defense against Cloudflare Access auth-redirect silent failures | Low | N/A (clean) |

**No high-severity code-level security findings.** The single-user context and narrow trust boundary (Bearer + Cloudflare Tunnel) make most typical web findings N/A.

---

## Dependency Audit

- **Major version drift worth planning:** `@anthropic-ai/sdk ^0.39.0` (current 0.x); `vitest ^1.6.0` (current 3.x). No hard-block, but track.
- **Minor/patch:** Most deps are on recent minors (`hono ^4.12.5`, `drizzle-orm ^0.45.1`, `openai ^4.98.0`, `@modelcontextprotocol/sdk ^1.27.1`, `bullmq ^5.0.0`, `ioredis ^5.10.0`, `pino ^10.3.1`).
- **Consistency:** All 6 TS package manifests use the same versions for shared deps — pnpm workspace is managed correctly.
- **Python:** Ruff `0.6.*`, pyright `1.1.*` — pinned in CI. `requirements.txt` for sidecar tests is minimal. FastAPI not pinned in `packages/file-ingestion/src/extract.py` imports — pyright reported clean, so it's resolving, but explicit pinning in a `requirements.txt` would avoid supply-chain surprises.
- **Lockfile hygiene:** `pnpm-lock.yaml` is committed. CI uses `--frozen-lockfile`. CLAUDE.md codifies "always commit lockfile after dep changes" — discipline upheld.

No known-vulnerable dependencies identified in current pinned versions. (No SCA tool available in this environment; see `.meta.json`.)

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 6 |
| Low | 6 |
| Total | 15 |

**High:**
- H1 = D5 (callClaude fallback bypasses audit/budget) — cost-tracking gap, repeat of 2026-04-15 incident root cause
- H2 = D6 (`estimateTierCostUsd` returns 0 — budget breaker blind unless external LLM_SPEND_URL is set)
- H3 = D3 web-side drift (`CaptureSource` not covered by drift-guard; already flagged in intake — 9-value union now in place but guard not extended)

**Medium:**
- M1 = D1 (financial-pipeline.py 3,035 LOC god module)
- M2 = D2 (skill-execution switch registry)
- M3 = D7 (ingest-router duplication TS ↔ Python)
- M4 = D4 (web page god components — Email.tsx, Wiki.tsx, Ingest.tsx, Dashboard.tsx)
- M5 = D11 (Anthropic SDK major version lag)
- M6 = D12 (Vitest major version lag)

**Low:**
- L1-L6 = D8, D9, D10, D13, D14, D15 (style maps extract, pyright scope-outs, orphan tests, utility-pipeline TODO, repo root PII file, vitest version minor drift)

---

## Top Three Priorities

1. **Fix cost-tracking gaps (H1+H2).** Route all `callClaude` callers through `LLMGatewayService.completeByTask` (or retain `callClaude` but wrap it with an `ai_audit_log` write + budget check). Populate `estimateTierCostUsd` from `ai-routing.yaml`'s `cost_per_1k` fields. This closes the door on a repeat of the 2026-04-15 incident. **~1 day.**
2. **Decompose `scripts/financial-pipeline.py` (M1).** Split into `scripts/lib/financial/{parsers,plaid_sync,reports,inbox}.py`. Each parser becomes its own module with its own tests. Unblocks clean addition of new account types without cross-contamination risk. **~2-3 days.**
3. **Extend drift-guard to `CaptureSource` (H3) and adopt registry pattern for skill-execution dispatch (M2).** Both are small, high-leverage wins. Drift-guard extension is trivial (extend the existing regex-based test). Skill registry replaces the 20-case switch with self-registration, making new skills a 1-file change. **~1 day combined.**
