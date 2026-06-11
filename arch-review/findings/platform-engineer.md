# Platform Engineer Findings

**Reviewer:** Platform Engineer
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

Static review of CI workflows, docker-compose stack (17 services), Dockerfiles, Prometheus/Grafana/Loki configuration, all 10 runbooks, backup/restore/secrets scripts, and cron installs. No live system was touched; homeserver runtime state (cron installs, GHCR package contents, compose version behavior) is flagged as requires-investigation where it matters.

Known issues from the intake (init-schema drift 0012/0028/0030, A130, accepted baselines) were verified and are **not** re-reported. Prior-review remediations (P04a/P04b/P08 secrets round-trip, P11/P12 observability-as-code, P16 rehearsal script, P17 GHCR image pipeline) are confirmed present in the repo and are genuinely strong for a single-operator system.

---

## Pipeline Map

| Stage | Tool/Mechanism | Manual Step? | Gate Exists? |
|-------|---------------|--------------|--------------|
| Commit → CI | GitHub Actions `ci.yml` (build, lint, unit, 3× Python suites, schema validator, integration vs real DB) | No | Yes — but only "Integration tests (core-api + real DB)" is branch-protection-required |
| Merge → image build | `build-images.yml` → GHCR, tags `latest` + `sha-<7>` | No | No post-build verification (no smoke test of built images) |
| **web-next image** | **Not built by any workflow** | **Yes — out-of-band manual build/push** | **No** |
| Migration apply | SSH + `psql < packages/shared/drizzle/0NNN_*.sql` (deploy.md §6) | Yes | Manual `\dt` verification only |
| Deploy to homeserver | SSH + `git pull` + `docker compose pull` + `up -d --remove-orphans` (deploy.md §2) | Yes — entirely manual | Manual `docker compose ps` + curl health check |
| Post-deploy network fixup | `scripts/post-compose-up.sh` (reconnect ollama + Gitea) | Yes — and **not referenced in deploy.md** | No |
| Post-deploy cache | Manual PWA cache clear (deploy.md §7) | Yes | No |
| Rollback | Compose override pinning `sha-` tag (deploy.md §4) | Yes — manual edit + pull + up | No automated rollback trigger |
| Observability stack | `docker compose --profile observability up -d` (separate invocation) | Yes | Healthchecks on 3 of 4 services |
| Host cron (backup, rehearsal, ingest) | Unraid `custom.cron`, installed by hand per cron-file header | Yes — one-time install, undeployable from repo alone | `crontab -l` verification documented |

## Deployment Strategy Assessment

- **Strategy identified:** Recreate (compose `up -d` stops old containers, starts new; brief downtime per service). Single environment — no staging; main branch deploys directly to the only production host.
- **Fit for risk tolerance:** Partial. Acceptable for a single-user system with an admin escape hatch, but several gaps below undermine even that bar.
- **Specific concerns:**
  1. **(HIGH — H1) `web-next` image is not in the CI image pipeline.** `docker-compose.yml:475` expects `ghcr.io/davistroy/open-brain/web-next:latest`, but `.github/workflows/build-images.yml` builds only 7 images (core-api, workers, slack-bot, voice-capture, voice-pipecat, file-ingestion, ingest-sidecar). The production UI — the canonical ingress at brain.troy-davis.com — reaches GHCR only via manual out-of-band pushes. Every `docker compose pull` deploy either silently redeploys a stale UI or fails if the tag was never pushed. The deploy runbook's "every merge to main pushes fresh images" claim is false for the UI.
  2. **(MEDIUM — M5) Deployment is entirely manual:** SSH, git pull, image pull, restart, manual migration apply, manual PWA cache clear, manual health curl. Each is a documented reliability risk; there is no single idempotent deploy script and no automated post-deploy smoke test.
  3. **(MEDIUM — M3) `scripts/post-compose-up.sh` is a required post-deploy step (reconnects standalone `ollama` and `Gitea` containers to the compose network) but deploy.md §2 never mentions it.** Failure scenario: after a deploy that recreates the network, wiki-ingest git pushes and ollama-routed LLM calls fail until someone remembers a script the runbook doesn't reference.
  4. **(MEDIUM — M4, requires verification) `up -d --remove-orphans` vs the `observability` profile.** Deploy.md §2's command omits `--profile observability`; several docker-compose versions treat containers of non-enabled profiles as orphans and remove them — a routine deploy could tear down Loki/Prometheus/Grafana/Pushgateway. Verify the homeserver compose version's behavior; safest fix is `COMPOSE_PROFILES=observability` in `.env`.
  5. **(MEDIUM — M8) Branch protection requires only the integration-test check.** `build-and-test` (lint + 2,000+ unit tests) is non-blocking even though CLAUDE.md records A126 as resolved and the job as promotable. A lint/unit regression can merge and ship.

## Infrastructure-as-Code Audit

| Dimension | Finding | Severity |
|-----------|---------|----------|
| Coverage | High — full app + observability stack in one compose file; configs mounted `:ro`; dashboards/datasources/alerts provisioned as code. Exceptions: host cron installs, Loki driver plugin install, ollama/Gitea network attach, GHCR auth — all manual one-time host steps documented but not automated | Info |
| Image pinning | App images `:latest` (sha- tags exist for rollback — good); third-party infra images unpinned: `cloudflared:latest`, `grafana:latest`, `loki:latest`, `prometheus:latest`, `pushgateway:latest`. A breaking upstream release self-deploys on the next `compose pull` with no change in git | Medium (M7) |
| Healthcheck discipline | 127.0.0.1 rule applied on core-api/voice-capture/voice-pipecat/file-ingestion/web-next/pushgateway/prometheus/grafana. **Missing entirely on 5 services: workers, slack-bot, cloudflared, financial-ingest, utility-ingest.** workers is the most operationally critical container in the stack and Docker cannot detect its death. faster-whisper healthcheck uses `localhost` (works for that image; inconsistent with the project's own rule) | Medium (M6) / Low (L4) |
| Resource limits | `mem_limit` on every service except web-next, which uses `deploy.resources.limits.memory: 512m` — honored by compose v2 but inconsistent and easy to miss in audits | Low (L2) |
| Loki logging config | All 13 app services use the loki driver with default `${LOKI_URL:-http://loki:3100/loki/api/v1/push}`. **The loki log driver runs in the Docker daemon/plugin context and cannot resolve compose-network DNS names — `loki:3100` is unreachable from the driver.** Production works only because `.env` sets `LOKI_URL` to a host-reachable address. Worse, `docs/runbooks/observability.md` Step 6 explicitly instructs the operator to switch `LOKI_URL` to `http://loki:3100/...` "once Loki is in compose" — following the runbook silently drops all container logs (driver retries 3× then drops; containers stay green) | **High (H3)** |
| Restart policies | `restart: unless-stopped` everywhere — good | Pass |
| No-auto-migration policy | Deliberate and documented (deploy.md §6, restore-rehearsal.md). Residual risk: human-executed multi-file `psql` loop after volume recreation; `validate-schema` CI job runs only when schema files change, so init-schema drift (known: 0012/0028/0030) persists silently between schema PRs | Known issue — not re-counted |
| Test infra | `docker-compose.test.yml` is clean: tmpfs Postgres, non-conflicting ports, healthchecked, CI tears down with `down -v` in `if: always()` | Pass |

## Configuration Management Assessment

Strong overall — one of the best-engineered parts of the system:

- Secrets: Bitwarden-only with `deploy/.env.secrets.template` (operator inventory), `scripts/lib/secrets-map.sh` (machine map), `load-secrets.sh` (atomic 0600 write + SHA256 sidecar + `--force` clobber guard), `verify-secrets.sh` (drift audit), Pushover on hash drift, and a 5-case regression fixture. The 3-step lockstep rule is documented. No `.env.secrets` or live credentials found in the repo; `.env.example` contains placeholders only.
- Config YAMLs mounted read-only into containers; Grafana provisioning structure matches the post-Entry-162 fix (`provisioning/dashboards/dashboards.yaml` present).
- **(LOW — L1) Fail-open defaults:** `POSTGRES_PASSWORD:-openbrain_dev` and `GF_SECURITY_ADMIN_PASSWORD:-admin` in compose. If `.env.secrets` is missing the variable (e.g., a botched secrets-map step), the stack silently comes up with known-weak credentials instead of failing. Grafana 3050, Postgres 5432, Redis 6380, Pushgateway 9091, Prometheus 9090, Loki 3100 are all published to the LAN.
- **(LOW — L3) Pushgateway 9091 is unauthenticated and LAN-exposed** — anything on the home network can push bogus `openbrain_container_healthy 1` metrics, which would mask real failures given the alerting design below.

## Observability Scorecard

| Signal | Instrumented? | Alarmed? | Runbook Linked? |
|--------|--------------|----------|-----------------|
| Latency (p99) | Partial (core-api /metrics; no per-route p99 alert rule found) | No | No |
| Error rate | Partial (queue failed jobs via Pushgateway) | Yes — QueueFailedJobsHigh (Grafana-annotation only) | Yes — pipeline-alert.md |
| Throughput | Yes — `openbrain_captures_total`, recording rule per-6h | Yes — CaptureFlowStale + app-level pipeline-health skill (Pushover) | Yes — capture-flow-alert.md |
| Saturation (CPU/mem/disk) | No homeserver node_exporter in scrape config (spark-node/spark-gpu are the DGX, not the homeserver). OOM detection is inferred from health-state oscillation | Partial — ContainerRestartLoop proxy only | Yes — container-health-alert.md |
| Health check | Yes — container-health skill every 15min → Pushgateway; Docker healthchecks (12 of 17 services) | Yes — ContainerDown + skill Pushover after 3 consecutive failures | Yes — container-health-alert.md |
| Dependency health | Partial — synthetic monitor (Cloudflare Worker, 5-min cron, KV failure tracking, Pushover after 2 failures) covers the full external path to core-api only. Postgres/Redis/workers have no external watcher | Yes (core-api path only) | Yes — observability.md |
| Tracing | Absent — no distributed tracing anywhere. Acceptable at this scale; cross-container debugging relies on Loki + `{container_name=...}` correlation | N/A | N/A |

## Alert Quality Assessment

Alert↔runbook linkage is exemplary: all 9 Prometheus rules carry a `runbook:` annotation pointing to a real file, and every runbook documents alert conditions, diagnosis steps, and exact commands. Two structural problems sit underneath that polish:

1. **(HIGH — H2) The workers container is a single point of alerting failure, and Pushgateway staleness masks its death.** `openbrain_container_healthy` and `openbrain_queue_*` are pushed *from workers* to Pushgateway. Pushgateway retains the last pushed value forever — if workers dies (OOM, crash loop, Redis outage), every gauge freezes at its last healthy value: `ContainerDown` never fires, `QueueDepthHigh` never fires, and all Pushover-sending skills (pipeline-health, container-health, budget-check) stop running simultaneously. There are no `absent()` rules and no push-timestamp staleness alerts (`push_time_seconds` is available from Pushgateway and unused). Concrete failure scenario: workers OOMs at 23:00; queues back up all night; the only signal is the synthetic monitor — which checks core-api, not workers — so nothing fires. workers also has no Docker healthcheck (M6), closing the last detection path.
2. **(MEDIUM — M1) No Alertmanager.** `prometheus.yml` has no `alerting:` block; Prometheus rules are explicitly "Grafana annotation visibility." The rule-file comments claim the Prometheus rules "act as a safety net if the skill misses a run" — they do not: a firing Prometheus alert notifies nobody. The actual notification fabric is application-level Pushover (inside workers — see H2) plus the external synthetic monitor. Either deploy Alertmanager with a Pushover receiver, or correct the safety-net claims and accept the documented single notification path.
3. **(LOW — L5) Runbook drift:** container-health-alert.md's monitored-endpoints table still lists `litellm` (`http://litellm:4000/health/liveliness`) — LiteLLM was retired from the stack in CS5. Verify the table against the current container-health skill target list.

Non-actionable-alert review: thresholds are sane and each rule carries diagnosis context. `CaptureFlowStale` fires unconditionally including overnight (documented as intentional — the skill applies the business-hours gate). No alert-without-runbook cases. Runbook-without-alert: deploy.md, web-rollback.md, mobile-onboarding.md are procedures, not alert responses — appropriate.

## Operational Readiness Assessment

Could a competent operator who didn't build this handle a P1? **Mostly yes** — the runbooks are unusually good (exact commands, expected outputs, exit-code tables, failure-path test procedures, rollback sections). Specific gaps:

- **Runbooks: Partial.**
  - **(MEDIUM — M2) deploy.md is stale post-Phase-8b:** §2 says "8 updated GHCR images" (workflow builds 7); §3's expected-output table lists the deleted `open-brain-web .../web:latest` and omits `web-next` and `utility-ingest`; the deep-health-check curls `http://localhost:5173/health.txt` (port and service no longer exist — web-next is on 3003 with `/dashboard`); §5 invokes `--profile local-build`, a profile that does not exist anywhere in `docker-compose.yml`, with an incorrect explanation of compose build semantics (`up` never builds without `--build` regardless of profile). An operator following the verification section verbatim would conclude a healthy deploy had failed.
  - web-rollback.md is coherent but depends on tag `pre-web-sunset-2026-05` and a cached image — reasonable, clearly scoped.
- **Deployment rollback: Manual** — sha-tag pinning via compose override, well documented; no automated trigger or canary.
- **Incident process: Partial** — per-alert runbooks exist; there is no general incident/triage index ("alert fired → which runbook") beyond the annotations, and no escalation/severity doc. Acceptable for a solo operator; the runbook annotations carry the weight.
- README/CLAUDE.md operational content is rich, but tribal-knowledge density is high — the CLAUDE.md operational rules are effectively a second runbook that a non-builder operator wouldn't know to read.

## Disaster Recovery Fidelity

The backup→strip-secrets→rehearse-restore→rebuild-secrets loop is genuinely well-engineered: nightly pg_dump (custom format) + schema + config + wiki bundle + Redis RDB + manifest with row counts; weekly ephemeral pg_restore with ±10% row-count validation and `--exit-on-error`; Pushover pass/fail; secrets redaction with a regression guard. Remaining gaps:

| Metric | Stated | Measured/Tested | Gap |
|--------|--------|-----------------|-----|
| RTO | **Not stated anywhere** (grep of docs/README/OPEN_ITEMS: zero hits) | Restore *mechanics* tested weekly (if cron installed — see RI-1); restore *time* never measured; full-stack rebuild (bare host → GHCR auth → secrets → schema → restore → compose up) never rehearsed end-to-end | Define a target (e.g., 4h) and time one full rebuild rehearsal — MEDIUM (M10) |
| RPO | **Not stated** | Daily 03:00 dump → effective RPO up to 24h (Redis RDB best-effort, wiki bundle daily). No WAL archiving | State 24h explicitly or add WAL archiving if 24h of captures is unacceptable — counted under M10 |
| Backup survivability | Implicit same-host | `BACKUP_ROOT=/mnt/user/backup/openbrain` — same Unraid array as production. No off-site/off-host copy exists in this repo (urBackup may cover it host-side — unverifiable statically) | **(HIGH — H4)** Array loss, fire, or ransomware destroys production and all backups together. One `rclone`/`restic` push of `$BACKUP_ROOT` to cloud storage closes this |
| Backup failure detection | — | backup.sh has **no failure notification**; cron logs to `/tmp/open-brain-backup.log` (RAM-backed on Unraid — lost on reboot). Sunday rehearsal exit-2 catches a missing backup, giving up to 7 days of undetected backup failure | **(MEDIUM — M9)** Add Pushover-on-failure to backup.sh (pushover-notify.sh already exists) and move the log off /tmp |
| Rehearsal actually running | Sunday 05:30 cron | **Requires investigation (RI-1):** project memory records the P16 homeserver cron install as deferred; the repo contains only the cron file + install instructions. If never installed, the entire "tested weekly" DR claim is void and the High-priority failure alert path has never fired | Verify `crontab -l \| grep restore-rehearsal` on homeserver |

## Requires Investigation

| ID | Item |
|----|------|
| RI-1 | Is `deploy/cron/unraid-restore-rehearsal.cron` actually installed on the homeserver? (P16 install was deferred per project memory; repo state alone cannot confirm. If absent, DR rehearsal has never run.) |
| RI-2 | Does `ghcr.io/davistroy/open-brain/web-next:latest` exist in GHCR, and how stale is it relative to main? (Determines whether H1 is "stale deploys" or "broken pulls.") Also verify homeserver compose version's `--remove-orphans` behavior toward the observability profile (M4). |

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 4 |
| Medium | 10 |
| Low | 5 |
| Requires investigation | 2 |
| **Total** | **21** |

**High:** H1 web-next image absent from CI build pipeline · H2 workers = alerting SPOF + Pushgateway staleness masks its death (no absent()/staleness rules) · H3 Loki driver default URL and observability.md Step 6 guidance cause silent total log loss · H4 backups co-located with production, no off-site copy, no stated/tested RPO.

**Medium:** M1 no Alertmanager (Prometheus alerts notify nobody) · M2 deploy.md stale (deleted `web` service, port 5173, "8 images", nonexistent `local-build` profile) · M3 post-compose-up.sh manual step missing from deploy runbook · M4 `--remove-orphans` may remove observability-profile containers · M5 fully manual deploy with no automated smoke test · M6 no healthchecks on workers/slack-bot/cloudflared/financial-ingest/utility-ingest · M7 unpinned `:latest` third-party images · M8 branch protection requires only integration-test · M9 backup failures unalerted, log on RAM-backed /tmp · M10 no stated RTO/RPO; full-rebuild RTO never measured.

**Low:** L1 fail-open default passwords (Postgres/Grafana) · L2 web-next resource-limit + heavy `/dashboard` healthcheck inconsistency · L3 unauthenticated LAN-exposed Pushgateway · L4 faster-whisper `localhost` healthcheck violates own 127.0.0.1 rule · L5 container-health runbook lists retired `litellm` endpoint.
