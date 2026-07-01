# Open Brain — Service Level Objectives

> Single-operator, self-hosted system (Unraid homeserver, i7-9700, 128 GB RAM, no GPU).
> SLO targets are intentionally modest: this is not a production multi-tenant service.
> The goal is "degradation is noticed before it persists overnight," not five-nines.

## Alerting Architecture

No Alertmanager is deployed. Prometheus alert rules (in `config/prometheus/alerts/`)
surface firing alerts in the Prometheus UI and Grafana alert panels for manual review.
Push notifications to the operator come from application-layer code in the workers
container (via `PushoverService`) — not from Prometheus routing. The Prometheus rules
exist to: (a) provide Grafana annotation/dashboard visibility, (b) gate on sustained
conditions via `for:`, and (c) give consistent SLO thresholds across subsystems.

---

## 1. API Latency SLO (overall)

| Metric | Target | Window |
|--------|--------|--------|
| p99 request latency (all routes) | < 2.0 s | 5-minute rate |

**Measurement:** `openbrain_api_p99_latency_seconds` recording rule in
`config/prometheus/alerts/slo.yml`, derived from the
`openbrain_http_request_duration_seconds` histogram emitted by the Hono metrics
middleware (`packages/core-api/src/routes/metrics.ts`). Histogram buckets cover
5 ms to 10 s, which fully resolves p99 at this target without interpolation error.

**Rationale:** The 2.0 s target reflects the mixed nature of core-api traffic.
Simple CRUD endpoints (captures GET/POST, settings) should respond in < 100 ms.
The tail (p99) is dominated by the embed endpoint (blocking OpenAI call) and
occasional cold-cache Postgres queries. 2.0 s leaves headroom for a single LLM
token-estimation call without requiring LLM-backed paths to meet the same bar.

**Alert:** `ApiP99LatencySLOBreach` (warning, 5-minute sustained breach).

---

## 2. Search Latency SLO

| Metric | Target | Window |
|--------|--------|--------|
| p99 search latency (`/api/v1/search`) | < 3.0 s | 5-minute rate |

**Measurement:** `openbrain_search_p99_latency_seconds` recording rule, filtering
`openbrain_http_request_duration_seconds_bucket` to `route="/api/v1/search"`.
Covers both GET (query params) and POST (JSON body) search requests — both are
normalized to the same route label by the metrics middleware.

**Rationale:** The hybrid search path (`hybrid_search()` SQL function) involves:
- FTS scan with `content_tsvector` GIN index (fast)
- HNSW k-NN probe at `ef_search=60` (can take 100–400 ms on 11K corpus)
- RRF score fusion across both result sets
- Optional spreading-activation CTE if `include_related=true`

Median latency on the live 11K corpus is ~250 ms; p99 at ef_search=60 was
measured at ~800 ms in LAB_NOTEBOOK Entry 108. The 3.0 s SLO provides 3.75×
headroom above measured p99, accommodating HNSW cache cold-start after idle and
Postgres connection pool saturation under concurrent requests. If the corpus
grows to 50K+ captures or ef_search is raised above 80, re-benchmark and revise.

**Alert:** `SearchP99LatencySLOBreach` (warning, 5-minute sustained breach).

---

## 3. MCP Latency SLO

| Metric | Target | Window |
|--------|--------|--------|
| p99 MCP endpoint latency (`/mcp.*`) | < 5.0 s | 5-minute rate |

**Measurement:** `openbrain_mcp_p99_latency_seconds` recording rule, filtering
`openbrain_http_request_duration_seconds_bucket` to `route=~"/mcp.*"`.

**Rationale:** MCP tool calls divide into two categories:
- **LLM-backed** (`search_brain`, `get_weekly_brief`): invoke the OpenAI-compatible
  gateway (gpt-5.4 or t1_spark) — latency is dominated by LLM TTFT. A single
  non-streaming completion call takes 1–3 s under normal load.
- **DB-only** (`list_captures`, `get_capture`, `brain_stats`, `get_entity`,
  `list_entities`): should complete in < 200 ms; they pull the p99 down.

5.0 s gives the LLM-backed tools room to complete without false alerts, while
still catching genuine degradation (LiteLLM gateway restart, Spark VLLM OOM).
MCP is consumed by OpenClaw and LiteLLM tool use — higher tail latency is
acceptable since these are agent tool calls, not interactive user requests.

**Alert:** `McpP99LatencySLOBreach` (warning, 5-minute sustained breach).

---

## 4. Ingest Pipeline SLO (proxy metric — no histogram today)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Capture throughput | ≥ 1 capture per 6-hour window (active hours) | `openbrain_captures_per_6h` recording rule |
| Pipeline success rate | ≥ 95% of captures reach `complete` status | Manual query — no automated alert |

**What exists today:** The `CaptureFlowStale` alert in `capture-flow.yml` fires when
`increase(openbrain_captures_total[6h]) == 0`. This is a coarse availability proxy,
not a latency or success-rate SLO.

**What is deferred (instrumentation needed):**

A per-job duration histogram would require instrumenting BullMQ job completion
in `packages/workers/src/jobs/` and pushing a histogram metric via Pushgateway.
The shape would be:
```
# HELP openbrain_job_duration_seconds BullMQ job processing time
# TYPE openbrain_job_duration_seconds histogram
openbrain_job_duration_seconds_bucket{queue="captures",job_name="embed",le="5"} ...
```
Once emitted, a recording rule `openbrain_ingest_p99_seconds` can be added here
and in `slo.yml` targeting < 5 minutes (300 s) for the full ingest pipeline
(classify → extract → embed → complete).

Until that histogram exists, the ingest SLO is monitored via:
- `openbrain_queue_waiting` / `openbrain_queue_failed` alerts (pipeline.yml)
- `openbrain_captures_per_6h` (capture-flow.yml)
- Manual periodic query: `SELECT pipeline_status, COUNT(*) FROM captures GROUP BY 1`

---

## 5. Availability SLO

| Surface | Target | Measurement |
|---------|--------|-------------|
| core-api (brain.troy-davis.com) | 99% monthly uptime | `ContainerDown` alert + manual |
| Ingest pipeline | 99% monthly | `WorkersMetricsAbsent` alert + manual |

**Calculation:** 99% monthly = ~7.2 hours allowable downtime per month. Given this
is a self-hosted single-node system with no redundancy, 99% is realistic. Scheduled
maintenance (migrations, Docker updates) counts against the budget and is acceptable
when done during low-activity hours (02:00–06:00 local).

**Measurement:** Automated detection via `ContainerDown` (Prometheus, container-health.yml)
and Pushover from the container-health skill (every 15 minutes). Formal availability
tracking requires exporting `openbrain_container_healthy` to a long-term store; that
is not implemented today. Availability is currently assessed by reviewing Grafana's
`openbrain_container_healthy` time-series panel after each incident.

---

## 6. Error Budget

Monthly error budget at each SLO level:

| SLO | Target | Budget (requests) | Budget (time) |
|-----|--------|------------------|---------------|
| API p99 < 2.0 s | 99th pct | 1% of requests may exceed 2.0 s | N/A |
| Search p99 < 3.0 s | 99th pct | 1% of search requests may exceed 3.0 s | N/A |
| MCP p99 < 5.0 s | 99th pct | 1% of MCP calls may exceed 5.0 s | N/A |
| Availability | 99% monthly | — | ~7.2 h/month |

Error budget tracking is informal for a single-user system. When the SLO breach alerts
fire, investigate root cause and remediate within the same maintenance window. No
formal error budget burn-rate alerting is implemented.

---

## 7. Revision History

| Date | Change |
|------|--------|
| 2026-06-30 | Initial SLOs defined (arch-review v3, PLT-M1 + PE-M6 / INT-M7) |
