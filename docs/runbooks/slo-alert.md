# Runbook: SLO Latency Alerts

**Alerts:** `ApiP99LatencySLOBreach`, `SearchP99LatencySLOBreach`, `McpP99LatencySLOBreach` (all warning)
**Metric:** `openbrain_http_request_duration_seconds` histogram, scraped from `core-api:3000/metrics` by the shared Prometheus (see `docs/runbooks/observability.md`)
**Rule file:** `config/prometheus/alerts/slo.yml`
**Full SLO definitions + rationale:** `docs/SLO.md`

**Alert delivery:** No Alertmanager is deployed. These rules surface in the Prometheus Alerts tab and Grafana alert panels for manual review only — they do NOT dispatch Pushover/email/Slack notifications. Operator must be checking Grafana/Prometheus (or notice symptom reports) to catch a firing SLO alert.

---

## Alert conditions

| Alert | `slo` label | Recording rule | Threshold | Window | Severity |
|-------|-------------|-----------------|-----------|--------|----------|
| `ApiP99LatencySLOBreach` | `api_p99` | `openbrain_api_p99_latency_seconds` | > 2.0 s | 5m sustained | warning |
| `SearchP99LatencySLOBreach` | `search_p99` | `openbrain_search_p99_latency_seconds` | > 3.0 s | 5m sustained | warning |
| `McpP99LatencySLOBreach` | `mcp_p99` | `openbrain_mcp_p99_latency_seconds` | > 5.0 s | 5m sustained | warning |

All three are `histogram_quantile(0.99, sum(rate(openbrain_http_request_duration_seconds_bucket{...}[5m])) by (le))` — a rolling 5-minute p99 — gated by `for: 5m` so a single slow request or a transient spike (cold HNSW cache, GC pause) does not fire the alert. `ApiP99` covers all routes; `SearchP99` filters to `route="/api/v1/search"`; `McpP99` filters to `route=~"/mcp.*"`. Use the `slo` label on the firing alert to identify which of the three tripped — Grafana/Prometheus alert views show it directly.

---

## Diagnosis

### 1. Confirm current p99 values and identify the breaching alert

From the homeserver (Prometheus is loopback-bound, `127.0.0.1:9090` per ADR-0002 — SSH in first):

```bash
curl -s "http://localhost:9090/api/v1/query?query=openbrain_api_p99_latency_seconds"
curl -s "http://localhost:9090/api/v1/query?query=openbrain_search_p99_latency_seconds"
curl -s "http://localhost:9090/api/v1/query?query=openbrain_mcp_p99_latency_seconds"

# Or check which alerts are currently firing:
curl -s "http://localhost:9090/api/v1/alerts" | python3 -m json.tool | grep -A5 'SLOBreach'
```

### 2. Check core-api and Postgres load

A generic latency spike across routes (ApiP99) is usually Postgres contention or core-api resource pressure, not the query itself.

```bash
# Container resource usage
docker stats open-brain-core-api --no-stream

# Active/slow Postgres queries (run inside the postgres container or via psql)
docker compose exec postgres psql -U openbrain -d openbrain -c "
  SELECT pid, now() - query_start AS duration, state, wait_event_type, wait_event, left(query, 100) AS query
  FROM pg_stat_activity
  WHERE state != 'idle'
  ORDER BY duration DESC
  LIMIT 20;
"

# Loki logs for core-api errors/slow-path warnings in the alert window
# (Grafana → Loki explorer: {container_name="open-brain-core-api"})
```

### 3. Search-specific diagnosis (`SearchP99LatencySLOBreach`)

The hybrid search path (`hybrid_search()` SQL function) is FTS + HNSW k-NN + RRF fusion, optionally + spreading-activation CTE (`include_related=true`). Isolate where the time is going:

```sql
-- Run against a representative query. Pull a real embedding to keep the vector
-- arg valid (dimension 768); substitute your own query_text.
EXPLAIN ANALYZE
SELECT * FROM hybrid_search(
  'test query',
  (SELECT embedding FROM captures WHERE embedding IS NOT NULL LIMIT 1),
  10,    -- match_count
  1.0,   -- fts_weight
  1.0,   -- vector_weight
  NULL, NULL, NULL, NULL
);
```

Check for:
- **HNSW index not being used** (seq scan on `captures` instead of an Index Scan using the HNSW index) — usually means `hnsw.ef_search` wasn't `SET LOCAL` correctly, or the planner is choosing FTS over vector for a low-selectivity query.
- **GIN index bloat** on `captures_content_tsvector_idx` — check `pg_stat_user_indexes` / `pg_relation_size` and consider `REINDEX CONCURRENTLY` in a maintenance window if bloat is significant.
- **`hnsw.ef_search` value** — read from `config/pipeline.yaml` `search.hnsw_ef_search` (default `60`). This is `SET LOCAL`'d per-query inside a transaction by `SearchService.search()` (`packages/core-api/src/services/search.ts`) — it is NOT a static Postgres GUC, so you cannot inspect it via `SHOW`; confirm the configured value in `pipeline.yaml` instead.
- **Corpus growth** — the 3.0 s SLO was calibrated against an ~11K-capture corpus (LAB_NOTEBOOK Entry 108: p99 ≈ 800 ms at `ef_search=60`). If the corpus has grown substantially (`SELECT COUNT(*) FROM captures WHERE deleted_at IS NULL`), re-benchmark:

```bash
PGURL=postgres://openbrain:<password>@localhost:5432/openbrain \
  node scripts/benchmark-search.mjs
```

This sweeps `ef_search` values and reports p50/p95 latency to help decide whether to raise/lower `search.hnsw_ef_search` in `config/pipeline.yaml` (tuning range: 40–100; do not hardcode ef_search in application code — see CLAUDE.md).

### 4. MCP-specific diagnosis (`McpP99LatencySLOBreach`)

MCP tools split into two latency profiles — narrow down which is slow before assuming an LLM problem:

- **LLM-backed tools** (`search_brain`, `get_weekly_brief`): depend on the OpenAI-compatible gateway. Check:
  ```bash
  # LiteLLM gateway health
  curl -s https://llm.k4jda.net/health

  # If routing target is t1_spark (DGX Spark vLLM), check the container directly
  ssh claude@spark.k4jda.net "docker ps | grep vllm; docker stats --no-stream"
  curl -s http://spark.k4jda.net:8000/metrics | head -20   # scraped as job "vllm-llm" in prometheus.yml
  ```
  Also check OpenAI API status (https://status.openai.com) if the fallback tier is active.

- **DB-only tools** (`list_captures`, `get_capture`, `brain_stats`, `get_entity`, `list_entities`): should stay under ~200 ms. If ONLY these are slow, the root cause is Postgres/core-api, not the LLM path — follow step 2 above instead.

Use Loki to filter MCP request logs by route and duration:
```
{container_name="open-brain-core-api"} |= "/mcp"
```

---

## Mitigation

### Postgres contention (ApiP99, SearchP99)

- Identify and, if safe, cancel long-running queries found in step 2 (`SELECT pg_cancel_backend(<pid>)`; use `pg_terminate_backend` only as a last resort).
- Check for a concurrent migration, `scripts/backup.sh` pg_dump, or `regenerate-init-schema.sh` run overlapping with the alert window — these are known to briefly increase query latency.
- If `/dev/shm` pressure is suspected (parallel maintenance work), see CLAUDE.md's Postgres `/dev/shm` note — unrelated to steady-state query latency but relevant if a migration was running.

### HNSW / search degradation (SearchP99)

- Re-run `scripts/benchmark-search.mjs` and adjust `search.hnsw_ef_search` in `config/pipeline.yaml` if the corpus has grown past the ~11K baseline. Lowering `ef_search` trades recall for latency; raising it does the opposite — never change it without a fresh benchmark.
- If the GIN or HNSW index shows bloat, schedule a `REINDEX CONCURRENTLY` in a low-activity window (02:00–06:00 local, matches the Availability SLO's maintenance allowance).

### LLM gateway degradation (McpP99)

- If the LiteLLM gateway (`llm.k4jda.net`) is down or slow, restart it per its own operational runbook (outside this repo).
- If DGX Spark's vLLM container is OOM or unresponsive, restart it (`ssh claude@spark.k4jda.net`, passwordless sudo covers `docker`/`systemctl`) and confirm the `vllm-llm`/`vllm-embed` Prometheus targets return healthy.
- If OpenAI's API is degraded and the fallback tier is active, this is expected higher latency — no action needed beyond monitoring; the alert will self-clear once OpenAI recovers.

### False positive / expected transient

A single cold-start after container recreate (HNSW cache empty) can transiently exceed the SLO before self-resolving within the 5-minute window. If the alert clears without intervention and no corresponding symptom (user-reported slowness, error spike) was observed, treat as a one-off — no action needed. If it recurs across multiple days at the same time, check for a scheduled job contending for resources at that time (see `packages/workers/src/scheduler.ts` cron slot registry in CLAUDE.md).

---

## Related

- `docs/SLO.md` — full SLO targets, rationale, and error budget for API/search/MCP/availability
- `docs/runbooks/observability.md` — how core-api exposes `/metrics` and how the shared Prometheus scrapes it
- `docs/runbooks/pipeline-alert.md` — queue depth / failed jobs (workers-side backpressure, distinct from request-latency SLOs)
- `docs/runbooks/container-health-alert.md` — container down / restart loops, a common upstream cause of latency spikes
- `packages/core-api/src/routes/metrics.ts` — `openbrain_http_request_duration_seconds` histogram definition
- `packages/core-api/src/services/search.ts` — `SET LOCAL hnsw.ef_search` + `hybrid_search()` invocation
- `scripts/benchmark-search.mjs` — ef_search latency/recall sweep tool
