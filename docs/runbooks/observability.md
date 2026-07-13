# Observability Runbook

**Services:** Loki, Prometheus, Grafana, Pushgateway — owned and operated by a **separate, standalone `observability` compose project** on the homeserver, shared across the fleet (not just open-brain).
**open-brain's role:** CLIENT of that stack. open-brain does not deploy, upgrade, or administer Loki/Prometheus/Grafana/Pushgateway — this repo only documents how open-brain's containers connect to them.
**Decision record:** `docs/adr/ADR-0004-observability-repoint.md` (Accepted, deployed 2026-07-01, LAB_NOTEBOOK Entry 181).

---

## Why this changed

Through Phase 12 (P12), open-brain ran its own copy of the GPL stack (Grafana/Prometheus/Loki/Pushgateway) inside its own `docker-compose.yml` under a `--profile observability` gate. That in-repo profile is **retired**. As of ADR-0004, those four service definitions and their named volumes (`prometheus_data`, `grafana_data`, `loki_data`) are **deleted from `docker-compose.yml`**. A shared Prometheus/Grafana/Loki/Pushgateway stack (container names `observability-*`) now serves the whole homeserver fleet, and open-brain re-points at it instead of duplicating it. Any documentation, script, or comment that still says "bring up the observability profile" or "`docker compose --profile observability up -d`" is describing the retired architecture — do not follow it.

---

## Architecture — client-join topology

```
                         external "observability" bridge network
                         (docker network, created by the separate
                          observability compose project)
                         ┌─────────────────────────────────────────┐
core-api ── metrics ──── │  Prometheus (scrapes core-api:3000)      │
  (also on open-brain    │  Grafana    (dashboards, LAN :3050*)     │
   network, :3000)       │  Pushgateway (:9091, receives pushes)    │
workers ── pushes ─────► │  Loki       (receives via daemon driver) │
                         └─────────────────────────────────────────┘
                                          ^
core-api, workers ── ALL app containers ─┘  loki docker log driver
                      (13 containers)        (host daemon → localhost:3100)
```

open-brain's `docker-compose.yml` declares the network as external and joins two services to it:

```yaml
networks:
  open-brain:
    driver: bridge
  observability:
    external: true

services:
  core-api:
    networks: [open-brain, observability]
  workers:
    networks: [open-brain, observability]
```

- **Metrics scrape (Prometheus → core-api):** Compose automatically adds each service's **name** as a DNS alias on every network it is attached to. Because `core-api` is now attached to `observability` (not just `open-brain`), the shared Prometheus can resolve `core-api:3000` and scrapes `/metrics` on its normal interval — no extra alias configuration needed. Before this join, the scrape target resolved `no such host` and the `open-brain-core-api` Prometheus target was permanently down.
- **Metrics push (workers → Pushgateway):** `packages/workers/src/lib/push-metrics.ts` defaults `PUSHGATEWAY_URL` to `http://pushgateway:9091` when the env var is unset. That default is only reachable once `workers` is attached to the `observability` network — which it now is. **Do not set `PUSHGATEWAY_URL` in `.env.secrets`**; the code default is correct.
- **Logs (all containers → Loki):** Unchanged by ADR-0004. All 13 open-brain containers use the Docker `loki` log driver (`x-logging` anchor in `docker-compose.yml`), which runs in the **Docker daemon** process on the host — not inside any container, and not on the `observability` compose network. The daemon reaches Loki via `LOKI_URL` (default `http://localhost:3100/loki/api/v1/push`), because Loki publishes its port to `127.0.0.1:3100` on the same host (ADR-0002). This path does not depend on the `observability` network join at all.

Only `core-api` and `workers` needed the network join — they are the only two open-brain services with a live Prometheus target or a Pushgateway push path. Every other service (slack-bot, voice-capture, web-next, postgres, redis, etc.) stays on `open-brain` only.

---

## What open-brain does NOT own anymore

- Bring-up / tear-down / upgrade of Loki, Prometheus, Grafana, Pushgateway. Those live in the separate observability compose project's own repo/runbook on the homeserver — out of scope for this repo.
- The `GRAFANA_ADMIN_PASSWORD` credential lifecycle for the *running* Grafana instance (the shared instance is administered by the observability project, not this one).
- Named volumes for observability data (`prometheus_data`, `grafana_data`, `loki_data` were removed from `docker-compose.yml` by ADR-0004; the underlying host directories are now owned by the standalone stack).

This repo still carries `config/prometheus/prometheus.yml` and `config/prometheus/alerts/*.yml` as the **authoritative definitions** of open-brain's scrape config and alert rules (referenced by `docs/SLO.md` and the alert runbooks), but no container in this repo's compose file mounts or runs Prometheus anymore — reconciling these definitions into the shared Prometheus's actual running config is a step owned by the observability project, not by an in-repo Prometheus container.

---

## Verifying the client-join is healthy

```bash
# core-api and workers should each show BOTH networks
docker inspect open-brain-core-api --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool
docker inspect open-brain-workers  --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool
# Expect keys: "open-brain_open-brain" and "observability"

# Prometheus target health (from the homeserver — Prometheus is loopback-bound per ADR-0002)
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | grep -A3 '"job":"open-brain-core-api"'

# Pushgateway receiving workers' pushes
curl -s http://localhost:9091/metrics | grep 'job="open-brain"'

# Loki receiving logs from all 13 containers
# Grafana → Loki explorer: {compose_project="open-brain"}
```

If `docker inspect` shows only `open-brain_open-brain` for core-api or workers, the network join was lost (e.g. a redeploy that didn't preserve the compose `networks:` block, or the `observability` external network doesn't exist yet on this host). Re-running `docker compose up -d --force-recreate --no-deps core-api workers` against a `main` checkout that includes the ADR-0004 topology will re-attach both.

**Interim relief is explicitly discouraged** (ADR-0004 owner decision: no runtime bridge, fix via the durable compose join instead). If one is ever genuinely needed, it **must** include the alias, or the scrape still fails:

```bash
docker network connect --alias core-api observability open-brain-core-api
```

A bare `docker network connect observability open-brain-core-api` (no `--alias core-api`) attaches the container but Prometheus still cannot resolve `core-api` — this exact mistake was caught during the ADR-0004 investigation (LAB_NOTEBOOK Entry 181).

---

## `--remove-orphans` prohibition

**Never run `docker compose up`/`down` with `--remove-orphans` against open-brain's compose project.** The four legacy GPL service definitions were deleted from `docker-compose.yml` by ADR-0004, but the rule predates and outlives that change: `--remove-orphans` acts on containers carrying this project's compose labels that no longer match a defined service, and the standalone observability stack runs its own separate compose project on the same Docker host. There is no scenario in this repo's deploy process where `--remove-orphans` is required — every deploy here uses an explicit, named service list (e.g. `up -d --force-recreate --no-deps core-api workers`). This is enforced in CLAUDE.md and cross-referenced from `docs/runbooks/deploy.md`.

---

## Alert rules (definitions live here, Prometheus is external)

`config/prometheus/alerts/*.yml` in this repo defines every open-brain-specific alert. The rule files:

| File | Alerts |
|------|--------|
| `budget.yml` | AI cost budget breach (soft/hard) |
| `capture-flow.yml` | No captures ingested in 6h during active hours |
| `container-health.yml` | Container down / OOM |
| `integration.yml` | Integration error rate elevated |
| `pipeline.yml` | Pipeline queue depth / failed jobs |
| `slo.yml` | API / search / MCP p99 latency SLO breaches (see `docs/runbooks/slo-alert.md`) |
| `workers-staleness.yml` | Pushgateway push staleness / workers metrics absent |

Each alert's `runbook:` annotation points to a file in `docs/runbooks/` — see the per-alert runbook for diagnosis and mitigation:

- `docs/runbooks/budget-alert.md`
- `docs/runbooks/capture-flow-alert.md`
- `docs/runbooks/container-health-alert.md`
- `docs/runbooks/integration-alert.md`
- `docs/runbooks/pipeline-alert.md`
- `docs/runbooks/slo-alert.md`

To validate rule file syntax locally before a change is picked up by the shared Prometheus:

```bash
bash scripts/validate-alert-rules.sh
```

---

## Related

- `docs/adr/ADR-0004-observability-repoint.md` — the decision, alternatives considered, and rollback plan for this topology
- `docs/adr/ADR-0002-lan-exposure-model.md` — port-binding posture (Prometheus/Loki loopback-only, Grafana LAN-visible)
- `docs/SLO.md` — SLO targets measured via the metrics documented here
- `docs/runbooks/slo-alert.md` — SLO breach diagnosis/mitigation
- `docs/runbooks/deploy.md` — deploy mechanics, including the `--remove-orphans` prohibition and config-diff gate referenced above
- CLAUDE.md — "Docker / infra" section carries the durable operational rules for this topology (network join mechanics, `PUSHGATEWAY_URL`/`LOKI_URL` defaults, `--remove-orphans` prohibition)
