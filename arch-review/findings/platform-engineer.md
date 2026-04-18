# Platform Engineer Findings

**Reviewer:** Platform Engineer
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain`
**Confidence:** High

---

## Pipeline Map

The flow from commit → running container has well-instrumented CI gates but the **deploy step itself is entirely manual**. Every deploy is a human-driven SSH session.

| Stage | Tool / Mechanism | Manual Step? | Gate Exists? |
|-------|-----------------|--------------|--------------|
| Commit & push | git → GitHub | No | — |
| CI: install + build | GitHub Actions `ci.yml` → pnpm build | No | Blocks merge |
| CI: lint | `pnpm -r lint` (includes `tsc --noEmit`) | No | Blocks merge |
| CI: test (TS unit) | `pnpm -r test` (vitest) | No | Blocks merge |
| CI: sidecar pytest | `sidecar-test` job (Python 3.12) | No | Blocks merge |
| CI: python lint | ruff + pyright | No | Blocks merge |
| CI: web build | **NOT IN CI** (per CLAUDE.md: re-enabled post-PR #100 — not visible in `ci.yml` file on disk) | — | **Unclear — see F2** |
| Secret scanning | GitGuardian (external) | No | Advisory |
| Monthly audit | `monthly-audit.yml` cron (pnpm outdated + Dependabot → Slack) | No | Advisory |
| Image build | `docker compose build` run on homeserver by human | **YES** | None |
| Image registry push | **None** — images built on target host only | — | — |
| Migration apply | `scripts/init-schema.sql` + manually apply `0001-0022.sql` | **YES** | None |
| Secrets pull | `bws secret list` by human (`load-secrets.sh` is a stub — see F1) | **YES** | None |
| Container bring-up | `docker compose up -d` | **YES** | compose healthchecks |
| Post-compose-up | `scripts/post-compose-up.sh` to re-attach ollama + Gitea to recreated bridge network | **YES** | Script-guarded |
| External health | Cloudflare Worker `synthetic-monitor` cron every 5min → Pushover | No | 2 consecutive failures |
| Backup | `scripts/backup.sh` via Unraid cron at 03:00 | No (cron) | No restore test |
| Monthly maintenance | `scripts/monthly-maintenance.sh` via cron 1st@06:00 | No (cron) | Slack report only |

---

## Deployment Strategy Assessment

- **Strategy identified:** **Recreate** (stop-all / start-all via `docker compose up -d`). No blue-green, no canary, no rolling deploy. Compose does start containers one dependency layer at a time via `depends_on: condition: service_healthy`, but every updated image causes its container to be killed and replaced.
- **Fit for risk tolerance:** Partial. This is a single-user system with relaxed availability needs, so recreate is defensible for core-api / workers. However there is **no rollback mechanism** defined anywhere — no image registry, no tagged image retention, no `docker compose` rollback script. If `pnpm --filter @open-brain/core-api build` breaks on homeserver due to an environmental difference, the only path back is `git checkout <prev-sha> && docker compose build && up -d`, which is still tens of minutes of downtime.
- **Specific concerns:**
  - **No image registry** — images are built on the homeserver from local source at deploy time. A Dockerfile regression at build time takes the system down; there is no "previous good image" to roll back to without re-building from an earlier commit.
  - **Build on target** — Dockerfile multi-stage build runs inside the homeserver (Intel i7-9700, 128 GB RAM). Host memory pressure during build is plausible; no guard against a build failure mid-deploy (existing containers get stopped before `docker compose up -d` completes the new build in the recreate flow).
  - **Deploy cadence is manual and lumpy** — intake documents "homeserver was 7 PRs behind main" pre-today. Batch deploys amplify blast radius — if a bad change is in the bundle, bisection is harder because multiple PRs went live simultaneously.

---

## Infrastructure-as-Code Audit

| Dimension | Finding | Severity |
|-----------|---------|----------|
| Coverage (% declared vs manual) | ~60% declared (docker-compose.yml = 11 core services). Prometheus, Grafana, Loki, Pushgateway, Ollama, Gitea, and all host-side Unraid cron entries are **NOT in compose** — standalone `docker run` commands and cron files only. Deployed via `scripts/deploy-loki.sh` (imperative), `deploy/cron/unraid-ingest.cron` (manual install), and undocumented standalone containers. | High |
| Idempotency | `docker-compose.yml` is idempotent. `scripts/backup.sh` is idempotent. `scripts/deploy-loki.sh` is mostly idempotent (handles existing container). `scripts/init-schema.sql` and migration application is **NOT idempotent** — CLAUDE.md rule: "CREATE TRIGGER is not idempotent … always add DROP TRIGGER IF EXISTS". Manual migrations are a known footgun. | Medium |
| State drift risk | **High.** The observability stack (Prometheus/Grafana/Loki) and supporting containers (Ollama, Gitea) live outside compose. `post-compose-up.sh` has to reattach them after each `compose up`. No declarative source of truth for their versions, configs, or volumes. If homeserver is rebuilt from scratch, reconstructing the observability + Ollama + Gitea state is unscripted. | High |
| Environment parity | Windows laptop dev vs Linux Alpine prod. Vitest fork-pool fix in PR #96 was specifically about Windows vs prod behavior. CI on Ubuntu matches prod. No preview environment — all manual testing is against dev laptop then prod. Migrations 0001-0022 have to be hand-applied; CI doesn't exercise a full migration path. | Medium |

---

## Configuration Management Assessment

**Strengths:**
- `.env.secrets` is gitignored (`.gitignore` covers it plus `deploy/.env.secrets*` with `!.env.secrets.template` allowlist for the template).
- `deploy/.env.secrets.template` is comprehensive and annotates the source Bitwarden item name per secret.
- YAML configs (`ai-routing.yaml`, `brain-views.yaml`, `pipeline.yaml`, `notifications.yaml`, etc.) are mounted **read-only** (`./config:/app/config:ro`) in 6 services — safe from container-side mutation.
- Bitwarden Secrets Manager (`bws` CLI) is the documented secret source of truth per CLAUDE.md.

**Gaps:**
- **F1 — `scripts/load-secrets.sh` is a stub.** The file explicitly tells the user: `"NOTE: Update this script with actual Bitwarden secret IDs after initial setup."` — i.e., it has never been completed. Today, `.env.secrets` is populated by manual `bws secret get` commands copied by the operator. No automation, no drift-detection, no audit trail of which Bitwarden item produced which line in the env file.
- **Baked vs mounted configs:** Runtime YAML configs are mounted (good) but there's **no hot reload** — ConfigService loads once on startup (confirmed by grep: no `fs.watch` or `chokidar`; `ConfigService.load` is called only in `packages/core-api/src/index.ts` + `packages/workers/src/main.ts` startup paths). Changing `ai-routing.yaml` requires a container restart.
- **Mixed approach to env injection:** `docker-compose.yml` uses `env_file: .env.secrets` for secrets AND inline `environment:` for non-secret config. This is reasonable, but a few values leak from `.env` → shell → `${VAR}` interpolation in compose (e.g., `POSTGRES_PASSWORD`, `GITEA_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`). If the operator runs `docker compose up -d` from a shell without the env loaded, those interpolate to empty — no startup guard.
- **`.env` vs `.env.secrets` overlap:** `.env` lists many secret names as placeholders; the actual values live in `.env.secrets`. Two files, same key names. Risk of editing the wrong file.
- **No config-schema validation step in CI** — YAML configs are parsed at runtime only. A malformed `ai-routing.yaml` takes the container down on the next restart, not at PR review.

---

## Observability Scorecard

| Signal | Instrumented? | Alarmed? | Runbook Linked? |
|--------|--------------|----------|-----------------|
| Latency (p99) | Yes — `httpRequestDuration` histogram in core-api via prom-client (`/metrics` endpoint) | **No alert rules found** | No |
| Error rate | Yes — `httpRequestsTotal{status_code}` counter | **No alert rules** | No |
| Throughput (captures) | Yes — `capturesTotal{source}` counter | No | No |
| LLM cost | Yes — `llmCostTotal{model}` counter + `ai_audit_log` table + budget-check skill | Yes — circuit breaker in LLMGateway; skill-based | No dedicated runbook |
| Saturation (CPU/mem/disk) | Partial — `collectDefaultMetrics` exposes Node runtime metrics; no host-level node_exporter in compose | **No alerts** | No |
| Container health | Compose healthchecks on 9/11 services use `127.0.0.1` (CLAUDE.md rule enforced) | Restart via `restart: unless-stopped` | Implicit |
| Queue depth / pipeline health | Yes — BullMQ scanned by `pipeline-health` skill every 6h; pushes to Pushgateway at `pushgateway:9091` | Yes — Pushover via skill | No |
| External availability | Yes — Cloudflare Worker synthetic-monitor cron every 5min | Yes — Pushover after 2 consecutive failures | No |
| Log aggregation | Loki deployed via `scripts/deploy-loki.sh` (standalone); 30-day retention (720h) | **No log-based alerts** defined | No |

**Critical finding:** **Pushgateway is referenced but not defined anywhere** — `packages/workers/src/lib/push-metrics.ts` defaults `PUSHGATEWAY_URL` to `http://pushgateway:9091`, but no service named `pushgateway` exists in `docker-compose.yml`, nor is there a `deploy-pushgateway.sh`. The `pipeline-health` + `container-health` skills will silently log warnings and continue (it's fire-and-forget), but no one is getting those metrics unless Pushgateway is running as an undocumented standalone container that wasn't surfaced in any file I could grep.

**Critical finding:** **Zero Prometheus alert rules exist in-repo.** `grep` for `alert:`, `expr:`, `for:`, `PrometheusRule` against `config/` finds only a false positive in a prompt template. Dashboards exist (`llm-cost-performance.json`, `pipeline-health.json`, `system-overview.json`), but dashboards are not alerts — they don't wake up the operator. All proactive alerting relies on the `pipeline-health` skill (every 6 hours) plus the Pushover path, not Prometheus Alertmanager. This means: if core-api returns 500 on every request for 5 hours 55 minutes between skill runs, the only trip-wire is the Cloudflare Worker.

---

## Alert Quality Assessment

- **Alerts without runbooks:** All of them. Pushover-based alerts (skill output + synthetic monitor) fire a text message with no linked runbook. No `RUNBOOK.md`, `runbooks/`, `OPERATIONS.md`, or `ON_CALL.md` exists in the repo (`grep` returned zero hits).
- **Runbooks without alerts:** N/A — no runbooks exist.
- **Alert quality:**
  - Synthetic monitor: debounces 2 failures, distinguishes recovery. **Good.**
  - `pipeline-health` skill: documented thresholds (failed > 5 OR waiting > 100 OR stalled > 0), with a sensible 24h dedup for "capture flow stale" alerts. **Good.**
  - `container-health` skill: exists, pushes metrics.
  - Monthly maintenance: posts pass/warn/fail summary to Slack. Informational.
- **Non-actionable alerts:** The Pushover message format from synthetic monitor includes the last error, which is actionable. Skill alerts include queue name + count, also actionable. No evidence of flap-prone or low-signal alerting, but the operator receives alerts on a personal phone without any documented response playbook.

---

## Operational Readiness Assessment

Can a tier-1 on-call engineer not on the build team handle a P1? **No.** This is a single-operator system by design — the operator is the on-call — but even the operator has no written runbook to refer to after 6 months of context decay.

- **Runbooks:** **Missing.** No `RUNBOOK*`, `OPERATIONS*`, `ON_CALL*`, `INCIDENT*` files. `README.md` documents architecture and data flow well, but not "what to do when X is broken." `CLAUDE.md` captures post-hoc learnings that double as tribal runbooks, but they're rules-of-thumb, not procedures.
- **Deployment rollback:** **Undefined.** No rollback script, no image tag retention, no documented "how to revert." The only path is `git revert → build → up -d`. Mean time to rollback is bounded below by the build time (multi-stage pnpm build ≈ minutes).
- **Incident process:** **Missing.** No documented severity levels, escalation path, post-mortem template, or handoff procedure. LAB_NOTEBOOK.md is a superb design journal but not an incident log.
- **Restore procedure:** **Undefined.** Backups exist (postgres pgdump custom, Redis RDB, wiki git bundle, config). Restore has never been tested per the intake + grep-confirmed absence of any restore script or LAB_NOTEBOOK entry for restore verification.

---

## Disaster Recovery Fidelity

| Metric | Stated | Measured / Tested | Gap |
|--------|--------|-------------------|-----|
| RTO | **Not stated** in PRD, TDD, or README | Not measured | Entire metric absent |
| RPO | **Not stated** | Effectively 24h (daily backup at 03:00) based on backup cadence | Stated value missing; actual value is ≤24h for Postgres and "best-effort" for Redis (BGSAVE-at-backup-time) |
| Backup retention | 14 daily + 4 weekly + 3 monthly (per `backup.sh`) | Confirmed in script; confirmed retention logic is correct | None on definition. Operational fidelity untested. |
| Backup restore | Untested | Untested | **Entire restore path is unvalidated** — no `restore.sh`, no staging restore drill, no LAB_NOTEBOOK entry claiming a successful restore. |
| Backup location | `/mnt/user/backup/openbrain/` on homeserver (same box as prod) | Confirmed | **No offsite copy.** Single-disk/array failure on homeserver loses both prod data and backups. |
| Wiki backup | Git bundle from live container | Confirmed — depends on core-api/workers container having cloned the wiki | Failure mode if neither container has the clone: wiki skipped (warning, non-fatal) |
| Redis backup | BGSAVE + docker cp dump.rdb | Confirmed — 60s timeout | Redis data is job-queue backing store; RPO for in-flight jobs is "whatever BullMQ replays" |

---

## Additional Findings

### F1 — `load-secrets.sh` is a stub, not a functioning loader (High)

`scripts/load-secrets.sh` prints "NOTE: Update this script with actual Bitwarden secret IDs after initial setup." and exits. The real secret-loading happens manually by the operator running `bws secret get <id> | jq -r .value` and pasting into `.env.secrets`. This means:
- No reproducible bootstrap for a fresh host
- No drift detection between Bitwarden-vaulted truth and `.env.secrets` on disk
- Onboarding / DR recovery requires manual Bitwarden-ID reconciliation

**Recommendation:** Either complete the script (finish the `bws secret get <id>` loop against a known list of Bitwarden IDs produced by `bws secret list`) or explicitly delete the stub and document the manual process in a `RUNBOOK-secrets.md`.

### F2 — Web build status in CI is ambiguous (Medium)

CLAUDE.md claims "Web build re-enabled in CI — `pnpm --filter @open-brain/web build` runs after `web-test` job (verified 9.24s build time)" (MEMORY.md 2026-04-17 Phase 5 entry). But the on-disk `.github/workflows/ci.yml` on this branch has **no `web-test` job and no `pnpm --filter @open-brain/web build` invocation** — the CI file only has `build-and-test`, `sidecar-test`, `python-lint` jobs, and the "build remaining packages" step is `pnpm --filter !@open-brain/shared -r build` which would include `@open-brain/web`. Whether `@open-brain/web`'s tsup/vite build is actually exercised depends on whether it has a `build` script that invokes `vite build`. This is recoverable but worth confirming — the CLAUDE.md entry may describe a later unmerged state.

### F3 — No image registry, no image tagging, no rollback path (High)

`docker-compose.yml` uses `build: { context: ., target: core-api }` (and similar for workers/slack-bot/voice-capture/web/voice-pipecat/file-ingestion/financial-ingest/utility-ingest). Zero `image:` directives on buildable services — images exist only transiently on the host. No retention of the N-1 image means rollback requires a git revert and rebuild from scratch. For a single-user system this is acceptable but only if the operator accepts the exposure.

**Recommendation:** Add `image: open-brain-core-api:${GIT_SHA:-latest}` (and analogous for each service) to compose, have the deploy shell command set `GIT_SHA=$(git rev-parse --short HEAD)` before `docker compose build`. Gives you one trivially available previous image tag.

### F4 — Compose lacks security hardening defaults (Low)

No `security_opt: [no-new-privileges:true]`, no `cap_drop: [ALL]`, no `user:` directive on any service. All containers run as root. Given single-user / air-gapped-ish deployment via Cloudflare Tunnel (no inbound port exposure from LAN except Tailscale), this is low-risk, but it's worth documenting that the decision is intentional.

### F5 — Docker log driver is default `json-file` — Loki ingestion path unclear (Medium)

`deploy-loki.sh` installs the Loki Docker log driver plugin but only **prints instructions** for the operator to manually add `logging:` blocks to compose. No `logging:` blocks exist in `docker-compose.yml` today, and there's no `/etc/docker/daemon.json` change documented. So Loki is running, has 30-day retention, but **may not be receiving logs from Open Brain containers**. Grafana Explore against Loki would show empty streams.

**Recommendation:** Either add per-service `logging:` blocks to compose, or flip the host's default log driver to loki in `/etc/docker/daemon.json` and document it in the deployment guide. Verify ingestion via `docker logs loki` or Grafana Explore.

### F6 — No mem_limit on core-api, workers, slack-bot, web, cloudflared, postgres, redis (Medium)

Per CLAUDE.md, the machine has a "1.5 GB RSS per process" ceiling. Only 4 services declare `mem_limit`: `voice-pipecat: 4g`, `file-ingestion: 1536m`, `faster-whisper: 8g`, commented-out `ollama: 16g`. Core-api, workers, slack-bot, web, postgres, redis, voice-capture, cloudflared, financial-ingest, utility-ingest have **no declared memory ceiling**. This means a workers memory leak could OOM-kill the whole homeserver rather than just the workers container.

Per intake: Postgres 8GB and faster-whisper 8GB "documented" — but only faster-whisper actually has `mem_limit: 8g` in compose. Postgres has none.

### F7 — `depends_on` on `financial-ingest` / `utility-ingest` lacks `condition`, breaks startup order (Low)

Both sidecar services declare `depends_on: - core-api: condition: service_healthy` — correct. But the sidecars themselves have no `healthcheck:` block despite having a `trigger_server.py` (referenced in `deploy/cron/unraid-ingest.cron`) that serves HTTP. The `docker-compose.test.yml` test counterpart correctly has `healthcheck: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/healthz"]` — production compose has none. Mismatch.

### F8 — No staging / preview environment (Medium)

PRs merge to main and then humans deploy to prod. There's no intermediate environment to validate a deploy end-to-end (including migration application) before the production homeserver bounce. CLAUDE.md shows several operational learnings where prod was the discovery surface (trigger idempotency, punycode warnings, Ollama IP changes, etc.). A staging docker compose on the same host with an alternate network namespace would catch most of these.

### F9 — `docker-compose.override.yml` referenced in docs but absent from repo (Low / documentation)

`scripts/backup.sh` line 85: `cp "${APP_DIR}/docker-compose.override.yml" "$CONFIG_DIR/" 2>/dev/null || true`. The file doesn't exist in git. The `|| true` suppresses the failure, so backups still succeed, but the operator may not realise an intended override file isn't present. CLAUDE.md has an operational rule about override file behavior ("Docker Compose `ports` lists are appended, not replaced in override files") suggesting an override existed at some point.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 6 |
| Low | 3 |

**High:**
- F3 — No image registry / no rollback path
- F1 — `load-secrets.sh` stub
- IaC coverage gap — observability stack + Ollama + Gitea outside compose (catalogued in Infrastructure-as-Code Audit "Coverage" + "State drift risk" rows)

**Medium:**
- F2 — Web build CI ambiguity
- F5 — Loki log driver not wired to containers
- F6 — Missing mem_limits on 6+ services
- F8 — No staging environment
- Runtime config hot reload absent (documented under Configuration Management)
- Pushgateway referenced but not declared (documented under Observability)

**Low:**
- F4 — No security_opt / cap_drop defaults
- F7 — Sidecar healthcheck missing in prod compose
- F9 — Dangling override file reference in backup.sh

**Not classified as findings but worth surfacing:**
- Zero Prometheus alert rules. Dashboards exist without alerting — this is a gap but not a finding because the `pipeline-health` skill + synthetic monitor cover the primary availability path. Promoting skill alerts to Prometheus AlertManager with proper silence windows and runbook URLs would tighten this.
- No documented RTO/RPO. For a single-user personal system it may be acceptable, but stating the intended values in README/PRD would make the backup/restore strategy evaluable.
