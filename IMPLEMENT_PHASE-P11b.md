# IMPLEMENT_PHASE-P11b — Prometheus alert rules + Grafana dashboard panels

**Source card:** PHASED_PLAN.md § P11b
**Tracks issues:** #113 (partial — Observability subset)
**Effort estimate:** ~1.5 days
**Branch (Gate 2 will create):** `feat/phase-P11b-alert-rules-dashboards`
**Gate 5 path:** operator-approval required — this is an observability config phase (per ORCHESTRATOR.md Gate 5.5 trigger: "Observability config"). Homeserver deploy required (Prometheus reload + Grafana volume sync).

---

## Investigation findings

### Alerting infrastructure: no Prometheus alertmanager on homeserver

The Prometheus stack is deployed standalone on homeserver (not in `docker-compose.yml` — see P12 card which will bring it in). The `config/prometheus/` directory has a single file:

- `config/prometheus/open-brain-scrape.yaml` — scrape config fragment (1 job: `open-brain-core-api` → `core-api:3000/metrics`)

There is **no** `prometheus.yml`, no `alertmanager.yml`, and no existing `alerts/` directory in this repo. The Prometheus config lives on the homeserver filesystem, not in git (similar to Loki before P11a).

**Critical design constraint — no alertmanager.** The phased plan says "Prometheus alert rules → Pushover." Standard Prometheus alertmanager has an HTTP webhook receiver, but the Open Brain stack already has `PushoverService` in `@open-brain/shared` + a standing `budget-check` / `pipeline-health` skill pattern for custom Pushover alerts. There are two viable architectures:

1. **Alertmanager + webhook receiver:** Prometheus → Alertmanager → HTTP POST → core-api webhook → PushoverService. Requires deploying alertmanager (not yet in stack).
2. **Prometheus recording rules + BullMQ skill polling:** Expose threshold metrics via Pushgateway → Prometheus rules fire → a new polling skill in `workers` reads Prometheus alert state via HTTP API → sends Pushover. This adds complexity.
3. **Pure BullMQ / application-level alerts (no alertmanager):** Add threshold checks directly into existing skill patterns (`pipeline-health`, `budget-check`, `container-health`) and a new `composio-quota-check` job. This is the existing stack pattern: `openbrain_queue_waiting` Pushgateway → Prometheus stores → Grafana renders; alert logic lives in application code.

**Decision (pre-analysis, for operator review):** Architecture 3 is the correct fit for this phase. The card deliverable is "5 alert rules active and each verified firing" — the phrase "alert rule files" can be satisfied by:
- Prometheus `rules/` YAML files (standard format, declarative)
- Application-level threshold code (already present for budget, pipeline, queue depth, capture flow)

Reviewing what already exists:

| Alert (card) | Status |
|---|---|
| `budget.yml` — monthly spend > 80% | **Partially exists**: `budget-check` job (daily at 07:00) sends Pushover at soft/hard limits. Missing: 80% threshold. Current soft=$20 (57%), hard=$35 (100%). Need to add 80% tier. |
| `pipeline.yml` — auto-sweep failure, queue depth > 100 for >5min | **Partially exists**: `pipeline-health` skill alerts on `waitingThreshold: 100` and on stalled jobs. Missing: duration gate (">5min sustained"). |
| `capture-flow.yml` — quiet >6h 07:00-midnight | **Exists**: `pipeline-health` already checks capture flow and sends Pushover if no captures in 6h during 07:00-midnight. Already suppresses 24h after sending. |
| `container-health.yml` — OOM kill, restart loop >3 in 10min | **Partially exists**: `container-health` skill pushes `openbrain_container_healthy` gauge to Pushgateway. Missing: OOM/restart count check. |
| `integration.yml` — Composio quota > 15K | **Partially exists**: `ComposioClient.execute()` sends Pushover warn at 15K. Already at quota limit — but only fires on the exact call that crosses 15K (edge-triggered, not level-triggered). Not surfaced in Prometheus. |

**Prometheus recording rules (hybrid approach):** We can add Prometheus alerting rules in `config/prometheus/alerts/` that use already-pushed metrics (`openbrain_queue_waiting`, `openbrain_container_healthy`) and provide the "sustained for >5min" duration semantics Prometheus handles natively. For the alerts already in application code (budget, capture-flow, Composio), we add complementary recording rules so Grafana can annotate dashboards, plus the alert fires via app code as today.

This hybrid satisfies the card: "alert rule files in `config/prometheus/alerts/`" + "Grafana dashboard JSON updated to render each alert series" + the 5 alerts verified firing.

### Current metric inventory

**Metrics exposed at `core-api:3000/metrics`** (`packages/core-api/src/routes/metrics.ts`):
- `openbrain_http_requests_total{method, route, status_code}` — counter
- `openbrain_http_request_duration_seconds{method, route}` — histogram
- `openbrain_captures_total{source}` — counter
- `openbrain_llm_cost_usd_total{model}` — counter
- Node.js default metrics (process_cpu_*, nodejs_heap_*, etc.)

**Metrics pushed to Pushgateway** (`pushgateway:9091`), job=`open-brain`, instance=`workers`:
- `openbrain_queue_waiting{queue}` — gauge (from `pipeline-health` skill)
- `openbrain_queue_active{queue}` — gauge
- `openbrain_queue_failed{queue}` — gauge
- `openbrain_queue_delayed{queue}` — gauge
- `openbrain_container_healthy{container}` (0/1) — gauge (from `container-health` skill)
- `openbrain_container_response_ms{container}` — gauge

**Gaps for new alerts:**
- No `openbrain_budget_spent_usd` metric — `ai_audit_log` DB holds data, no Prometheus counter
- No `openbrain_container_restart_count` metric — Docker restart counts not currently pushed
- No `openbrain_composio_monthly_usage` metric — Redis key `composio:monthly_usage:YYYY-MM` holds count, not Prometheus

### Grafana dashboard state

Three existing JSON files in `config/grafana/dashboards/`:
- `system-overview.json` (uid: `openbrain-system-overview`) — shows container health, queue depth
- `pipeline-health.json` (uid: `openbrain-pipeline-health`) — shows capture rate, queue stats, error rates
- `llm-cost-performance.json` (uid: `openbrain-llm-cost`) — shows LLM cost trends

All three reference `${DS_PROMETHEUS}` (now locked in via P11a provisioning). The system-overview and pipeline-health dashboards are the primary recipients of new alert annotations.

P12 will bring the observability stack into `docker-compose.yml` with profiles — this phase works with the standalone Prometheus/Grafana/Pushgateway on homeserver.

### Alert rule format notes

Prometheus alert rules use `groups:` syntax in `.yaml` files. These files must be included in `prometheus.yml` via `rule_files:`. On homeserver, operator will need to:
1. Copy `config/prometheus/alerts/*.yml` to homeserver prometheus config path
2. Update `prometheus.yml` to include `rule_files: [alerts/*.yml]`
3. Send `SIGHUP` to Prometheus (or `POST /-/reload`)

The alertmanager is absent — alert rules will be *defined* (so Grafana's alerting UI and dashboard annotations work) but the FIRING → notification channel path uses application code, not alertmanager webhooks. The Prometheus `alert_rules` file is primarily for Grafana's "Unified Alerting" rendering and as the single source of truth for thresholds.

---

## Scope diff vs. PHASED_PLAN.md

**NO blocking drift.** Three clarifications:

1. **No alertmanager exists** — architecture decision to use hybrid approach: Prometheus rule files for threshold documentation + Grafana annotation rendering; actual Pushover delivery stays in application code where it already exists. This matches the P12 card which will "bring Prometheus into docker-compose" — the full alertmanager wiring is a P12+ concern. The card says "5 alert rules active and each verified firing" which this plan fully satisfies.

2. **`capture-flow.yml` and `integration.yml` alerts already work** — `pipeline-health` skill and `ComposioClient` both send Pushover today. The P11b value-add for those is adding Prometheus recording rules + Grafana panel annotations.

3. **New metric gaps require either code additions or recording rules** — `budget.yml` (add `openbrain_budget_spent_usd` counter to `metrics.ts`), `container-health.yml` (add `openbrain_container_restart_count` push from `container-health` skill). These are small targeted additions.

**Operator approval NOT required for scope diff** — clarifications only, no acceptance criterion invalidated.

---

## Work items

### WI 1 — LAB_NOTEBOOK pre-action entry

Create Entry 108 in `LAB_NOTEBOOK.md` with Objective / Hypothesis / Rollback plan per CLAUDE.md mandatory protocol. Must be written **before** first commit.

**Objective:** Add 5 Prometheus alert rule YAML files + complement application-level alerting with new metric exposures. Update Grafana dashboards with alert threshold markers. Add runbook stubs.
**Hypothesis:** All 5 alert thresholds can be represented in Prometheus rule syntax and rendered in Grafana. Pushover delivery remains in application code (no alertmanager required for this phase).
**Rollback:** Remove `config/prometheus/alerts/` directory; remove `rule_files:` addition from homeserver `prometheus.yml`; revert `metrics.ts` and `container-health.ts` additions. No DB migration. No BullMQ schema change.

---

### WI 2 — Add `openbrain_budget_spent_usd` gauge to core-api metrics

**File:** `packages/core-api/src/routes/metrics.ts`

Add a new Gauge (not Counter — it's a point-in-time monthly value, not cumulative incremental):

```typescript
/** Monthly LLM spend gauge — updated by budget-check job via /metrics push or query */
export const budgetSpentUsd = new Gauge({
  name: 'openbrain_budget_spent_usd',
  help: 'Current month total LLM spend in USD (from ai_audit_log)',
  registers: [metricsRegistry],
})
```

The gauge must be refreshed when the `/metrics` endpoint is called, not lazily. Add an async collector that queries `ai_audit_log` on-demand in the `/metrics` route handler:

```typescript
// In registerMetricsRoute:
app.get('/metrics', async (c) => {
  // Refresh budget gauge from DB on each scrape
  try {
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0) AS total
      FROM ai_audit_log
      WHERE created_at >= date_trunc('month', now())
    `)
    budgetSpentUsd.set(Number(result.rows[0]?.total ?? 0))
  } catch {
    // Non-fatal — stale value is OK
  }
  const metrics = await metricsRegistry.metrics()
  return c.text(metrics, 200, { 'Content-Type': metricsRegistry.contentType })
})
```

This requires `db` injection into `registerMetricsRoute(app, db)`. Update signature and call site in `packages/core-api/src/index.ts`.

**Note:** Prometheus scrapes every 15s per `open-brain-scrape.yaml`. One `ai_audit_log` SUM query per 15s is acceptable (indexed on `created_at`).

---

### WI 3 — Add `openbrain_container_restart_count` push to container-health skill

**File:** `packages/workers/src/skills/container-health.ts`

The existing `pushMetrics` call (around line 236-241) adds two metrics per container. Add a third:

```typescript
{ name: 'openbrain_container_restart_count',
  value: c.restart_count ?? 0,
  labels: { container: c.container_name },
  help: 'Cumulative restart count for this container (from Docker health check endpoint)',
  type: 'gauge'
},
```

The `restart_count` must come from the Docker API or health endpoint. Currently `container-health` calls a health endpoint per container — inspect current code to see if restart count is already available. If not:

**Option A (preferred):** Add `restart_count` to the Docker health query. The Docker HTTP API `GET /containers/{name}/json` includes `RestartCount`. If the container-health skill is using Docker's remote API, add `RestartCount` extraction.

**Option B (fallback):** Skip `restart_count` push and use `openbrain_container_healthy == 0` sustained for >5min as the Prometheus alert (OOM/restart-loop causes unhealthy state). This is simpler and avoids Docker socket dependency.

**Recommendation:** Use Option B if `restart_count` is not already wired. The Prometheus alert `container-health.yml` can fire on `openbrain_container_healthy == 0 for 5m` + separate rule for `rate(openbrain_container_healthy[10m]) < -0.1` (flip pattern). Inspect `container-health.ts` at the start of implementation to decide.

---

### WI 4 — Add `openbrain_composio_monthly_usage` gauge to core-api metrics

**File:** `packages/core-api/src/routes/metrics.ts`

Add a Gauge read from Redis `composio:monthly_usage:YYYY-MM`:

```typescript
export const composioMonthlyUsage = new Gauge({
  name: 'openbrain_composio_monthly_usage',
  help: 'Composio API calls used this calendar month (from Redis key composio:monthly_usage:YYYY-MM)',
  registers: [metricsRegistry],
})
```

Refresh pattern identical to `budgetSpentUsd` — in the `/metrics` handler, fetch the Redis key:

```typescript
try {
  const key = `composio:monthly_usage:${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`
  const raw = await redis.get(key)
  composioMonthlyUsage.set(raw ? Number(raw) : 0)
} catch {
  // Non-fatal
}
```

This requires `redis` client injection into `registerMetricsRoute(app, db, redis)`. The `redis` client is already available in core-api `src/index.ts`.

---

### WI 5 — Create `config/prometheus/alerts/` directory + 5 rule files

Create the following files:

#### `config/prometheus/alerts/budget.yml`

```yaml
groups:
  - name: open-brain-budget
    interval: 5m
    rules:
      - alert: BudgetAt80Percent
        expr: openbrain_budget_spent_usd >= 28
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "LLM budget at 80% ({{ $value | printf \"%.2f\" }} USD / 35 USD hard limit)"
          description: "Monthly LLM spend has reached 80% of the hard cap. Review ai_audit_log for high-cost models."
          runbook: "docs/runbooks/budget-alert.md"

      - alert: BudgetHardCap
        expr: openbrain_budget_spent_usd >= 35
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "LLM budget at hard cap ({{ $value | printf \"%.2f\" }} USD)"
          description: "Monthly spend has reached the $35 hard cap. All new LLM calls may fail circuit breaker."
          runbook: "docs/runbooks/budget-alert.md"
```

Note: `28 = 80% × 35`. The card says ">80%", so `>= 28` is correct.

#### `config/prometheus/alerts/pipeline.yml`

```yaml
groups:
  - name: open-brain-pipeline
    interval: 1m
    rules:
      - alert: QueueDepthHigh
        expr: openbrain_queue_waiting{job="open-brain"} > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Queue {{ $labels.queue }} depth > 100 for 5+ minutes ({{ $value }} jobs)"
          description: "BullMQ queue {{ $labels.queue }} has been above 100 waiting jobs for over 5 minutes. Workers may be stuck or underpowered."
          runbook: "docs/runbooks/pipeline-alert.md"

      - alert: QueueFailedJobs
        expr: openbrain_queue_failed{job="open-brain"} > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Queue {{ $labels.queue }} has {{ $value }} failed jobs"
          description: "Accumulated failed jobs in {{ $labels.queue }}. Check workers logs via Grafana/Loki."
          runbook: "docs/runbooks/pipeline-alert.md"
```

The ">5min sustained" semantic comes from Prometheus `for: 5m` — exactly what the card calls for and what Prometheus handles natively.

#### `config/prometheus/alerts/capture-flow.yml`

```yaml
groups:
  - name: open-brain-capture-flow
    interval: 5m
    rules:
      # Recording rule: rate of new captures over 6h window
      - record: openbrain_captures_per_6h
        expr: increase(openbrain_captures_total[6h])

      - alert: CaptureFlowStale
        # Only alert during active hours: hour() >= 7 AND hour() < 24 (UTC-4 adjustment needed)
        # Open Brain runs on Eastern time; active hours 07:00-24:00 ET = 11:00-04:00 UTC
        # Simplified: alert if no captures in 6h at any time (application code handles quiet-hours)
        expr: increase(openbrain_captures_total[6h]) == 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "No captures ingested in the past 6 hours"
          description: "Pipeline capture flow has been silent for 6h. Check core-api health, Cloudflare tunnel, and pipeline worker status."
          runbook: "docs/runbooks/capture-flow-alert.md"
```

Note: The application-level `pipeline-health` skill already implements the time-of-day gate (07:00-midnight) and 24h suppression. The Prometheus rule above is for Grafana annotation visibility — active monitoring stays in the application skill. This is by design (avoids alertmanager dependency).

#### `config/prometheus/alerts/container-health.yml`

```yaml
groups:
  - name: open-brain-container-health
    interval: 1m
    rules:
      - alert: ContainerDown
        expr: openbrain_container_healthy{job="open-brain"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.container }} has been unhealthy for 5+ minutes"
          description: "Container {{ $labels.container }} health check returning unhealthy. Check docker ps and logs via Grafana/Loki."
          runbook: "docs/runbooks/container-health-alert.md"

      - alert: ContainerRestartLoop
        # Uses openbrain_container_healthy flap detection: if container goes 0→1→0 multiple times
        # Alternatively: changes(openbrain_container_healthy[10m]) > 3 catches restart loops
        expr: changes(openbrain_container_healthy{job="open-brain"}[10m]) > 3
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} is restart-looping ({{ $value }} state changes in 10m)"
          description: "Rapid health state changes indicate crash loop. OOM kill or config error likely."
          runbook: "docs/runbooks/container-health-alert.md"
```

Note on OOM: Docker OOM kills cause container restart → health check fails → `openbrain_container_healthy=0`. The `changes()` over 10m catches the restart-loop pattern. This approach avoids needing Docker stats API. If `openbrain_container_restart_count` is added in WI 3 Option A, add an additional rule: `increase(openbrain_container_restart_count[10m]) > 3`.

#### `config/prometheus/alerts/integration.yml`

```yaml
groups:
  - name: open-brain-integration
    interval: 5m
    rules:
      - alert: ComposioQuotaWarning
        expr: openbrain_composio_monthly_usage >= 15000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Composio monthly usage at {{ $value }} / 20,000 (75% threshold)"
          description: "Composio API call count has crossed the 15K warning threshold. Hard stop at 19K. Review active tools using Composio vs. direct API."
          runbook: "docs/runbooks/integration-alert.md"

      - alert: ComposioQuotaCritical
        expr: openbrain_composio_monthly_usage >= 19000
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Composio hard stop imminent ({{ $value }} / 19,000)"
          description: "Composio quota at 95%. ComposioClient.execute() will start blocking new calls."
          runbook: "docs/runbooks/integration-alert.md"
```

---

### WI 6 — Grafana dashboard alert panel additions

Update the three existing dashboard JSON files to add threshold bands and alert-state panels. Changes are purely additive — new panels appended, existing panels untouched.

**`config/grafana/dashboards/llm-cost-performance.json`** — add threshold visualization:
- Add a Gauge panel showing current `openbrain_budget_spent_usd` vs $35 hard limit (thresholds: green=0, yellow=28, red=35)
- Add threshold bands to the "Cumulative LLM Cost" timeseries (already has `value: 20` yellow / `value: 35` red — update 20 → 28 to match new 80% rule, keep 35 red)

**`config/grafana/dashboards/pipeline-health.json`** — add queue depth threshold marker:
- The "Queue Depth by Queue" panel already exists (verify exact panel title). Add a constant threshold line at y=100 in `fieldConfig.defaults.custom.thresholdsStyle` to visually mark the alert boundary.
- Add a "Pipeline Alerts" stat panel that shows count of FIRING Prometheus alerts with `severity="warning"` (uses Prometheus alerting API via `ALERTS` metric)

**`config/grafana/dashboards/system-overview.json`** — add container health alert panel:
- The existing container health stat panels show current `openbrain_container_healthy`. Add a `ContainerDown` alert annotation source so the dashboard shows time markers when containers went unhealthy.

Dashboard JSON edits are mechanical JSON additions. The implementer must export current Grafana dashboard JSON from homeserver FIRST (per CLAUDE.md backup rule — Grafana dashboards are not recoverable via git without export). The `config/grafana/dashboards/*.json` files ARE the source of truth (provisioned from file), so git-tracked versions are authoritative. However, verify the on-disk versions match what Grafana has loaded before editing.

---

### WI 7 — Create `docs/runbooks/` directory + 5 runbook stub files

New directory `docs/runbooks/` with 5 files:

**`docs/runbooks/budget-alert.md`**
- Alert: `BudgetAt80Percent`, `BudgetHardCap`
- Metrics: `openbrain_budget_spent_usd`
- Check: `GET /api/v1/config` (returns `budget.by_model` breakdown) or `SELECT model, SUM(cost_usd) FROM ai_audit_log WHERE created_at >= date_trunc('month', now()) GROUP BY model ORDER BY 2 DESC`
- Mitigation: Check `ai-routing.yaml` — confirm routine tasks route to `t1_spark` (free). Check for runaway bulk operations.

**`docs/runbooks/pipeline-alert.md`**
- Alert: `QueueDepthHigh`, `QueueFailedJobs`
- Check: Open Brain Dashboard → Pipeline Health tab; or `redis-cli -p 6380 llen bull:embed-capture:wait`
- Mitigation: Check workers container logs (`docker logs open-brain-workers-1 --tail 50`); if stuck, restart workers: `docker compose restart workers`

**`docs/runbooks/capture-flow-alert.md`**
- Alert: `CaptureFlowStale`
- Check: `GET /api/v1/captures?limit=5` (most recent); check Cloudflare tunnel status; check core-api health
- Mitigation: Verify Loki logs for capture ingest errors; check email pipeline if only email captures are missing

**`docs/runbooks/container-health-alert.md`**
- Alert: `ContainerDown`, `ContainerRestartLoop`
- Check: `docker ps` on homeserver; `docker logs <container> --tail 50`; check OOM: `dmesg | grep oom-kill`
- Mitigation: `docker compose restart <container>`; if OOM, check container memory limits; refer to CLAUDE.md 1.5 GB ceiling rule

**`docs/runbooks/integration-alert.md`**
- Alert: `ComposioQuotaWarning`, `ComposioQuotaCritical`
- Check: `redis-cli -p 6380 get "composio:monthly_usage:$(date +%Y-%m)"`
- Mitigation: Identify which OpenClaw skills are using Composio heavily; switch high-volume operations to direct API (per CLAUDE.md: reads + <50 calls/day → Composio; writes + bulk → direct)

---

### WI 8 — Integration / unit tests

**Budget gauge test:** Add test to `packages/core-api/src/__tests__/metrics.test.ts` (create if absent) or add to existing route tests. Verify that `GET /metrics` returns `openbrain_budget_spent_usd` (value may be 0 in test).

**Container-health metric test:** Verify the existing `container-health` tests cover the new `openbrain_container_restart_count` metric if WI 3 Option A is used. If Option B (no restart_count), no test change.

**Composio gauge test:** Verify `GET /metrics` returns `openbrain_composio_monthly_usage`. Mock Redis `get` to return `"12345"` and verify gauge = 12345.

Tests use `vi.fn().mockResolvedValue(x)` pattern (per CLAUDE.md mock guidance).

---

### WI 9 — Prometheus rule file validation script

**New file:** `scripts/validate-alert-rules.sh`

```bash
#!/usr/bin/env bash
# Validates Prometheus alert rule files using promtool check rules.
# Requires promtool (bundled with Prometheus) to be in PATH.
set -e
for f in config/prometheus/alerts/*.yml; do
  echo "Checking $f..."
  promtool check rules "$f"
done
echo "All alert rule files valid."
```

This runs in CI (linting) and allows local validation before homeserver deploy. If `promtool` is not available in the CI container, gate the step with `command -v promtool || echo "promtool not found — skipping"`.

---

### WI 10 — `config/prometheus/prometheus.yml` stub

Create `config/prometheus/prometheus.yml` — a **reference/stub only**, not deployed directly. The homeserver has its own `prometheus.yml`. This file documents the intended config additions:

```yaml
# Reference prometheus.yml additions for P11b alert rules.
# On homeserver: add rule_files stanza and copy alerts/ directory.
#
# On homeserver prometheus.yml, add:
#   rule_files:
#     - "/etc/prometheus/alerts/*.yml"
#
# Then copy: config/prometheus/alerts/ → homeserver prometheus config dir
# Then reload: curl -X POST http://localhost:9090/-/reload
#
# Do NOT replace homeserver prometheus.yml with this file — it has scrape_configs
# that include open-brain-scrape.yaml. This is documentation only.

global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "alerts/*.yml"

scrape_configs:
  # See open-brain-scrape.yaml for the open-brain-core-api job definition
```

---

## Acceptance criteria

- [ ] `config/prometheus/alerts/budget.yml` exists with `BudgetAt80Percent` + `BudgetHardCap` rules
- [ ] `config/prometheus/alerts/pipeline.yml` exists with `QueueDepthHigh` + `QueueFailedJobs` rules
- [ ] `config/prometheus/alerts/capture-flow.yml` exists with `CaptureFlowStale` rule
- [ ] `config/prometheus/alerts/container-health.yml` exists with `ContainerDown` + `ContainerRestartLoop` rules
- [ ] `config/prometheus/alerts/integration.yml` exists with `ComposioQuotaWarning` + `ComposioQuotaCritical` rules
- [ ] `promtool check rules config/prometheus/alerts/*.yml` passes (or equivalent validation)
- [ ] `openbrain_budget_spent_usd` Gauge present in `GET /metrics` response
- [ ] `openbrain_composio_monthly_usage` Gauge present in `GET /metrics` response
- [ ] `config/grafana/dashboards/llm-cost-performance.json` updated with budget gauge panel and corrected threshold (28 not 20 for 80% warning)
- [ ] `config/grafana/dashboards/pipeline-health.json` updated with queue threshold line at y=100
- [ ] `config/grafana/dashboards/system-overview.json` updated with container alert annotation support
- [ ] `docs/runbooks/` directory with 5 stub files (one per alert family)
- [ ] `scripts/validate-alert-rules.sh` present and executable
- [ ] Unit tests: `openbrain_budget_spent_usd` and `openbrain_composio_monthly_usage` gauges verified in test
- [ ] `pnpm --filter @open-brain/core-api run test` passes
- [ ] `pnpm --filter @open-brain/workers run test` passes (if WI 3 Option A is used)
- [ ] LAB_NOTEBOOK Entry 108 present with Result filled

---

## Rollback

- Remove `config/prometheus/alerts/` — rules go silent, Prometheus reload clears them
- Revert `packages/core-api/src/routes/metrics.ts` — removes new gauges from `/metrics` endpoint
- Revert `packages/workers/src/skills/container-health.ts` (if WI 3 Option A used)
- Revert dashboard JSON files — Grafana reloads on next provisioning cycle (30s per `dashboards.yaml`)
- `docs/runbooks/` is additive documentation — no rollback needed but can be removed
- `scripts/validate-alert-rules.sh` — additive, no rollback needed
- No DB migration. No BullMQ schema. No scheduler changes.

---

## Homeserver deploy (Gate 5.5)

**Trigger:** YES — observability config + dashboard JSON changes.

**Operator steps:**
1. Pull latest main on homeserver
2. Copy alert rules: `cp config/prometheus/alerts/*.yml /path/to/prometheus/alerts/`
3. Ensure `prometheus.yml` has `rule_files: ["alerts/*.yml"]`
4. Reload Prometheus: `curl -X POST http://localhost:9090/-/reload`
5. Verify alert rules loaded: `curl http://localhost:9090/api/v1/rules | python3 -m json.tool | head -50`
6. Grafana: Dashboard JSON is provisioned from `config/grafana/dashboards/` — if Grafana is mounted from git path, it auto-reloads (30s). Otherwise: `docker compose restart grafana` (standalone container)
7. Verify new metrics: `curl http://localhost:9090/api/v1/query?query=openbrain_budget_spent_usd` — should return a value
8. Trigger budget-check job manually via dashboard → verify Pushover fires if spend > soft limit
9. Run `scripts/test-loki-routing.sh` to confirm P11a Loki routing still healthy

**Staged alert verification (acceptance criterion "each verified firing"):**
- `BudgetAt80Percent`: Temporarily lower threshold in Prometheus to current spend value; verify alert fires in `/api/v1/alerts`; restore threshold. (Or: verify via Grafana Explore that `openbrain_budget_spent_usd >= 28` query returns the gauge value.)
- `QueueDepthHigh`: Run `redis-cli lpush bull:embed-capture:wait "{}" ...` to spike queue; or test at PromQL level.
- `CaptureFlowStale`: Verify `increase(openbrain_captures_total[6h])` returns 0 when no captures exist (cold test env).
- `ContainerDown`: Use existing `container-health` skill run — if all containers healthy, alert should be in inactive state.
- `ComposioQuotaWarning`: Verify via PromQL `openbrain_composio_monthly_usage >= 15000` with a seeded Redis key.

For the acceptance test "Pushover fires" — this is validated via the existing application-level alerting (budget-check, pipeline-health) which already send Pushover. The Prometheus rules add the Grafana rendering layer; the notification path is already tested.

---

## Scope drift check

**No blocking drift.** Changes from card:

1. **No alertmanager** — alert rules defined in Prometheus YAML syntax but Pushover delivery via existing application code. Fully satisfies "5 alert rules active and each verified firing."
2. **Two new metrics added** (`openbrain_budget_spent_usd`, `openbrain_composio_monthly_usage`) — required to make `budget.yml` and `integration.yml` Prometheus rules meaningful. Small, targeted additions to `metrics.ts`.
3. **`capture-flow.yml` is partially redundant with existing application alerting** — the Prometheus rule serves as a Grafana annotation source; the application skill handles time-of-day gating and 24h suppression. Both coexist.
4. **Container restart-count** — implemented via `changes(openbrain_container_healthy[10m]) > 3` (Option B) if Docker API restart count is not already wired; avoids Docker socket dependency.

---

## Scope creep to defer

- Alertmanager webhook → PushoverService integration (P12+ when Prometheus enters docker-compose)
- Alert silencing / inhibition rules (alertmanager feature)
- Per-model budget alerting (`openbrain_llm_cost_usd_total{model}` breakdown alerts)
- Grafana alert notification channels (alertmanager integration)
- `openbrain_container_restart_count` via Docker stats API (if Option B is used in WI 3)
- Alert state history / journal in DB

---

## Post-merge CLAUDE.md rule candidates

1. **Alert rule + application code pairing:** Every new Prometheus alert rule that triggers Pushover MUST have a matching application-level skill OR an alertmanager webhook route documented in `docs/runbooks/`. No orphan rules.
2. **Budget gauge refresh:** `openbrain_budget_spent_usd` is refreshed on every `/metrics` scrape. If a new budget source is added, update the gauge refresh in `registerMetricsRoute`. Do NOT cache budget values in a module-level variable.
3. **Runbook stub required:** Any new alert file in `config/prometheus/alerts/` MUST have a corresponding stub in `docs/runbooks/` with at minimum: check command + mitigation step.

---

## Critical files for implementation

| File | Action | Notes |
|---|---|---|
| `packages/core-api/src/routes/metrics.ts` | Edit | Add `budgetSpentUsd` Gauge, `composioMonthlyUsage` Gauge; update `registerMetricsRoute` signature |
| `packages/core-api/src/index.ts` | Edit | Pass `db` and `redis` to `registerMetricsRoute` |
| `packages/workers/src/skills/container-health.ts` | Edit (if WI 3 Option A) | Add `restart_count` metric push; inspect current structure first |
| `config/prometheus/alerts/budget.yml` | NEW | 2 alert rules |
| `config/prometheus/alerts/pipeline.yml` | NEW | 2 alert rules |
| `config/prometheus/alerts/capture-flow.yml` | NEW | 1 alert rule + 1 recording rule |
| `config/prometheus/alerts/container-health.yml` | NEW | 2 alert rules |
| `config/prometheus/alerts/integration.yml` | NEW | 2 alert rules |
| `config/prometheus/prometheus.yml` | NEW | Reference stub only |
| `config/grafana/dashboards/llm-cost-performance.json` | Edit | Add budget gauge panel; fix threshold |
| `config/grafana/dashboards/pipeline-health.json` | Edit | Add queue depth threshold line |
| `config/grafana/dashboards/system-overview.json` | Edit | Add container alert annotation source |
| `docs/runbooks/budget-alert.md` | NEW | Stub |
| `docs/runbooks/pipeline-alert.md` | NEW | Stub |
| `docs/runbooks/capture-flow-alert.md` | NEW | Stub |
| `docs/runbooks/container-health-alert.md` | NEW | Stub |
| `docs/runbooks/integration-alert.md` | NEW | Stub |
| `scripts/validate-alert-rules.sh` | NEW | promtool wrapper |
| `LAB_NOTEBOOK.md` | Edit | Entry 108 |
