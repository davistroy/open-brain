# LEARNINGS

## SUMMARY

Key learnings from implementing all 16 phases (83 work items, ~11,100 LOC) of Open Brain:

- **Externalizing LiteLLM was the right call early.** Routing all AI — both embeddings and inference — through a shared proxy at `llm.k4jda.net` eliminated the Ollama container entirely, simplified the stack, and made model swapping zero-code. Switching from `jetson-embeddings` to `spark-qwen3-embedding-4b` required only a YAML config change — no application code touched.

- **No-fallback on embeddings forces operational discipline.** The decision to queue-and-retry rather than fall back to a different embedding model if LiteLLM is down guarantees vector space consistency. Mixed-model embeddings in the same table would silently corrupt search quality in ways that are hard to detect and harder to fix.

- **BullMQ's job event model handles the pipeline retry pattern cleanly.** The 5-attempt patient backoff (30s, 2m, 10m, 30m, 2h) plus the daily sweep worker covers both transient failures and extended outages without custom retry infrastructure.

- **Drizzle ORM + drizzle-kit earned its place.** Type-safe schema, straightforward migration generation, and no magic — every SQL operation is visible and auditable. The tradeoff is verbosity; it pays off when debugging pipeline stage queries against pgvector.

- **Hybrid search (FTS + vector + RRF) with deferred temporal decay was pragmatic.** Setting `temporal_weight: 0.0` at launch avoids ACT-R scoring before there is enough access history to make it meaningful. The config knob means temporal weighting can be enabled without a deployment.

- **MCP embedded in the core API (not a separate container) reduced operational surface area.** Streamable HTTP with `Authorization: Bearer` is simpler to proxy through Cloudflare Tunnel than a dedicated socket-mode MCP server, and there is one fewer container to monitor and restart.

- **LLM-driven governance (not FSM) scales better across conversation shapes.** A finite state machine for governance sessions would have required explicit state transitions for every conversational branch. Guardrails on top of an LLM conversation loop handles open-ended dialogue without encoding every path.

- **Config-driven design (YAML pipelines, AI routing, brain views, prompt templates) paid dividends.** Adding a new pipeline stage, changing a model alias, or adjusting budget thresholds requires editing a YAML file and restarting workers — no code changes. Prompt templates versioned as text files make iteration and rollback straightforward.

- **Monorepo with pnpm workspaces kept package boundaries honest.** Shared types in `packages/shared` forced explicit interfaces between core-api, workers, slack-bot, and voice-capture. The tsup/esbuild production build per package keeps container images lean.

- **The iOS Shortcut → voice-capture → faster-whisper path is fragile at the edges but robust in the middle.** The shortcut itself has no retry logic (iOS constraint); robustness lives in voice-capture's retry-to-core-api and the pipeline's BullMQ retry. The Pushover confirmation on successful ingest closes the feedback loop so failed captures are visible immediately.

- **Matryoshka truncation is the correct strategy for embedding model flexibility.** When `spark-qwen3-embedding-4b` returns 2560-dimensional vectors, truncating to 768 dimensions via Matryoshka representation is semantically valid — the model is trained so that the first N dimensions encode the most meaningful information. The embedding service must use `raw.length < EMBEDDING_DIMENSIONS` (not strict equality) to detect under-dimensioned vectors while accepting and truncating over-dimensioned ones.

- **FTS-only search mode is essential operational infrastructure.** During integration testing, hybrid search was unavailable for ~48 hours while the embedding service was being repaired. Adding `search_mode=fts` as a first-class path (not just a fallback) meant the system remained searchable throughout. The `fts_only_search()` SQL function also eliminates the `WHERE embedding IS NOT NULL` filter, making new captures immediately searchable before they are embedded.

- **SQL function typos in PL/pgSQL fail silently at migration time.** The `plainplainto_tsquery` typo (should be `plainto_tsquery`) passed migration without error because PL/pgSQL compiles function bodies lazily — the function was created successfully but failed on first invocation. Always test SQL functions immediately after migration by calling them with representative inputs.

- **Pipeline status is more granular than the schema comment suggests.** The schema comment says `pending | processing | complete | failed` but the actual runtime values are `pending → processing → extracted → embedded`. `complete` is a guard value checked but never SET in the current implementation. Pipeline-event records track finer-grained stage transitions separately from the captures table.

---

## Implementation Notes

5.6: Phase 5 test gate mentions "embedding throughput via LiteLLM documented" — this is a doc artifact, not a code gate; deferred to operational runbook when LiteLLM proxy is live.
