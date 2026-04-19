# IMPLEMENT_PHASE-P12 — Observability IaC consolidation

**Phase:** P12  
**Title:** Observability part 2: IaC consolidation  
**Issue:** #113 (final subset)  
**Dependencies:** P11a ✅ (PR #143), P11b ✅ (PR #146)  
**Operator-approval required:** YES — touches homeserver, observability config (Gate 5 matrix)  
**Gate 1 produced:** 2026-04-19  

---

## Scope summary

Bring Prometheus, Grafana, Loki, and Pushgateway from standalone imperative scripts into `docker-compose.yml` under an `observability` profile. After this phase:
- `docker compose --profile observability up -d` starts the full observability stack from version-controlled config
- `scripts/deploy-loki.sh` is deleted (folded into compose)
- `scripts/post-compose-up.sh` footprint is reduced (only Ollama + Gitea network-attach remains, or deleted entirely if those aren't needed post-compose)
- A runbook at `docs/runbooks/observability.md` documents operator bring-up, tear-down, and cutover procedure

---

## Scope diff — what has changed since the card was written

### What the card assumed

The card (PHASED_PLAN.md § P12) assumed:
1. Loki is a standalone container deployed via `scripts/deploy-loki.sh`
2. Prometheus/Grafana/Pushgateway are also standalone containers (not in compose)
3. `scripts/post-compose-up.sh` handles Gitea + Ollama network-attach (and possibly Loki)
4. All four services need to be added to compose under `profiles: [observability]`

### What actually exists (post-P11a + P11b)

**Confirmed standalone (not in docker-compose.yml):**
- `loki` — deployed via `scripts/deploy-loki.sh`. Config at `config/loki/loki-config.yaml`. Data at `/mnt/user/appdata/loki/`. Port 3100. ✅ Running.
- `prometheus` — standalone. Config reference at `config/prometheus/prometheus.yml` (REFERENCE ONLY comment — homeserver has additional scrape_configs). Alert rules at `config/prometheus/alerts/*.yml`. Port 9090.
- `grafana` — standalone. Port 3050. Provisioning config at `config/grafana/provisioning/` (datasources.yaml, dashboards.yaml). Dashboard JSONs at `config/grafana/dashboards/`.
- `pushgateway` — standalone. Port 9091. Workers push queue/container-health metrics here.

**Confirmed in docker-compose.yml:**
- All 13 application services have `logging: driver: loki` stanzas pointing to `${LOKI_URL:-http://homeserver.k4jda.net:3100/loki/api/v1/push}`. This was P11a.
- No observability services in compose at all — no `profiles:` key exists anywhere in the file.

**`scripts/post-compose-up.sh`:** Handles only Ollama + Gitea network-attach. No Loki wiring (Loki is connected via `docker run --network` in `deploy-loki.sh`). The script is already minimal — deletion may not be appropriate since Ollama + Gitea are legitimately standalone.

**`scripts/deploy-loki.sh`:** 120-line imperative script that: installs the loki docker log driver plugin, runs the Loki container with `docker run`, waits for readiness, and adds the Loki datasource to Grafana via API call. All of this is redundant once Loki is in compose (except the plugin install step).

**Prometheus config nuance:** `config/prometheus/prometheus.yml` has an explicit comment: "REFERENCE ONLY — do NOT replace the homeserver's prometheus.yml." The homeserver prometheus.yml has additional scrape_configs (node-exporter, cadvisor, etc.) not tracked in git. This means the Prometheus compose service must mount the homeserver's actual config, not the repo reference file — OR the repo reference file must be expanded to include the complete config. **This is a scope risk that requires a decision (see Work Item 1.1).**

**Grafana datasource provisioning:** `config/grafana/provisioning/datasources/datasources.yaml` is already written (from P11a) with both Prometheus and Loki datasources. The Grafana compose service should mount this directory as `/etc/grafana/provisioning/` to auto-provision on startup.

**`LOKI_URL` env var:** Currently in `docker-compose.yml` logging stanzas as `${LOKI_URL:-http://homeserver.k4jda.net:3100/loki/api/v1/push}`. When Loki moves into compose, the internal URL changes from `homeserver.k4jda.net:3100` to `loki:3100`. The default value in the stanzas must be updated to the container-name URL, and `LOKI_URL` must be set in `.env.secrets` on homeserver to the external URL for the transition window (or simply rely on the updated default).

**Gitea network-attach in `post-compose-up.sh`:** The card says "reduced to Gitea + Ollama network-attach only (or deleted if those also move into compose)." Gitea and Ollama are Unraid community applications — they are NOT moving into open-brain compose (D31 decision). `post-compose-up.sh` must be kept, just confirmed minimal.

### Scope drift items

| Item | Card assumption | Reality | Impact |
|------|----------------|---------|--------|
| `post-compose-up.sh` deletion | Card said "or deleted if those move into compose" | Gitea/Ollama stay standalone → script must be kept | Minor: deliverable changes to "confirm minimal, document" rather than delete |
| Prometheus config strategy | Card implied direct migration | Homeserver prometheus.yml has extra scrape_configs not in repo | Decision required before implementing: expand repo config OR mount homeserver config separately |
| `LOKI_URL` default in compose stanzas | Card didn't address | 13 stanzas point to external homeserver IP; must update to `loki:3100` when Loki is in compose | Work item added |
| Plugin install step | Part of deploy-loki.sh | Loki Docker log driver plugin must already be installed on homeserver daemon; compose cannot install Docker plugins | Note in runbook: plugin is a prerequisite, not automated by compose |

---

## Work items

### 1.1 — Prometheus config strategy decision + repo config expansion

**File:** `config/prometheus/prometheus.yml`  
**Current state:** Reference-only file with Open Brain scrape job inline as comments and note to NOT replace homeserver config.  
**Decision required:** Two options:

- **Option A (recommended):** Expand the repo `prometheus.yml` to be the _complete_ homeserver config: Open Brain job + node-exporter + cadvisor + pushgateway + rule_files stanza. Remove the "REFERENCE ONLY" header. The homeserver Prometheus compose service mounts this file. This makes the config fully IaC and removes the manual copy-paste burden.  
  _Risk:_ Requires operator to confirm current homeserver prometheus.yml content so additional scrape_configs can be captured.

- **Option B:** Keep the reference file as-is. Compose service mounts a separate `config/prometheus/homeserver.yml` that operator manually maintains. The Open Brain–specific config lives in `open-brain-scrape.yaml` (already exists) and is included via `scrape_config_files`.  
  _Risk:_ Homeserver config still partially out of git.

**Recommendation:** Option A. The homeserver prometheus.yml extra jobs (node-exporter, cadvisor) are trivial standard stanzas — operator provides the current file, implementer captures it in the repo, and from that point forward the repo is the truth.

**Action:** Operator provides the current homeserver prometheus.yml content before Gate 3 begins so Work Item 1.1 can be executed correctly. This is a Gate 1 dependency — see "Pre-implementation operator action" section below.

---

### 1.2 — Add observability services to docker-compose.yml under `observability` profile

**File:** `docker-compose.yml`  
**Changes:**

Add named volumes (before `services:`):
```yaml
volumes:
  # existing...
  prometheus_data:
  grafana_data:
  loki_data:
```

Add four services at the end of the file, all with `profiles: [observability]`:

**`loki` service:**
```yaml
  loki:
    image: grafana/loki:latest
    container_name: open-brain-loki
    volumes:
      - loki_data:/loki/data
      - ./config/loki/loki-config.yaml:/etc/loki/local-config.yaml:ro
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    mem_limit: 512m
    networks:
      - open-brain
    restart: unless-stopped
    profiles:
      - observability
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3100/ready || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
```
Note: No `logging: driver: loki` on the `loki` service itself — that would create a chicken-and-egg dependency.

**`pushgateway` service:**
```yaml
  pushgateway:
    image: prom/pushgateway:latest
    container_name: open-brain-pushgateway
    ports:
      - "9091:9091"
    mem_limit: 128m
    networks:
      - open-brain
    restart: unless-stopped
    profiles:
      - observability
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:9091/-/healthy || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**`prometheus` service:**
```yaml
  prometheus:
    image: prom/prometheus:latest
    container_name: open-brain-prometheus
    volumes:
      - ./config/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./config/prometheus/alerts:/etc/prometheus/alerts:ro
      - prometheus_data:/prometheus
    ports:
      - "9090:9090"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.enable-lifecycle'
    mem_limit: 1g
    networks:
      - open-brain
    restart: unless-stopped
    profiles:
      - observability
    depends_on:
      pushgateway:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:9090/-/healthy || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
```

**`grafana` service:**
```yaml
  grafana:
    image: grafana/grafana:latest
    container_name: open-brain-grafana
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_SERVER_HTTP_PORT: "3050"
    volumes:
      - grafana_data:/var/lib/grafana
      - ./config/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./config/grafana/dashboards:/var/lib/grafana/dashboards/open-brain:ro
    ports:
      - "3050:3050"
    mem_limit: 512m
    networks:
      - open-brain
    restart: unless-stopped
    profiles:
      - observability
    depends_on:
      prometheus:
        condition: service_healthy
      loki:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3050/api/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
```

**`LOKI_URL` default update:** The 13 `loki-url` stanzas currently default to `http://homeserver.k4jda.net:3100/loki/api/v1/push`. Once Loki is in compose on the same Docker network, the default should be `http://loki:3100/loki/api/v1/push`. Update all 13 stanzas. The `LOKI_URL` env var in `.env.secrets` on homeserver overrides if set — homeserver should either remove the variable (to use the new default) or update it.

---

### 1.3 — Update `config/prometheus/prometheus.yml` to be the full homeserver config

**File:** `config/prometheus/prometheus.yml`  
**Current state:** Reference-only with Open Brain scrape job and comment.  
**Target state:** Complete working config that the compose Prometheus service mounts. Remove the "REFERENCE ONLY" header. Include:
- Open Brain core-api scrape job (already in `open-brain-scrape.yaml` — inline or include)
- Pushgateway scrape job (workers push metrics here)
- `rule_files: ["alerts/*.yml"]` stanza (alert rules already exist in `config/prometheus/alerts/`)
- Any homeserver-specific jobs (node-exporter, cadvisor) captured from operator input

Note: `config/prometheus/open-brain-scrape.yaml` contains the core-api job definition — it can be inlined into the main file or referenced via `scrape_config_files`. Inline is simpler for IaC (one file, no path resolution questions).

---

### 1.4 — Delete `scripts/deploy-loki.sh`

**File:** `scripts/deploy-loki.sh` → **DELETE**  
**Rationale:** All functionality covered by compose. The loki Docker log driver plugin install step is a one-time homeserver prerequisite (already done) — document it in the runbook.  
**Git action:** `git rm scripts/deploy-loki.sh`

---

### 1.5 — Confirm `scripts/post-compose-up.sh` is minimal and correct

**File:** `scripts/post-compose-up.sh`  
**Current state:** 35 lines. Connects `ollama` and `Gitea` to `open-brain_open-brain` network. No Loki wiring.  
**Required change:** None to the script itself. The script is already minimal and correct per D31. Add a comment clarifying Loki is no longer in scope (handled by compose profile). Update the file header comment to reference the observability profile. No deletion.

---

### 1.6 — Write `docs/runbooks/observability.md`

**File:** `docs/runbooks/observability.md` (new)  
**Content:**
- One-line architecture diagram: `app containers → Loki log driver → Loki → Grafana` + `core-api /metrics → Pushgateway → Prometheus → Grafana`
- **Bring-up:** `docker compose --profile observability up -d`. Expected: 4 new containers healthy within 60s.
- **Prerequisite:** Loki Docker log driver plugin must be installed on the Docker host daemon. Command: `docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`. One-time per host. Already done on homeserver.
- **Cutover from standalone containers:** Step-by-step: stop standalone containers (`docker stop loki grafana prometheus pushgateway`), start compose profile, verify health, migrate data volumes.
- **Data migration note:** Prometheus and Grafana data are in named Docker volumes on homeserver (or host bind-mounts from the standalone `docker run` invocations). The runbook must document how to migrate existing Grafana state (dashboards are already provisioned-as-code; only user preferences and alert silences need migration, which can be re-created).
- **Loki data:** `/mnt/user/appdata/loki/` on homeserver — mount this as the named volume source on first compose-up to preserve log history. The `loki_data` named volume should use a `driver_opts` bind to that host path on homeserver.
- **Tear-down:** `docker compose --profile observability stop` (stops without removing volumes).
- **Grafana password:** Set `GRAFANA_ADMIN_PASSWORD` in `.env.secrets`. Bitwarden item: `open-brain-grafana-admin-password`.
- **Post-deploy check:** `curl -s http://localhost:9090/-/healthy`, `curl -s http://localhost:3100/ready`, `curl -s http://localhost:3050/api/health`, `curl -s http://localhost:9091/-/healthy`.

---

### 1.7 — Update Grafana provisioning dashboards path

**File:** `config/grafana/provisioning/dashboards.yaml`  
**Current state:** `path: /var/lib/grafana/dashboards/open-brain`  
**Verify:** This path must match the volume mount in the Grafana compose service. Work Item 1.2 mounts `./config/grafana/dashboards` → `/var/lib/grafana/dashboards/open-brain`. Paths align — no change needed, but confirm during implementation.

---

### 1.8 — Add `GRAFANA_ADMIN_PASSWORD` to `.env.secrets.template`

**File:** `deploy/.env.secrets.template` (or wherever the secrets template lives)  
**Change:** Add `GRAFANA_ADMIN_PASSWORD=get-from-bitwarden-open-brain-grafana-admin-password` with a comment. Bitwarden item to create: `open-brain-grafana-admin-password`.  
**Note:** If the password was already set manually on the standalone Grafana instance, retrieve it before cutover and store in Bitwarden.

---

### 1.9 — Validate-alert-rules.sh: update for compose path

**File:** `scripts/validate-alert-rules.sh`  
**Check:** The script currently validates alert YAML files at `config/prometheus/alerts/`. The compose Prometheus service mounts them at `/etc/prometheus/alerts/`. The script runs locally and doesn't depend on mount paths — no change needed. Confirm during implementation.

---

## Files changed

| File | Action |
|------|--------|
| `docker-compose.yml` | Add 4 services + 3 named volumes + update 13 `loki-url` defaults |
| `config/prometheus/prometheus.yml` | Expand to full config; remove "REFERENCE ONLY" header |
| `scripts/deploy-loki.sh` | DELETE |
| `scripts/post-compose-up.sh` | Comment update only (no functional change) |
| `docs/runbooks/observability.md` | CREATE |
| `deploy/.env.secrets.template` | Add `GRAFANA_ADMIN_PASSWORD` placeholder |

---

## Acceptance criteria

- [ ] `docker compose --profile observability up -d` starts 4 new containers (`open-brain-loki`, `open-brain-prometheus`, `open-brain-grafana`, `open-brain-pushgateway`), all pass healthcheck within 60s
- [ ] `scripts/deploy-loki.sh` is deleted; `git rm` committed
- [ ] `scripts/post-compose-up.sh` remains (Ollama + Gitea only); header comment accurate
- [ ] `docs/runbooks/observability.md` exists with cutover steps, bring-up, data migration notes, Grafana password setup
- [ ] All 13 `loki-url` defaults in docker-compose.yml updated to `http://loki:3100/...`
- [ ] `config/prometheus/prometheus.yml` is a working complete config (not reference-only); mounts cleanly into Prometheus container
- [ ] No test regressions (this phase has no TS changes; CI should be clean)

---

## Pre-implementation operator action (required before Gate 3)

**BLOCKING:** Before the implementer can write Work Item 1.3 (complete prometheus.yml), the operator must provide the current homeserver `prometheus.yml` content so the standalone scrape_configs (node-exporter, cadvisor, etc.) can be captured in git.

**Command to run on homeserver:**
```bash
ssh root@homeserver.k4jda.net cat /mnt/user/appdata/prometheus/prometheus.yml
```
(Adjust path if Prometheus data is elsewhere — `docker inspect prometheus | grep -A5 Mounts` will show the bind mount.)

Also needed: current Grafana admin password (if set on standalone instance):
```bash
docker exec grafana env | grep GF_SECURITY_ADMIN_PASSWORD
```
Or retrieve from Bitwarden if already stored.

If the operator is OK with Option B (keep partial prometheus config out of git), the implementer can skip the content capture and proceed with the reference-only approach. But Option A is strongly recommended.

---

## Rollback plan

**Before cutover (compose profile not yet activated on homeserver):**
- No functional change to running system. Revert `docker-compose.yml` changes. All four observability containers continue running as standalone.

**During/after cutover on homeserver:**
- Stop compose-profile containers: `docker compose --profile observability stop`
- Restart standalone containers from their original `docker run` commands (documented in `scripts/deploy-loki.sh` — which is why the script should be archived/tagged before deletion, or the `git` history is the rollback)
- Restore `LOKI_URL` in `.env.secrets` if changed

**Data:** Prometheus/Loki data in named compose volumes. If cutover fails, standalone containers can be restarted — they'll resume from their original bind-mount data directories on the host.

---

## Effort estimate

**Original card:** ~2-3 days  
**Gate 1 assessment:** 1.5-2 days. The structural work is mechanical (four service stanzas + config edits + one runbook). The prometheus.yml expansion requires operator input to capture homeserver-specific scrape_configs, which could add up to 30 minutes of back-and-forth if the operator runs the audit commands promptly. No TS code changes → no test suite risk.

---

## Dependencies confirmed

| Dependency | Status |
|-----------|--------|
| P11a — Loki log driver wiring in docker-compose.yml | ✅ Merged PR #143 |
| P11b — Alert rules + Grafana dashboards | ✅ Merged PR #146 |
| All four observability containers running standalone on homeserver | ✅ Confirmed (per loki-setup.md, deploy-loki.sh, docs/runbooks/) |
| Loki Docker log driver plugin installed on homeserver | ✅ Part of original P11a deploy |

---

## LAB_NOTEBOOK pre-action entry (to be written before first commit in Gate 3)

**Entry NNN — P12 Observability IaC consolidation**  
**Tags:** [deploy] [docker] [config] [observability]  
**Objective:** Bring Prometheus, Grafana, Loki, Pushgateway into docker-compose.yml under `observability` profile; delete `deploy-loki.sh`; write runbook.  
**Hypothesis:** After this PR, `docker compose --profile observability up -d` starts the full observability stack from version-controlled config. Existing standalone containers continue running until operator cuts over on homeserver.  
**Rollback:** `git revert` PR; standalone containers restart from original `docker run` commands (preserved in git history).  
**Success criteria:** Gate 3 acceptance list fully checked; CI green; no TS changes so no test regressions expected.
