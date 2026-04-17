# LLM Gateway Refactor — Implementation Plan

**Created:** 2026-04-17
**Source:** Ultra-plan analysis (conversation session 2026-04-17)
**Parent issue:** A59 (summary synthesis 401) root-cause investigation
**Status:** Draft — not yet started
**Related state file:** `.implement-plan-state.json` exists for a prior, unrelated plan (`IMPLEMENT_REFACTOR_2026-04-16.md`). That plan's remaining items (7.1–7.3) are Phase-7 consolidation work deferred until parallel email validation completes; they do NOT conflict with this plan. This plan creates its own state file on first run.

## Goal

Eliminate the dual-routing design debt in `LLMGatewayService` so that:

1. Every LLM call goes through one path (`completeByTask(prompt, taskName)`).
2. An unrouted task name is a loud deployment error, not a silent fall-through.
3. Client identity lives in tier config (`base_url` + provider), not in global `LITELLM_*` env vars.
4. Env var names reflect reality (`OPENAI_API_KEY`, not `LITELLM_API_KEY` aimed at `api.openai.com`).
5. The existing 401s on email-classify's daily digest stop.

## Out of scope

- Replacing BullMQ, pgvector, or any LLM provider.
- Migrating embeddings off OpenAI (D42 defers this until RTX PRO 2000 arrives).
- Removing LiteLLM spend tracking if `LLM_SPEND_URL` still points at a real proxy (renamed, not removed).
- Restructuring `ai-routing.yaml` beyond the specific edits listed in Phase A.
- Any work unrelated to the gateway.

## Preconditions

- Branch off `main` at `5625280` or later.
- Before Phase E deploy: `.env.secrets` on homeserver has `OPENAI_API_KEY=<real-openai-sk-key>` retrieved from Bitwarden item `open-brain-openai-api-key`. Not the `sk-litellm-…` virtual key.
- Full test suite green on `main` before starting (2,585 tests as of PR #78).

## Success criteria

1. All unit + integration tests pass (target: same 2,585+ count, no new failures).
2. Deliberately-unrouted task name throws `LLMGatewayError('Task <name> has no routing entry')` in a test.
3. Manual `email-classify` run on homeserver: logs show `completeByTask('email_daily_digest') → t1_spark`; daily digest capture lands in DB with `capture_type: 'observation'`; zero 401s; zero 400s on capture POST.
4. `grep -r 'LITELLM' packages/ docker-compose.yml` returns only comments/memory-file references (no active code using the old names).
5. Gateway constructor no longer takes a `litellmClient` argument.

---

## Phase A — Register canonical task names + fix capture body

**Intent:** Low-risk prep work that does NOT touch gateway code. After this phase, the A59 symptom is cured even without the rest of the refactor, via the simple routing fix.

**Items:**

### A.1 Expand `task_routing:` in `config/ai-routing.yaml`

Add entries for every task name currently used in production code:

```yaml
task_routing:
  # … existing entries stay …
  email_daily_digest: t1_spark   # NEW — replaces email-classify's stray 'synthesis' call
```

Verify that every other `completeByTask(prompt, '<name>')` call site already has a matching `task_routing:` entry. Grep:

```bash
rg "completeByTask\(\w+,\s*['\"]([^'\"]+)['\"]" -o --no-filename packages/ \
  | sort -u
```

Expected set (from Phase 1 investigation): `intent_classification`, `capture_classification`, `brain_view_classification`, `voice_classification`, `confidence_gating`, `question_detection`, `email_classification`, `entity_extraction`, `entity_linking`, `capture_enrichment`, `search_synthesis`, `daily_sweep`, `mcp_context`, `auto_response_draft`, `wiki_ingest`, `wiki_synthesis`, `daily_connections`, `drift_monitoring`, `weekly_brief`, `governance`.

Add `email_daily_digest` to the list; confirm no other gaps.

**Result (A.1):** Added `email_daily_digest: t1_spark` to `config/ai-routing.yaml` under the "Complex but routine -> Spark" group (after `drift_monitoring`). Audit grep against `packages/` found the following unique task-name literals passed to `completeByTask`: `confidence_gating`, `daily_connections`, `daily_sweep`, `drift_monitoring`, `email_classification`, `entity_extraction`, `entity_linking`, `governance`, `intent_classification` (tests only), `search_synthesis`, `synthesis` (the stray in `email-classify.ts:463`, to be fixed in A.2), `weekly_brief`. Every non-stray task name is already present in `task_routing`. Unused-but-preregistered keys (`capture_classification`, `brain_view_classification`, `voice_classification`, `question_detection`, `capture_enrichment`, `mcp_context`, `auto_response_draft`, `wiki_ingest`, `wiki_synthesis`) are left in place — they are expected to be wired up by other consumers or future work. No silent renames applied.

### A.2 Update `email-classify.ts` call site

`packages/workers/src/skills/email-classify.ts:463`:

```ts
// Before:
summaryText = await this.llmGateway.completeByTask(prompt, 'synthesis', { maxTokens: 1024 })
// After:
summaryText = await this.llmGateway.completeByTask(prompt, 'email_daily_digest', { maxTokens: 1024 })
```

**Result (A.2):** Rename applied at line 463 in `packages/workers/src/skills/email-classify.ts`; `'synthesis'` → `'email_daily_digest'`, prompt and options unchanged.

### A.3 Add `capture_type` to daily-digest capture body

`packages/workers/src/skills/email-classify.ts:476-485`:

```ts
const captureBody = {
  content: `[Email Daily Digest] ${today}\n\n${summaryText}`,
  capture_type: 'observation',   // NEW
  source: 'email',
  source_metadata: {
    type: 'daily_digest',
    date: today,
    email_count: emailCount,
    categories,
  },
}
```

**Result (A.3):** `capture_type: 'observation'` added as the second property (immediately after `content`, before `source`) in the `captureBody` object literal inside `generateAndPostSummary()`.

### A.4 Audit sibling skills for the same omission

Grep for POSTs to `/api/v1/captures` across `packages/workers/src/skills/`:

```bash
rg "/api/v1/captures" packages/workers/src/skills/ -l
```

For each hit, verify `capture_type` is present in the body. Fix any miss with the appropriate enum value (`observation` for digests/summaries, `reflection` for briefs).

**Result (audit 2026-04-16):**

Files inspected (all POSTs to `/api/v1/captures` under `packages/workers/src/skills/`, excluding `email-classify.ts` which is being fixed in A.2/A.3):

| File | `capture_type` status | Value used | Notes |
|---|---|---|---|
| `weekly-brief.ts` | PRESENT | `'reflection'` | Line 166. Weekly brief output — correct per guidance (briefs/reflections). |
| `monthly-reflection.ts` | PRESENT | `'reflection'` | Line 462. Monthly reflection capture — correct. |
| `memory-consolidation.ts` | PRESENT | `'reflection'` | Line 442. Consolidated merge capture. Note: source is `'consolidation'`; `capture_type` stays within enum. |
| `drift-monitor.ts` | PRESENT | `'reflection'` | Line 289. Drift analysis capture. |
| `daily-sweep-skill.ts` | PRESENT | `'reflection'` | Line 249. Evening summary — arguably could be `'observation'`, but existing value is in-enum and not our scope to second-guess. |
| `daily-connections.ts` | PRESENT | `'reflection'` | Line 265. Cross-capture connections. |

**No edits required.** All 6 sibling skills already set `capture_type` to a valid enum value. `email-classify.ts` was the only offender, being fixed separately in A.2/A.3. No test files needed updating because no production code changed.

### A.5 Tests

- Unit test: `email-classify.test.ts` — assert the prompt is dispatched via `'email_daily_digest'` task name and the capture body includes `capture_type: 'observation'`.
- All existing tests still pass.

**Checkpoint:** commit + run full workspace test suite. Deploy-ready but do NOT deploy yet — Phase A is safe to deploy alone, but we want to bundle with B+C+D.

**Verification:** `pnpm --filter @open-brain/workers exec vitest run email-classify` passes. `pnpm -r test` still green.

**Result (A.5):** Extended the existing `'posts daily summary as capture when not dry run'` test in `packages/workers/src/__tests__/email-classify.test.ts` (rather than adding a duplicate case) with two new assertions after the existing fetch-shape check:

1. `llmGateway.completeByTask` was called with the literal task name `'email_daily_digest'` (not the legacy `'synthesis'` alias), plus the expected `maxTokens: 1024` option. The spy is retrieved from `makeSkill({ withLLM: true })`'s returned `llmGateway` handle.
2. The `POST /api/v1/captures` fetch call's body parses to an object matching `{ capture_type: 'observation', source: 'email', source_metadata: { type: 'daily_digest', ... } }`, with `content` being a string starting with `[Email Daily Digest]`. The test now locates the capture POST by URL-suffix match against `fetch.mock.calls` so it is resilient to other fetches occurring in the same run.

Targeted file result: `src/__tests__/email-classify.test.ts` — 16 tests passed (16 total). Full workers suite: 980 passed / 980 total across 49 test files. No other tests required changes; no regressions introduced. Only the test file was modified — no source under `packages/workers/src/skills/` was touched in this sub-step.

---

## Phase B — Make `completeByTask` throw on unrouted tasks

**Intent:** Remove the `aliasMap` silent-fallback path. Unrouted task becomes a loud error.

### B.1 Modify `packages/shared/src/services/llm-gateway.ts`

Change `completeByTask`:

```ts
async completeByTask(prompt: string, taskName: string, options: LLMCompleteOptions = {}): Promise<string> {
  const resolution = this.resolveByTask(taskName)
  if (!resolution) {
    throw new LLMGatewayError(
      `Task '${taskName}' has no routing entry. Add it to task_routing: in config/ai-routing.yaml.`,
    )
  }
  return this.completeWithTierFallback(prompt, taskName, resolution, options, 0)
}
```

Delete the `aliasMap` constant entirely.

**Result (B.1):** `completeByTask` in `packages/shared/src/services/llm-gateway.ts` now throws `LLMGatewayError('Task \'<name>\' has no routing entry. Add it to task_routing: in config/ai-routing.yaml.')` when `resolveByTask()` returns null. The ~27-line `aliasMap` silent-fallback block (including the debug-log line and call to legacy `complete(prompt, alias, options)`) was deleted. Legacy `complete()` method body retained untouched (Phase C scope).

### B.2 Update tests

`packages/core-api/src/__tests__/llm-gateway.test.ts`:
- Add a positive test: `completeByTask('unregistered_task_xyz')` rejects with `LLMGatewayError` and message matching `/has no routing entry/`.
- Delete / rewrite any test that asserts the legacy-alias-fallback behavior (there's one: "falls back to legacy alias routing when three-tier is not configured"). Replace it with an assertion that when three-tier routing is NOT configured, `completeByTask` throws (it should — there's no legacy path to fall back to).

**Result (B.2):** In `packages/core-api/src/__tests__/llm-gateway.test.ts`: (1) rewrote existing test `'falls back to legacy alias routing when three-tier is not configured'` → `'throws LLMGatewayError when three-tier routing is not configured'` — now asserts the throw + `/has no routing entry/` message + that `anthropic.messages.create` is never called; (2) added new test `'throws LLMGatewayError when task has no routing entry'` using task name `'unregistered_task_xyz'` and verifying no client was invoked.

### B.3 Verify no production caller depends on the removed behavior

Grep every `completeByTask` call and confirm the task name string exists in `task_routing:` (Phase A ensured this).

**Result (B.3):** Ran `grep -rhE "completeByTask\([^,]+,\s*['\"][^'\"]+['\"]" packages/ --include="*.ts"` and extracted unique task-name literals: `confidence_gating`, `daily_connections`, `daily_sweep`, `drift_monitoring`, `email_classification`, `email_daily_digest`, `entity_extraction`, `entity_linking`, `governance`, `intent_classification` (test-only), `search_synthesis`, `unregistered_task_xyz` (test-only, deliberate), `weekly_brief`. Cross-referenced against `task_routing:` in `config/ai-routing.yaml`: every production literal has a matching entry. **0 gaps.** The only literal not in task_routing is `unregistered_task_xyz`, which is the new B.2 test case designed to assert the throw.

**Checkpoint:** commit + run full test suite.

**Verification:** no tests fail. No skill breaks at dev-time.

**Test counts (post-B.1/B.2/B.3):** shared 257/257 passed (14 files). core-api 701/701 passed (40 files). workers 980/980 passed (49 files). All green. No unintended regressions.

---

## Phase C — Delete legacy `complete()` and decouple gateway from `litellmClient`

**Intent:** Remove all code whose only purpose was to serve the deleted silent-fallback path. Stop requiring a global litellm client to construct the gateway.

### C.1 Delete public method `complete(prompt, alias, options)` in `llm-gateway.ts`

Remove:
- `complete()` method body (~110 LOC).
- `completeFallback()` helper (~55 LOC).
- `shouldAttemptFallback()` (retained ONLY for the tier-fallback path — keep if still referenced by `completeWithTierFallback`, otherwise remove). Audit usage; it's used in the tier-fallback path, so keep it.
- `completeWithPromptTemplate()` + `completeAndRender()` (~40 LOC, zero production callers).
- `resolveClient()` and `getEntry()` (legacy helpers).
- `LLMModelAlias` type.

### C.2 Remove `litellmClient` constructor argument

Update constructor:

```ts
constructor(
  configService: ConfigService,
  db: Database,
  templateCache: TemplateCache,
  anthropicClient?: Anthropic | null,
  ollamaClient?: OpenAI | null,
) {
  // no litellmClient field
  ...
}
```

Update `getOpenAIClient()` — it currently falls back to `this.litellmClient`. With the litellm client removed, callers that need an OpenAI-compat client for a tier MUST go through `getClientForTier()`, which builds from the tier's `base_url`. Any code path that falls through to `getOpenAIClient()` without a tier is dead after Phase B and should be removed.

### C.3 Update `core-api/src/index.ts`

Current (line 75–94):
```ts
const litellmClient = createLiteLLMClient({ baseUrl: litellmUrl, apiKey: litellmApiKey })
...
if (litellmClient) {
  llmGateway = new LLMGatewayService(litellmClient, configService, db, templateCache, anthropicClient, ollamaClient)
  ...
}
```

After:
```ts
llmGateway = new LLMGatewayService(configService, db, templateCache, anthropicClient, ollamaClient)
governanceEngine = new GovernanceEngine(llmGateway, templateCache)
```

The gateway is always constructed (no conditional on `litellmClient`). If any tier uses `provider: 'litellm' | 'openai'`, it gets its client via `getClientForTier()` from its own `base_url` — but currently no tier does that (all tiers use `anthropic`, `ollama`, or `openai_compat`). If we add one later, it declares `base_url: https://api.openai.com/v1` + `provider: openai_compat` with its own key handling.

### C.4 Update tests in `core-api/src/__tests__/llm-gateway.test.ts`

- Constructor test signatures change — drop the first positional arg in every `new LLMGatewayService(...)`.
- Delete "constructor with only litellm client" test.
- Delete all "legacy complete()" tests (the `describe('legacy complete() with ollama client')` block, ~40 lines).
- Keep all `completeByTask`, tier-fallback, model-loading-retry, and budget tests.

### C.5 Update `GovernanceEngine` + other consumers

Grep for `new LLMGatewayService` — update each call site to the new signature. Expected: just `core-api/src/index.ts` and test files.

**Checkpoint:** commit + full test suite + type-check all packages.

**Verification:** `pnpm -r build` succeeds; `pnpm -r test` green.

---

## Phase D — Rename LiteLLM → OpenAI

**Intent:** Make names match reality. Decouple embedding service's constructor from legacy naming. Rename env vars.

### D.1 Rename `litellm-client.ts` → `openai-client.ts`

`packages/shared/src/services/litellm-client.ts`:
- File rename.
- Function: `createLiteLLMClient` → `createOpenAIClient`.
- Type: `LiteLLMTimeoutTier` → `OpenAITimeoutTier`.
- Constants: `DEFAULT_LITELLM_URL` → `DEFAULT_OPENAI_URL` (= `https://api.openai.com/v1`).
- Env vars read: `OPENAI_API_KEY` (instead of `LITELLM_API_KEY`), `OPENAI_BASE_URL` (instead of `LITELLM_URL`).
- Update `packages/shared/src/services/index.ts` export.

**Transition shim:** for one commit (reverted in the same PR), the factory reads `process.env.OPENAI_API_KEY ?? process.env.LITELLM_API_KEY` and logs a `warn` if it fell back to the old name. Keeps the deploy window survivable. Same for `OPENAI_BASE_URL ?? LITELLM_URL`. Remove shim at the end of Phase D.

### D.2 `EmbeddingService` constructor object-style

`packages/shared/src/services/embedding.ts`:

Before:
```ts
constructor(baseUrl: string, apiKey: string, configService: ConfigService)
```

After:
```ts
interface EmbeddingServiceOpts {
  baseUrl?: string  // defaults to OPENAI_BASE_URL env, then https://api.openai.com/v1
  apiKey: string
  configService: ConfigService
}
constructor(opts: EmbeddingServiceOpts) {
  const baseURL = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  this.client = new OpenAI({ baseURL, apiKey: opts.apiKey, timeout: EMBEDDING_TIMEOUT_MS, maxRetries: 0 })
  ...
}
```

### D.3 Update all call sites

- `packages/core-api/src/index.ts`:
  - `litellmUrl`/`litellmApiKey` consts → `openaiBaseUrl`/`openaiApiKey`, reading `OPENAI_BASE_URL`/`OPENAI_API_KEY`.
  - `new EmbeddingService(litellmUrl, litellmApiKey, configService)` → `new EmbeddingService({ apiKey: openaiApiKey, configService })`.
  - `createLiteLLMClient(...)` → deleted (gateway no longer needs it).
- `packages/workers/src/jobs/extract-entities.ts`:
  - `createLiteLLMClient(...)` → `createOpenAIClient(...)`.
  - Error-message string: "No LLM client configured — both ANTHROPIC_API_KEY and LITELLM_API_KEY missing" → "both ANTHROPIC_API_KEY and OPENAI_API_KEY missing".
- `packages/voice-capture/src/server.ts`:
  - `LITELLM_API_KEY` warn → `OPENAI_API_KEY`.
- `packages/voice-capture/src/services/classification.ts`:
  - `createLiteLLMClient({ timeout: 'fast' })` → `createOpenAIClient({ timeout: 'fast' })`.
  - Fallback `baseURL: process.env.LITELLM_URL ?? 'https://llm.k4jda.net'` → `baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'`.
- `packages/slack-bot/src/server.ts`:
  - Since slack-bot now routes via gateway's `completeByTask`, drop the direct `litellmUrl/litellmApiKey` client and the `IntentRouter`'s direct config. Route intent classification through the gateway.
  - If this is too much scope for the same PR, keep slack-bot's direct client for now but rename its env vars to match. Decision: **keep the direct client but rename envs**; gateway-ification of slack-bot is a follow-up ticket.
- `packages/slack-bot/src/intent/router.ts`:
  - `litellm_url` param → `openai_base_url` or simply load from env at construction. Update type + test file.
- `packages/workers/src/jobs/budget-check.ts`:
  - `LITELLM_SPEND_URL` → `LLM_SPEND_URL`.
  - `LITELLM_API_KEY` (for spend auth) → `LLM_SPEND_API_KEY` (new, distinct — the spend proxy might have a different key than the inference API).
  - Clarify comment block distinguishing inference creds (`OPENAI_API_KEY`) vs. spend-tracking creds (`LLM_SPEND_API_KEY`).

### D.4 YAML: `litellm_url` removal

`config/ai-routing.yaml`:
- Delete `litellm_url:` top-level field (only consumers were embedding service + slack-bot; both now read env).
- Delete `models:` scalar entries (`fast`, `synthesis`, `governance`, `intent`, `conversation`, `wiki_agent`).
- Keep `models.embedding` for now, OR elevate it to a top-level `embedding:` key. Decision: **keep it under `models:` as an exception** to minimize schema churn — embedding config is orthogonal and doesn't intersect with the legacy-alias gateway concerns any more.

### D.5 `docker-compose.yml` env renames

Across all 4 services (core-api, workers, slack-bot, voice-capture):
- `LITELLM_URL` → `OPENAI_BASE_URL`
- `LITELLM_API_KEY` → `OPENAI_API_KEY`
- `LITELLM_SPEND_URL` → `LLM_SPEND_URL` (add if not present; remove `LITELLM_SPEND_URL` if it exists)

### D.6 Deploy-time homeserver secret update (documented, not automated)

Add to Phase E runbook:
1. SSH homeserver.
2. Edit `/mnt/user/appdata/open-brain/.env.secrets`:
   - Replace `LITELLM_API_KEY=sk-litellm-…` with `OPENAI_API_KEY=<real-key-from-Bitwarden-open-brain-openai-api-key>`.
   - Replace `LITELLM_URL=…` with `OPENAI_BASE_URL=https://api.openai.com/v1` (or delete — default works).
3. Verify: `bws secret list | grep open-brain-openai-api-key` returns the correct real key.

### D.7 Tests

- Update test fixtures that hardcode `LITELLM_*` env var names or pass `litellm_url` to mocked configs.
- `embedding-service.test.ts` — update to object-style constructor.
- `llm-gateway.test.ts` — verify no references to litellm in test setup; the service behavior is unchanged (tier-based routing).
- `budget-check.test.ts` — update env var cleanup blocks to use new names.

### D.8 Startup validation

In `core-api/src/index.ts` and `workers/src/main.ts`: add a startup check — if `process.env.OPENAI_API_KEY` starts with `sk-litellm-` (old proxy virtual key pattern), log a loud error and refuse to initialize OpenAI-dependent services. Detects the most obvious deploy mistake.

**Checkpoint:** commit + full test suite + typecheck. Delete the transition shim from D.1 in a follow-up commit in this phase.

**Verification:**
- `rg 'LITELLM_' packages/ docker-compose.yml` returns only comments or test fixtures that document-history.
- `rg 'createLiteLLMClient|litellmClient' packages/` returns nothing in production code (test mocks may still reference but should be renamed).
- `pnpm -r build && pnpm -r test` green.

---

## Phase E — Deploy and validate on homeserver

**Intent:** Ship all of A-D atomically to homeserver and verify the live fix.

### E.1 Pre-deploy checklist

- [ ] Branch merged to `main` (or PR approved, ready for squash-merge).
- [ ] `.env.secrets` on homeserver has `OPENAI_API_KEY=<real-key>` (D.6). Verify with: `ssh homeserver.k4jda.net 'sudo docker exec open-brain-workers printenv | grep -E ^OPENAI'` AFTER deploy, but the secret must be set BEFORE deploy.
- [ ] LAB_NOTEBOOK Entry 060 written with hypothesis + rollback.

### E.2 Deploy

```bash
ssh homeserver.k4jda.net
cd /mnt/user/appdata/open-brain
git pull --ff-only
sudo docker compose build core-api workers slack-bot voice-capture
sudo docker compose up -d
```

### E.3 Validate

1. `sudo docker logs --since 2m open-brain-workers 2>&1 | grep -iE 'gateway|openai|task_routing'` — verify clean startup, no "LITELLM" messages.
2. `sudo docker exec open-brain-workers printenv | grep -iE '^(openai|anthropic|ollama|llm)'` — verify renamed vars present and correctly valued.
3. Enqueue manual email-classify:
   ```bash
   sudo docker cp scripts/enqueue-email-classify.mjs open-brain-workers:/tmp/
   sudo docker exec open-brain-workers node /tmp/enqueue-email-classify.mjs
   ```
4. Monitor logs for:
   - `completeByTask('email_daily_digest') → t1_spark` (new task name, correct tier)
   - `Daily digest` capture successfully POSTed (no 400)
   - Zero `401 Incorrect API key` errors
   - Spark tier used for synthesis, $0 incurred
5. `sudo docker exec open-brain-postgres psql -U openbrain -d openbrain -c "SELECT id, capture_type, content FROM captures WHERE source='email' AND source_metadata->>'type' = 'daily_digest' ORDER BY created_at DESC LIMIT 1;"` — verify `capture_type = 'observation'`.

### E.4 Rollback (if validation fails)

```bash
cd /mnt/user/appdata/open-brain
git reset --hard <prior-sha>  # e.g., 5625280 (pre-refactor)
sudo docker compose build core-api workers slack-bot voice-capture
sudo docker compose up -d
# Restore prior .env.secrets (keep a backup before D.6)
```

Open an issue with the failure mode; do not re-attempt without diagnosis.

### E.5 Post-deploy

- Close A59 in LAB_NOTEBOOK.
- Update MEMORY.md pointer to the new naming (replace any `LITELLM_*` references).
- Delete `.implement-plan-state.json` (prior plan's state file, now unrelated) and `IMPLEMENT_REFACTOR_2026-04-16.md` — supersedes.

---

## Phase tracker

| Phase | Items | Status | Commit SHA |
|---|---|---|---|
| A | A.1 task_routing, A.2 email-classify name, A.3 capture_type, A.4 audit siblings, A.5 tests | In progress (A.1, A.4, A.2, A.3 done; A.5 pending) | — |
| B | B.1 throw on unrouted, B.2 tests, B.3 grep check | COMPLETE 2026-04-16 | — |
| C | C.1 delete legacy methods, C.2 drop litellmClient ctor arg, C.3 index.ts update, C.4 tests, C.5 consumer updates | Pending | — |
| D | D.1 openai-client rename, D.2 EmbeddingService ctor, D.3 call sites, D.4 YAML edits, D.5 compose renames, D.6 homeserver secrets doc, D.7 tests, D.8 startup validation | Pending | — |
| E | E.1 checklist, E.2 deploy, E.3 validate, E.4 rollback-if-needed, E.5 post-deploy | Pending | — |

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Unrouted `completeByTask` call slips past Phase A audit | Medium | High (crashes skill) | Add a CI grep that fails if a `completeByTask(x, 'literal_string')` call uses a string not present in ai-routing.yaml task_routing. Nice-to-have but defer to follow-up. |
| Env-var rename deploy ordering | Low | High (gateway won't init) | D.1 transition shim reads both names for one commit; D.8 startup validation catches wrong key pattern before service starts doing work. |
| Slack-bot intent router still uses direct OpenAI client after D.3 | Expected | None (by design, keep direct client, rename env only) | Documented as follow-up work. |
| Real OpenAI API key not actually in Bitwarden | Low | Blocks deploy | Pre-deploy check E.1 must verify Bitwarden has `open-brain-openai-api-key` with a real `sk-proj-…` or similar value. If missing, pause deploy and obtain from Troy. |
| Tests pass locally, fail on homeserver due to env drift | Low | Medium | Phase E.3 validation step 2 prints all env vars; compare against expected list. |

## Follow-up (explicitly NOT in this plan)

- Gateway-ify slack-bot intent classification (route via `completeByTask` instead of direct OpenAI client).
- CI task-routing consistency check (grep callers vs. YAML).
- Migrate embeddings to a local model when RTX PRO 2000 arrives (D42).
- Consolidate `ai-routing.yaml` schema — `embedding:` as a top-level key separate from `models:`.
- Sunset the `LLM_SPEND_URL` proxy path if real OpenAI's billing API is sufficient.

## Commits / branch strategy

- Branch: `refactor/llm-gateway-single-path` off `main` at current HEAD (`5625280`).
- Commits: one per phase (A, B, C, D); Phase D may be 2 commits (shim + shim-removal).
- PR: single PR, phases as individual commits for reviewable history.
- Squash-merge or keep phase commits on merge, reviewer's choice.

## Approval checkpoints

Stop and checkpoint with Troy before:
- Starting Phase E (deployment).
- Any deviation from this plan (e.g., discovering an unrouted task that doesn't fit an existing tier).
