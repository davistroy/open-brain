# IMPLEMENT_PHASE-P11a — Observability part 1a: Loki log driver wiring

**Source card:** PHASED_PLAN.md § P11a
**Tracks issues:** #113 (subset — route all container logs to Loki)
**Effort estimate:** ~4–5 hours (slight up from card's 1 day — see scope diff)
**Branch (Gate 2 will create):** `feat/phase-P11a-loki-log-driver`
**Gate 5 path:** operator-approval required — `docker-compose.yml` is a production infra file; all 14 services affected; homeserver deploy required

---

## Investigation findings

### Loki deployment status

Loki runs as a **standalone container on homeserver** (not in `docker-compose.yml`). Confirmed by:
- `config/loki/loki-config.yaml` header: "Deployed as standalone container on homeserver (not in docker-compose.yml)"
- No `loki` service in `docker-compose.yml`
- Grafana dashboards reference only `${DS_PROMETHEUS}` — no `DS_LOKI` datasource template variable anywhere

The card says "Loki must be running on homeserver (it is, per PR #76)." That is confirmed. The Loki HTTP API is at `http://<homeserver-ip>:3100` or `http://loki:3100` (if Loki's container is named `loki` on the same Unraid Docker network). The exact Loki address must be verified at deploy time.

### Current logging setup

**Structured logging is already in place.** All five packages use `pino` via the shared `createLogger()` factory at `packages/shared/src/lib/logger.ts`:

```typescript
export function createLogger(name?: string): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    ...(name ? { name } : {}),
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  })
}
```

In **production** (`NODE_ENV=production`, which is the docker-compose default), pino outputs **newline-delimited JSON to stdout** with no transport configured. This is ideal for the Docker `loki` log driver — the driver ships raw log lines, and Loki indexes them. Zero change required to `logger.ts` for this phase.

**Named loggers in use across packages:**
- `config-service`, `composio`, `gmail-client`, `hotmail-client`, `himalaya`, `ingest-router`, `pushover`, `run-agent`, `slack-messenger`, `wiki-git`, `wiki-service` (in shared/core-api)
- `voice-capture`, `voice-classification` (in voice-capture)
- All workers files import the shared `logger` singleton (unnamed)
- All slack-bot files import the shared `logger` singleton (unnamed)

Pino's `name` field will appear as `{"name":"config-service",...}` in the JSON — Loki can index on it.

### Docker log driver approach — decision

Two approaches to get container logs into Loki:
1. **Docker `loki` log driver** (per-container `logging:` stanza in `docker-compose.yml`) — ships log lines directly to Loki's push API. Zero Promtail needed.
2. **Promtail sidecar** reading `/var/lib/docker/containers` — more complex, requires Promtail container + volume mount.

**Decision: Docker `loki` log driver.** Simpler, aligns with card deliverable ("logging: driver: loki"), and avoids a new sidecar container. Requires the `grafana/loki-docker-driver` plugin installed on the homeserver Docker daemon. This plugin is installed once at the host level (`docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`) and persists across container restarts.

**Failure mode:** If the Loki log driver loses contact with Loki (network partition), Docker falls back to `none` driver — log lines are dropped, not buffered to disk. Acceptable for a personal system; noted in CLAUDE.md.

### Service inventory — 14 active services

From `docker-compose.yml` container names (excluding commented-out ollama):

| # | Container | mem_limit |
|---|-----------|-----------|
| 1 | open-brain-postgres | 8g |
| 2 | open-brain-redis | 512m |
| 3 | open-brain-core-api | 1500m |
| 4 | open-brain-workers | 1500m |
| 5 | open-brain-slack-bot | 1500m |
| 6 | open-brain-voice-pipecat | 4g |
| 7 | open-brain-file-ingestion | 1536m |
| 8 | open-brain-faster-whisper | 8g |
| 9 | open-brain-voice-capture | 1500m |
| 10 | open-brain-web | 256m |
| 11 | open-brain-cloudflared | 256m |
| 12 | open-brain-financial-ingest | 1500m |
| 13 | open-brain-utility-ingest | 1500m |
| 14 | (ollama — standalone, skip) | — |

Card says "14 services" — that matches 13 active services in compose + ollama (standalone). Card is correct; ollama is excluded from compose driver changes but its standalone container is not in scope.

### Current docker-compose.yml logging state

**No `logging:` stanza exists anywhere in `docker-compose.yml`** — all containers use the Docker default json-file driver. Confirmed by:
```
grep -n "logging\|driver" docker-compose.yml
```
Output shows only `driver: bridge` (network) — zero logging directives.

### Grafana Loki datasource — gap identified

Grafana provisioning currently has only `config/grafana/provisioning/dashboards.yaml`. There is **no datasource provisioning file** (`config/grafana/provisioning/datasources/`). Grafana dashboards reference `${DS_PROMETHEUS}` only.

To make Loki useful in Grafana, a datasource provisioning file is needed. Without it, a user would have to manually add the Loki datasource via the UI on every Grafana reinstall. Since this is IaC-tracked infra, the datasource should be provisioned as code.

**Scope drift note:** The card says nothing about Grafana datasource provisioning — it only mentions "verify it appears in Grafana/Loki query." Adding the datasource provision file is in-scope and necessary for the acceptance criterion to be machine-verifiable. Not scope creep — it's the mechanical underpinning of the acceptance criterion.

### Loki push URL

The loki-docker-driver needs a `loki-url` in the logging options. On the homeserver, Loki's standalone container is presumably on the default Unraid Docker bridge. The `open-brain` compose network is custom bridge. Loki URL must be an address reachable from within Docker containers — either:
- `http://homeserver-ip:3100/loki/api/v1/push` — host IP (always works)
- `http://loki:3100/loki/api/v1/push` — if Loki container is named `loki` on a shared network

**The URL is parameterized via env var `LOKI_URL` in `docker-compose.yml` with a sensible default.** The deploy operator sets it in `.env`. This avoids hardcoding an IP that could change.

---

## Scope diff

**No drift on core deliverable** — Loki is running, compose file needs `logging:` stanzas, and pino already emits JSON.

**Additions required but not in card:**
1. **Grafana Loki datasource provisioning file** (`config/grafana/provisioning/datasources/datasources.yaml`) — needed for Grafana to query Loki without manual UI config. Necessary for acceptance criterion. Not scope creep.
2. **`.env` `LOKI_URL` placeholder** — parameterize the driver URL so homeserver IP isn't hardcoded. One line.
3. **Homeserver pre-flight: `docker plugin ls` check** — operator must confirm `loki` plugin is installed before deploy. Documented in acceptance criteria.

**Nothing invalidated from card.**

---

## Work items

### 1.1 — LAB_NOTEBOOK pre-action entry

**File:** `LAB_NOTEBOOK.md`

Pre-action entry before first commit per ORCHESTRATOR.md template. Entry covers all work items in this phase with:
- Objective: route all 13 compose containers to Loki via Docker log driver
- Hypothesis: after compose recreate, each container's logs appear in Loki within 30s
- Rollback: remove `logging:` stanzas from docker-compose.yml + `docker compose up -d`

### 1.2 — Add `LOKI_URL` to `.env`

**File:** `.env`

Append one non-sensitive config line after `LOG_LEVEL=info`:

```bash
# Loki log driver endpoint — set to your Loki push URL before deploying P11a
# Format: http://<host-ip>:3100/loki/api/v1/push
LOKI_URL=http://homeserver.k4jda.net:3100/loki/api/v1/push
```

This is non-sensitive (no credentials). The default matches the known homeserver FQDN.

### 1.3 — Add `logging:` stanzas to all 13 compose services

**File:** `docker-compose.yml`

Add the following `logging:` block to **every service** (immediately after `restart: unless-stopped` for each service, or as the last stanza before the next service):

```yaml
    logging:
      driver: loki
      options:
        loki-url: "${LOKI_URL:-http://homeserver.k4jda.net:3100/loki/api/v1/push}"
        loki-batch-size: "400"
        loki-retries: "3"
        loki-max-backoff: "800ms"
        loki-timeout: "2s"
        loki-pipeline-stages: |
          - json:
              expressions:
                level: level
                name: name
                msg: msg
          - labels:
              level:
              name:
```

**Labels extracted:**
- `level` — pino log level (info/warn/error/debug) — enables Grafana `{level="error"}` filters
- `name` — pino logger name (e.g., `config-service`, `wiki-service`) — enables per-module queries

**Services that don't emit pino JSON** (postgres, redis, faster-whisper, cloudflared, web/nginx) still get the loki driver — their logs go in as raw text without label extraction. The pipeline stages produce empty labels for those, which is fine — they still appear in Loki under `{container_name="open-brain-postgres"}`.

**loki-batch-size 400 bytes:** Low value intentional — these are short-lived single-line JSON logs. Default 100K would batch for too long; 400 flushes quickly.

**Services to update (in order they appear in docker-compose.yml):**
1. `postgres` (line ~35)
2. `redis` (line ~53)
3. `core-api` (line ~96)
4. `workers` (line ~146)
5. `slack-bot` (line ~172)
6. `voice-pipecat` (line ~181)
7. `file-ingestion` (line ~231)
8. `faster-whisper` (line ~257)
9. `voice-capture` (line ~281)
10. `web` (line ~316)
11. `cloudflared` (line ~338)
12. `financial-ingest` (line ~365)
13. `utility-ingest` (line ~405)

### 1.4 — Grafana Loki datasource provisioning

**New file:** `config/grafana/provisioning/datasources/datasources.yaml`

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    uid: DS_PROMETHEUS
    url: http://prometheus:9090
    access: proxy
    isDefault: true
    editable: false

  - name: Loki
    type: loki
    uid: DS_LOKI
    url: http://loki:3100
    access: proxy
    isDefault: false
    editable: false
    jsonData:
      maxLines: 1000
```

**Note on Prometheus UID:** The existing dashboards use `${DS_PROMETHEUS}` template variable, which Grafana resolves against the datasource UID `DS_PROMETHEUS`. This provisioning entry locks in that UID so existing dashboards work after container recreate. This is additive (it was previously set manually in Grafana UI only).

**Note on Loki URL:** `http://loki:3100` assumes Grafana and Loki share a Docker network. On homeserver Unraid, standalone containers default to `br0` bridge. Operator must verify connectivity at deploy. If Loki is not on the same network as Grafana, use the homeserver IP instead.

### 1.5 — Update Grafana provisioning dashboards path to include datasources dir

**File:** `config/grafana/provisioning/dashboards.yaml`

No change needed — this file only covers dashboard providers. The new `datasources/` subdirectory is discovered automatically by Grafana's provisioning system when mounted at `/etc/grafana/provisioning/`.

**Verify the Grafana container volume mount includes provisioning:** Grafana is a standalone container on homeserver (not in compose), so the operator must ensure `/config/grafana/provisioning` is mounted at `/etc/grafana/provisioning` in the Grafana container. Document in acceptance criteria.

### 1.6 — Add CLAUDE.md rule

**File:** `CLAUDE.md`

Add to the "Docker / infra" section:

```
- **All containers log to Loki via Docker loki log driver.** Use Grafana Loki explorer for log search across containers. Log driver parameterized by `LOKI_URL` in `.env`. If Loki is unreachable, Docker falls back to `none` driver — logs are dropped (not buffered). Plugin must be pre-installed: `docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`.
```

### 1.7 — Validation script

**New file:** `scripts/test-loki-routing.sh`

Lightweight operator runbook to verify each container's logs appear in Loki after deploy:

```bash
#!/usr/bin/env bash
# P11a — Verify each container's logs reach Loki
# Usage: LOKI_URL=http://homeserver.k4jda.net:3100 bash scripts/test-loki-routing.sh
set -euo pipefail

LOKI="${LOKI_URL:-http://homeserver.k4jda.net:3100}"
SERVICES=(
  open-brain-postgres open-brain-redis open-brain-core-api
  open-brain-workers open-brain-slack-bot open-brain-voice-pipecat
  open-brain-file-ingestion open-brain-faster-whisper open-brain-voice-capture
  open-brain-web open-brain-cloudflared open-brain-financial-ingest open-brain-utility-ingest
)

PASS=0; FAIL=0
for svc in "${SERVICES[@]}"; do
  # Query Loki for any log line from this container in the last 5 minutes
  result=$(curl -s -G "${LOKI}/loki/api/v1/query_range" \
    --data-urlencode "query={container_name=\"${svc}\"}" \
    --data-urlencode "start=$(date -d '5 minutes ago' +%s)000000000" \
    --data-urlencode "end=$(date +%s)000000000" \
    --data-urlencode "limit=1")
  count=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('data',{}).get('result',[])))" 2>/dev/null || echo "0")
  if [ "$count" -gt 0 ]; then
    echo "PASS: $svc — logs present in Loki"
    PASS=$((PASS+1))
  else
    echo "FAIL: $svc — no logs in Loki (last 5 min)"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

---

## Pre-deploy operator checklist (homeserver)

These cannot be automated in CI — documented here for Gate 5.5:

1. **Install loki Docker plugin** (one-time, if not already installed):
   ```bash
   docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
   docker plugin ls  # verify "loki" appears as enabled
   ```

2. **Set `LOKI_URL`** in `/mnt/user/appdata/open-brain/.env` (or confirm default hostname resolves):
   ```bash
   echo "LOKI_URL=http://homeserver.k4jda.net:3100/loki/api/v1/push" >> .env
   ```

3. **Verify Loki is reachable** from host:
   ```bash
   curl -s http://homeserver.k4jda.net:3100/ready
   # expected: "ready"
   ```

4. **Recreate containers** (required — `logging:` driver changes require `--force-recreate`, not just restart):
   ```bash
   docker compose up -d --force-recreate
   ```

5. **Run validation script**:
   ```bash
   bash scripts/test-loki-routing.sh
   # all 13: PASS
   ```

6. **Verify Grafana datasource** — open Grafana, confirm Loki datasource appears and status is "Data source connected and labels found."

7. **Mount datasources dir** — if Grafana standalone container does not already mount `/etc/grafana/provisioning/datasources`, add the mount to the Grafana container (Unraid template or `docker run` flags). This is a homeserver-side change; not in the compose file.

---

## Acceptance criteria

- [ ] `docker-compose.yml`: all 13 services have `logging: driver: loki` stanza
- [ ] `LOKI_URL` env var in `.env` (non-sensitive, defaults to homeserver FQDN)
- [ ] `config/grafana/provisioning/datasources/datasources.yaml` provisioned with Prometheus + Loki
- [ ] `scripts/test-loki-routing.sh` exists and is executable
- [ ] CLAUDE.md rule added: loki log driver + plugin install note
- [ ] **Homeserver post-deploy (operator):** loki plugin installed and enabled
- [ ] **Homeserver post-deploy (operator):** `scripts/test-loki-routing.sh` exits 0 — all 13 containers PASS
- [ ] **Homeserver post-deploy (operator):** Grafana Loki datasource shows "connected and labels found"
- [ ] **Homeserver post-deploy (operator):** `{container_name="open-brain-core-api"} |= "error"` Loki query returns results (or no results with clean message — not an API error)
- [ ] LAB_NOTEBOOK Entry (P11a) present with Objective/Hypothesis/Result filled

---

## Rollback

```bash
git revert <P11a merge sha>
docker compose up -d --force-recreate
```

Reverting the compose file removes all `logging:` stanzas. Containers restart with default json-file driver. Logs already shipped to Loki remain there (30-day retention per `loki-config.yaml`). No data loss. No schema changes.

If plugin is installed on homeserver, it can remain — it has no effect on containers using the default driver.

Safe without maintenance window.

---

## Scope creep to defer

- **P12** handles moving Loki/Grafana/Prometheus into the main compose file (currently standalone). This phase only wires the log driver to the existing standalone Loki.
- **P11b** adds Prometheus alert rules and Grafana dashboard panels — defer all alert work.
- **pino-http request logging** (structured HTTP access logs with `req.method`, `req.url`, `res.statusCode`) — useful but out of scope. Hono has its own logger middleware (`hono/logger`); integrating pino-http is a separate enhancement.
- **Log sampling / rate limiting** in pino (e.g., suppress debug logs in prod) — separate from driver wiring.
- **Loki label cardinality hardening** — no high-cardinality labels (no capture IDs, no user inputs) in the pipeline-stages config above; this is correct by default.

---

## Critical files for implementation

- `docker-compose.yml` — add `logging:` stanza to 13 services (primary change)
- `.env` — add `LOKI_URL` placeholder line
- `config/grafana/provisioning/datasources/datasources.yaml` — NEW
- `scripts/test-loki-routing.sh` — NEW (validation helper)
- `CLAUDE.md` — add loki driver operational rule
- `LAB_NOTEBOOK.md` — Entry (P11a)

**Files NOT changed:**
- `packages/shared/src/lib/logger.ts` — pino already emits JSON in prod; no changes needed
- Any package `*.ts` source files — no application code changes required
- `config/loki/loki-config.yaml` — Loki config is standalone container concern; not in scope
