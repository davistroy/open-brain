# IMPLEMENT_PHASE-P15b.md
# P15b — PRD + TDD v0.7: LiteLLM Scrub + Architectural Refresh

**Generated:** 2026-04-19  
**Gate:** 1 (Plan)  
**Phase card:** PHASED_PLAN.md § P15b  
**Dependency:** P15a (PR #148, merged `02c13ef`) — version strings + source enum + doc-status notes already in place  
**GitHub issue:** #111 (Theme 9 — Doc drift)  
**Effort estimate:** ~2 days (card says same; scope drift on counts only, see below)

---

## Scope Drift vs. Card

| Item | Card says | Actual (post-P15a) | Impact |
|------|-----------|--------------------|--------|
| PRD LiteLLM refs | "~80" | **83** | Trivial — slightly more work |
| TDD LiteLLM refs | "~118" | **134** | Trivial — slightly more work |
| Card total "198" | 198 | **217** | Arithmetic: card was written before P15a; count unchanged by P15a (only source enum + header edits). |
| Architecture Evolution section | "CS-α through CS-ι + Arc 6 hardening" | These labels exist in LAB_NOTEBOOK (Entries 079-089) but are NOT in current PRD/TDD at all. Must be authored from scratch. | No file drift — new authoring work as expected. |
| ADR index `docs/adr/` | "Either/or" optional | `docs/adr/` does not exist. | Optional per card — defer unless operator requests. ADR creation is out-of-scope for this PR unless specifically directed. |
| `gpt-5.4` model name | Referenced in card as current inference model | `ai-routing.yaml` uses `claude-haiku-4-5`, `claude-sonnet-4-6` — **NOT** `gpt-5.4` | **Scope drift — significant.** See note below. |

### Model name drift (requires operator clarification before implementing)

The card (and CLAUDE.md operational rules) states the inference model is `gpt-5.4`. The actual `config/ai-routing.yaml` as of HEAD uses:
- `t1_fast` → `claude-haiku-4-5-20251001` (Anthropic)
- `t2_quality` → `claude-sonnet-4-6` (Anthropic)
- `t1_jetson` / `t1_spark` → `qwen3.5` variants (local openai_compat)
- Embeddings → `text-embedding-3-large` via OpenAI API

There is no `gpt-5.4` anywhere in `ai-routing.yaml`. CLAUDE.md Key Architecture says `gpt-5.4` for all aliases, but the config contradicts this. The PRD/TDD v0.7 rewrite must use the **config file as the authoritative source**, not the stale CLAUDE.md entry.

**Action required before Gate 3:** Operator confirms whether CLAUDE.md's `gpt-5.4` reference is a stale artifact that should be scrubbed in a follow-on CLAUDE.md update, or whether the config was intentionally changed without updating CLAUDE.md. For the doc rewrite, implementer will use `ai-routing.yaml` as ground truth (Anthropic models per tier, not OpenAI).

**This is a scope-drift flag. Pausing for operator approval before Gate 2.**

---

## Deliverables

1. `docs/PRD.md` v0.7 — all 83 LiteLLM occurrences replaced; new "Architecture Evolution" section; Change Log entry; version bump to 0.7.
2. `docs/TDD.md` v0.7 — all 134 LiteLLM occurrences replaced; §8.2 + §8.3 + §8.7 rewritten; new sections for cognitive memory, autonomy levels, cost-tier routing, email pipeline, file ingestion; Change Log entry; version bump to 0.7.
3. `LAB_NOTEBOOK.md` — pre-action entry (before first commit) + result entry.
4. `docs/adr/` index — **DEFERRED** (optional per card; not in this PR unless operator directs).

---

## Work Items

### W1 — PRD v0.7: LiteLLM scrub (83 occurrences)

**File:** `docs/PRD.md`  
**Line ranges with LiteLLM concentration:**

| Lines | Context | Replacement strategy |
|-------|---------|----------------------|
| 23 | Executive summary — "routes all AI requests through a self-hosted LiteLLM proxy" | Replace with: "routes all AI requests through the OpenAI-compatible API (`api.openai.com/v1` for embeddings, local Jetson/Spark endpoints for inference) via `LLMGatewayService`." |
| 52, 57 | Product Principles 3 + strategic alignment bullet | Replace AI-agnostic LiteLLM principle with: cost-tiered processing (T0 Python → T1 local GPU → T2 Claude CLI → T3 API); `ai-routing.yaml` config-driven routing. |
| 69 | Differentiation list — "Local AI (LiteLLM for embeddings...)" | Replace with: "Local AI (Jetson 4B + Spark 35B for inference; `text-embedding-3-large` via OpenAI API for embeddings)" |
| 203-205 | Feature table F07/F07a/F08 | Update F07 to "EmbeddingService via OpenAI `text-embedding-3-large` (768d MRL)"; rename F07a to "LLMGatewayService (cost-tiered AI routing)"; F08 becomes the four-tier task routing config. |
| 312 | Health endpoint description — "DB, Redis, LiteLLM" | Replace "LiteLLM" with "OpenAI API (embedding probe)" |
| 472 | `ai_audit_log` token_usage comment | Update: cost from `estimateTierCostUsd()` per `ai-routing.yaml` tier config, not LiteLLM /spend/logs |
| 569-621 | Pipeline config YAML blocks | Update `provider: litellm` → appropriate `provider: openai_compat` / `provider: anthropic` / `provider: ollama` per tier. Replace model aliases with actual tier names from `ai-routing.yaml`. |
| 754-840 | F07 Embedding Service, F07a LiteLLM Proxy, F08 AI Router sections | Full rewrite — see W1-detail below |
| 830-836 | Config YAML `litellm:` block | Replace with current `ai-routing.yaml` structure (model_tiers, task_routing, monthly_budget) |

**W1-detail: F07 / F07a / F08 rewrite (lines 754–840):**

```
#### F07: Embedding Service
Description: Generates vector embeddings using OpenAI `text-embedding-3-large` with
`dimensions: 768` API parameter (trained MRL — not naive truncation). Calls
`api.openai.com/v1/embeddings`. No fallback — if API unreachable, captures queue in
BullMQ and retry. schema: vector(768).

Acceptance:
- text-embedding-3-large with dimensions:768 returns 768d vectors (MRL trained)
- Adaptive truncation: 16K chars, halves to 2K min on OpenAI 400 "context length" error
- EmbeddingService uses OPENAI_API_KEY + OPENAI_BASE_URL env vars

#### F07a: LLMGatewayService (Cost-Tiered AI Routing)
Description: Application-layer service mapping task types to model tiers via
ai-routing.yaml. Four tiers:
- t0_local: Ollama qwen3.5:2b (free, deterministic fallback)
- t1_jetson: qwen3.5-4b on Jetson (free local GPU, classification tasks)
- t1_spark: qwen3.5-35b on DGX Spark (free, routine complex tasks)
- t1_fast: claude-haiku-4-5 Anthropic (paid, fast)
- t2_quality: claude-sonnet-4-6 Anthropic (paid, quality-critical only)
Cost tracking: estimateTierCostUsd() from tier cost_per_1k_* fields in config.
Budget: soft $20/month Pushover alert; hard $35 circuit breaker.

#### F08: AI Router / Task Routing Config
Description: Task-to-tier mapping in ai-routing.yaml task_routing section.
Classification tasks → t1_jetson; routine complex → t1_spark; quality-critical
(weekly_brief, governance, email_compose) → t2_quality.
```

### W2 — PRD v0.7: Architecture Evolution section (new)

**Insert location:** After § 14. Change Log, before Document Resolution Log  
**New section heading:** `## 15. Architecture Evolution`

Content to author (from LAB_NOTEBOOK entries 079-089 + MEMORY.md + PRs #88-#100 + #123-#148):

```markdown
## 15. Architecture Evolution

Open Brain launched with a LiteLLM proxy architecture (v1.0–v1.2) and has evolved
through multiple consolidation sprints to reach the current direct-API design (v1.5.0).

| Sprint | PRs | Key change |
|--------|-----|-----------|
| CS-α (web/shared contract drift fix) | #97 | Drift-guard test; type parity enforcement |
| CS-β (model alias resolution) | #98 | Shared model-resolver; alias resolution at init |
| CS-γ (sidecar test coverage) | #99 | Python sidecar pytest harness |
| CS-δ (vitest stability) | #96 | forks pool + minForks/maxForks; Windows CI race fix |
| CS-ε (stale-docs cleanup) | #100 | README + setup docs: LiteLLM proxy → OpenAI API direct |
| CS-ζ (F4 import-type — closed) | — | Experiment closed; no change |
| CS-η (source CHECK constraint) | #128 | captures.source: 9-value CHECK + pre-flight audit rule |
| CS-θ (Python lint CI) | #128 | Python sidecar lint+typecheck in CI |
| CS-ι (LLMGatewayService) | #128 | email-compose routed through gateway; callClaude removed |
| Arc 6 hardening | #123-#133 | P01-P07: infra hardening, rate limiting, scheduler spread, cognitive memory producer |

The central architectural shift: LiteLLM proxy at `llm.k4jda.net` (external service,
separate budget tracking, virtual API keys) → direct OpenAI API (`api.openai.com/v1`)
for embeddings + application-managed cost-tier routing via `ai-routing.yaml` for
inference. This eliminated a single-point-of-failure external dependency and enabled
fine-grained per-task cost control.
```

### W3 — TDD v0.7: LiteLLM scrub (134 occurrences)

**File:** `docs/TDD.md`  
**High-density sections:**

| Section | Lines (approx) | Replacement |
|---------|---------------|-------------|
| §1.1 Technical Overview body | 45 | Replace LiteLLM proxy summary with LLMGatewayService + four-tier description |
| §1.3 Technical Approach Summary | ~63-82 | Update tech stack table (LiteLLM row → LLMGatewayService) |
| §2.1 Infrastructure Dependencies | ~129-145 | Remove LiteLLM from deps table; add LLMGatewayService note |
| §2.2 External Service Dependencies | ~146-157 | Remove LiteLLM external service; update Anthropic/OpenAI rows to show direct API |
| §6.2 Service Class Specifications | ~2225+ | EmbeddingService + LLMGatewayService descriptions |
| §6.3 Sequence Diagrams | ~2444-2491 | Update participant labels: `LiteLLM(embed)` → `OpenAI(embed)`, `LiteLLM(llm)` → `LLMGatewayService` |
| §8.2 Embedding Service | 2576-2599 | Full rewrite (see W3-detail) |
| §8.3 Anthropic API Integration | 2600-2620 | Retitle to "Inference Tiers (LLMGatewayService)"; rewrite |
| §8.7 LiteLLM Integration | 2697-2735 | Full rewrite → "§8.7 LLMGatewayService & Cost-Tier Routing" |
| §12 Service Implementations | ~3200+ | Constructor params: `litellmClient` → per-tier OpenAI clients |
| §16.3 Environment Configuration | ~3959-3993 | `LITELLM_URL` / `LITELLM_API_KEY` → `OPENAI_API_KEY` / `OPENAI_BASE_URL` |
| Appendix A Glossary | ~4255-4275 | Remove LiteLLM term; add LLMGatewayService, cost-tier routing |
| Appendix D Change Log | ~4320-4331 | Add v0.7 entry |

**W3-detail: §8.2 full rewrite template:**

```markdown
### 8.2 Embedding Service

**Purpose**: Vector embedding generation for captures, queries, and triggers.

**Model**: `text-embedding-3-large` (OpenAI) with `dimensions: 768` API parameter.
Uses trained Matryoshka Representation Learning (MRL) — not post-hoc truncation.
Returns 768d vectors matching `vector(768)` schema.

**Endpoint**: `api.openai.com/v1/embeddings` (OPENAI_BASE_URL env override supported).

**Adaptive truncation**: Input capped at 16K chars. On OpenAI 400 "context length"
error, halves to 2K minimum (handles JSON/minified content ≈ 2 chars/token ratio).

**No fallback**: If API unreachable, EmbeddingUnavailableError is thrown; BullMQ
retries with patient backoff (30s, 2m, 10m, 30m, 2h). Never mix embedding models.

**Cost**: $0.00013/1K input tokens. Tracked in ai_audit_log via estimateTierCostUsd().
```

**W3-detail: §8.7 rewrite template:**

```markdown
### 8.7 LLMGatewayService & Cost-Tier Routing

**Purpose**: Application-layer service that maps task types to model tiers,
dispatches completions, and logs cost to ai_audit_log.

**Config**: `config/ai-routing.yaml` — single source of truth for tiers,
task routing, and cost fields.

**Four tiers** (exhaust free before paid):

| Tier | Model | Provider | Cost | Used for |
|------|-------|----------|------|---------|
| t0_local | qwen3.5:2b | ollama (internal) | Free | Deterministic fallback |
| t1_jetson | qwen3.5-4b | openai_compat (192.168.10.58:8080) | Free | Classification (6 tasks) |
| t1_spark | qwen3.5-35b | openai_compat (spark.k4jda.net:8000) | Free | Routine complex tasks |
| t1_fast | claude-haiku-4-5-20251001 | anthropic | $0.0008/1K in | Fast paid fallback |
| t2_quality | claude-sonnet-4-6 | anthropic | $0.003/1K in | weekly_brief, governance, email_compose |

**Gateway creates per-tier OpenAI SDK clients** from tier `base_url`. Ollama keeps
constructor-injected client (test mock compatibility). `openai_compat` tiers each get
a distinct client instance.

**Budget**: soft $20/month (Pushover alert); hard $35/month (circuit breaker).
`estimateTierCostUsd()` reads cost_per_1k_* from tier config.
```

### W4 — TDD v0.7: New sections for post-v0.6 features

Four new subsections to author and insert in appropriate locations:

**W4.1 — Cognitive Memory (Hebbian co-access + spreading activation + consolidation)**  
Insert after §8.8 MCP Server Tools as new §8.9.  
Content source: CLAUDE.md "Cognitive memory / scheduler" rules + LAB_NOTEBOOK Entry for P06 + PR #132.  

Key facts to document:
- `capture_associations` table: canonical pair ordering (a < b), weight formula: `count * exp(-0.005 * hours_delta)`
- Top-10 search results enqueue `access-stats` BullMQ job (fire-and-forget)
- Spreading activation: max 2 hops, fan-out 10, `include_related` default false (API) / true (MCP)
- Memory consolidation: cosine similarity > 0.92, min cluster 3, top 5 per run, Sunday 4 AM, source `consolidation`, soft-delete originals

**W4.2 — Autonomy Levels**  
Insert in §7 (Authorization) as new §7.4, or in §6 (Service Layer) as §6.4.  
Content source: CLAUDE.md "Pipeline / workers / skills" autonomy table.  

Key facts:
- Four levels: `observe` / `assist` / `advise` / `partner`
- `meetsAutonomyLevel()` in `@open-brain/shared` — pure sync ordinal comparison
- BaseSkill.execute() checks `static minimum_autonomy` before delegating to `run()`
- `app_settings.autonomy_level` — fetched with 5-min module-level cache per package

**W4.3 — Cost-Tier Processing**  
Insert in §1.3 Technical Approach Summary as a new subsection, or as §8.10.  
Content source: CLAUDE.md "Cost-Tiered Processing" section + `ai-routing.yaml`.  

Key facts:
- T0 Python → T1 local LLM → T2 Claude CLI → T3 API progression
- Aggregation rule: never call LLM per-item; collect → extract → aggregate → synthesize
- Monthly budget targets ($20 soft, $35 hard)

**W4.4 — Email Pipeline + File Ingestion**  
Update or expand §1.4 Phased Implementation + relevant feature sections.  
Content source: CLAUDE.md "Integrations / external services" + PRs #34 + #75 + #76.  

Key facts:
- Email: Cloudflare Email Worker → `POST /api/v1/captures`, sender allowlist in `app_settings`
- File ingestion: OneDrive via rclone → sidecar parser → captures with `source: file`
- Composio quota meter: 19K/month hard stop, 15K warn

---

## Acceptance Criteria

| # | Criterion | How verified |
|---|-----------|-------------|
| AC-1 | `grep -c -i "litellm" docs/PRD.md` returns 0 | Run after implementation |
| AC-2 | `grep -c -i "litellm" docs/TDD.md` returns 0 | Run after implementation |
| AC-3 | PRD version header reads `0.7`, Change Log has new 0.7 entry dated 2026-04-19 | Manual review |
| AC-4 | TDD Document History has new 0.7 row; version header updated | Manual review |
| AC-5 | New "Architecture Evolution" section in PRD covers CS-α through CS-ι + Arc 6 | Operator review |
| AC-6 | TDD §8.2 describes `text-embedding-3-large` + MRL 768d (not `spark-qwen3-embedding-4b`) | Manual review |
| AC-7 | TDD §8.7 describes LLMGatewayService four-tier config (not external LiteLLM proxy) | Manual review |
| AC-8 | TDD has new sections for cognitive memory, autonomy levels, cost-tier routing | Operator review |
| AC-9 | No references to `llm.k4jda.net` as LiteLLM proxy (external service) remain | `grep -i "llm.k4jda.net" docs/PRD.md docs/TDD.md` — 0 expected (MCP gateway URL is different) |
| AC-10 | No references to `LITELLM_API_KEY`, `LITELLM_URL` remain | `grep -i "litellm_api_key\|litellm_url" docs/PRD.md docs/TDD.md` — 0 expected |
| AC-11 | LAB_NOTEBOOK has pre-action entry (before first commit) and result entry | Visual check |

---

## Rollback Plan

Revert PR. Docs return to v0.6 with P15a partial alignment (source enum corrected, doc-status notes present). No code, schema, or config changes — pure documentation. Git revert is complete rollback.

---

## Dependencies

- **P15a** (PR #148) — COMPLETE. Version strings + source enum + doc-status blockquote already in place. This phase builds directly on those edits.
- No other phase dependencies. This is docs-only; no code, no migrations, no deploy.

---

## Scope Flag Requiring Operator Decision

**Model name in docs:** The card specifies "`gpt-5.4`" as the current inference model. `config/ai-routing.yaml` uses `claude-haiku-4-5-20251001` (t1_fast) and `claude-sonnet-4-6` (t2_quality). CLAUDE.md Key Architecture also says `gpt-5.4` — this is a stale artifact from an earlier config that was updated without a CLAUDE.md sweep.

**Recommendation:** P15b docs rewrite uses `ai-routing.yaml` as ground truth (Anthropic model IDs). A follow-on CLAUDE.md cleanup (could be P15c or included in P15b) updates the "gpt-5.4" references in CLAUDE.md Key Architecture section. Operator should confirm before Gate 3.

---

## Effort Estimate

| Work item | Estimated time |
|-----------|---------------|
| W1: PRD LiteLLM scrub (83 refs) | 3–4 hours |
| W2: PRD Architecture Evolution section (new) | 1 hour |
| W3: TDD LiteLLM scrub (134 refs, 8 dense sections) | 5–6 hours |
| W4: TDD new sections (4 subsections) | 2–3 hours |
| LAB_NOTEBOOK entries | 30 min |
| **Total** | **~12–14 hours (~2 days)** |

Card estimate of ~2 days is consistent.

---

## Implementation Notes

- Edit docs in-place — no new files except possibly `docs/adr/` index (deferred).
- Process section by section; run `grep -c -i litellm` checks after each major section to confirm progress.
- Use exact model IDs and tier names from `config/ai-routing.yaml` (not CLAUDE.md Key Architecture, which has the stale gpt-5.4 entry).
- `llm.troy-davis.com` and `llm.k4jda.net` appear in docs as the LiteLLM/LiteLLM-gateway URL — retain `llm.troy-davis.com/mcp` as the MCP gateway (correct), but remove references to it as an LLM inference proxy.
- Sequence diagrams in TDD §6.3 use ASCII mermaid-style formatting — update participant names only; don't restructure the flow.
- Do not touch `docs/archived/` — historical plans stay as-is.
