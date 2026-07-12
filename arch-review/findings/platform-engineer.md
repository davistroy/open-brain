# Platform Engineer Findings

**Reviewer:** Platform Engineer
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

**Review generation:** v5 — supersedes 2026-07-09 v4 (preserved at `open-brain-backups/arch-review-v4-20260709/`). Read-only code/doc review; no SSH to homeserver — live-host items tagged **[requires investigation]**. Only code merged since v4 is the Dependabot remediation (PRs #232–#234: lockfile refreshes, nodemailer 8→9, vitest 2→3, core-api dead-code/coverage backfill) plus `cd14c1f` (.github/dependabot.yml). None of it touches runbooks, compose, CI gating, alert rules, or backup scripts — so the v4 platform findings were expected to persist, and verification confirms they all do.

---

## Prior-Review Adjudication (v4 → v5)

Every v4 finding was re-verified against the current working tree. **All 18 are STILL OPEN.** One (PE-L4) is CHANGED — escalated Low→Medium on new evidence. Verdicts with evidence:

| v4 ID | Verdict | Evidence (current state, 2026-07-12) |
|-------|---------|--------------------------------------|
| **PE-C1 (Critical)** — deploy.md §5 rollback truncates then deletes the postgres/redis raw-bind override; §8 falsely claims `postgres_data` named volume holds the live DB | **STILL OPEN — verbatim** | `docs/runbooks/deploy.md:192` still `cat > /mnt/user/appdata/open-brain/docker-compose.override.yml <<'EOF'`; `:205` still `rm /mnt/user/appdata/open-brain/docker-compose.override.yml`; `:267` still "The `postgres_data` Docker volume holds the live DB." File last committed `8b3d0de` (pre-ADR-0004); `git log --since=2026-07-09` shows zero runbook commits. **New evidence of severity:** LAB_NOTEBOOK Entry 183 (`:12666`) explicitly *prohibits* deploy.md §5 verbatim during the 2026-07-12 production deploy and substitutes a sha-tag re-pull procedure — the runbook is operationally acknowledged as dangerous, the safe procedure is institutionalized in the lab notebook instead of the runbook being fixed, and the Critical remains open 3 days after being a v4 go-condition (A134). |
| **PE-H1** — deploy.md/observability.md contradict post-ADR-0004 reality (retired observability profile documented as live; §4 migration runs `migrate-manual.sh` on a host with no psql; config-diff gate + `--remove-orphans` prohibition absent from runbook; observability.md two generations stale) | **STILL OPEN — verbatim** | deploy.md §7 (`:235-259`) still documents the in-repo `observability` compose profile; inventory (`:27-30`) still lists the 4 GPL containers deleted from compose 2026-07-01; §4 (`:160-163`) still runs `bash scripts/migrate-manual.sh` directly on the Unraid host (no psql — Entry 175); config-diff gate and `--remove-orphans` prohibition remain CLAUDE.md/LAB_NOTEBOOK-only; observability.md untouched since `dc05538`. |
| **PE-H2** — alert-rule/dashboard ownership + delivery path ambiguous post-ADR-0004; dead-workers detection (`WorkersMetricsAbsent`/`PushgatewayStale`) delivery unproven | **STILL OPEN [requires investigation]** | `config/prometheus/alerts/` (7 files), `config/prometheus/prometheus.yml`, `config/loki/`, Grafana dashboards all still in-repo; zero compose mounts (`grep "config/prometheus\|config/grafana\|config/loki" docker-compose*.yml` → nothing). No sync mechanism or ownership statement added. Shared-stack Alertmanager delivery still unverifiable from this repo. |
| **PE-H3** — 3 SLO alerts annotate `docs/runbooks/slo-alert.md`, which doesn't exist | **STILL OPEN — verbatim** | `ls docs/runbooks/slo-alert.md` → no such file; `config/prometheus/alerts/slo.yml:79,102,124` still reference it. |
| **PE-H4** — no dead-man's switch on backup chain; A131 (first scheduled offsite/rehearsal runs never verified in logs) open since 2026-06-11 | **STILL OPEN [requires investigation]** | No freshness gauge/heartbeat added (`backup.sh`, `offsite-backup.sh`, pipeline-health skill unchanged since v4); no A131 closure evidence in LAB_NOTEBOOK/OPEN_ITEMS. Needs live-host log verification. |
| **PE-M1** — proven deploy sequence unscripted (config-diff gate, migration-via-container, D131 sed, post-up network reconnect) | **STILL OPEN** | `scripts/` contains only `post-compose-up.sh`; no `deploy.sh`. Entry 183's deploy again executed the sequence as manual prose steps. |
| **PE-M2** — CF workers (email-worker, synthetic-monitor) outside CI/CD entirely | **STILL OPEN — exposure increased** | `ci.yml` job list unchanged (no worker typecheck job). New wrinkle: Dependabot now churns these packages (PR #232 already merged audit fixes; open #235/#237/#238 incl. `@cloudflare/workers-types` 4→5 majors) with **zero CI validation** — breakage surfaces only at the next manual `wrangler deploy`. |
| **PE-M3** — container-health probes dead `litellm:4000`, skips faster-whisper/web-next; stale comments | **STILL OPEN [requires investigation]** | `packages/workers/src/skills/container-health.ts:53-61` unchanged: `litellm` endpoint present, `faster-whisper` absent, comment still references the deleted Vite `web` package. |
| **PE-M4** — wholesale `env_file: .env.secrets` into 7 services | **STILL OPEN** | 7 `env_file` blocks in docker-compose.yml (lines 99, 153, 216, 251, 357, 466, 507). |
| **PE-M5** — no end-to-end bare-metal/chassis-loss recovery runbook; RTO unstated/untested | **STILL OPEN** | No such runbook in `docs/runbooks/` (12 files, unchanged); no RTO statement in SLO.md/TDD. |
| **PE-M6** — workers coverage gate dormant (`test` lacks `--coverage`); scheduler/dispatch at 0% | **STILL OPEN** | `packages/workers/package.json:17` = `"test": "vitest run --passWithNoTests"`. Note: PR #234 bumped workers to vitest 3 / @vitest/coverage-v8 ^3 — the same bump that shifted core-api's measured baseline — so when the gate is enabled, the measured figure may differ from v4's 74.02%. (CLAUDE.md's "`@vitest/coverage-v8@^2.0.0` in both packages" is now stale — trivial doc drift, fold into the fix.) |
| **PE-M7** — doc-sync CI observe-mode, version-strings only; structurally can't catch PE-C1-class runbook drift | **STILL OPEN** | `ci.yml:227-235`: doc-sync still `continue-on-error: true`. |
| **PE-M8** — `validate-alert-rules.sh` not wired into CI | **STILL OPEN** | No CI job references it; with no local Prometheus loading the rule files, a broken rule fails with zero signal anywhere. |
| **PE-L1** — .env.example gaps/staleness | **STILL OPEN** | Still no `LOKI_URL`/`STAGING_DIR`/`GITEA_TOKEN`/`CLOUDFLARE_TUNNEL_TOKEN`; still `AI_EMBEDDING_MODEL=spark-qwen3-embedding-4b` + "configured on llm.k4jda.net" (`:47,53`). |
| **PE-L2** — stale operational comments in live ops code | **STILL OPEN** | `scripts/post-compose-up.sh:11-12` still documents the retired P12 in-repo observability profile; container-health.ts comment as above. |
| **PE-L3** — `/health` live OpenAI call + fresh pool per invocation, hit every 30s by Docker healthcheck | **STILL OPEN** | Health-service code untouched since v4 (PR #234 touched only `schemas/index.ts`, `services/index.ts`, `services/sse.ts`). |
| **PE-L4** — `build-images.yml` publish ungated on CI success | **CHANGED — escalated Low → Medium (renumbered PE-M9)** | Trigger unchanged (`on: push: branches: [main]`, no `workflow_run` gate, no failure alerting). New evidence raises likelihood and adds a failure mode — see PE-M9 below. |
| **PE-L5** — decayed web-rollback.md; `._*` not gitignored; OPEN_ITEMS.md stale on A132 | **STILL OPEN** | web-rollback.md unchanged (still referenced from deploy.md:210/:286); `.gitignore:55` has `.DS_Store` only, no `._*` (AppleDouble junk untracked in 3 dirs); `OPEN_ITEMS.md:13` still says "Waves 3–4 … remain" (deployed 2026-06-30). |

**Net-new this cycle:** PE-M9 (escalation of PE-L4) and PE-L6 (Dependabot ecosystem coverage gap). Details below.

---

## Pipeline Map

Unchanged from v4 except the two flagged rows. Deliberately no CD (single operator, homeserver).

| Stage | Tool/Mechanism | Manual Step? | Gate Exists? |
|-------|---------------|--------------|--------------|
| Commit → PR | git + GitHub | — | Branch protection on main |
| PR validation | `ci.yml`: build+lint+unit, 3 pytest jobs, python-lint, two-DB schema parity, real-DB integration (core-api + workers), secrets guards | No | Yes — required: `Integration tests (core-api + real DB)` + `build-and-test` |
| **Dependency updates (NEW since v4)** | `.github/dependabot.yml` (cd14c1f): weekly grouped minor/patch, individual majors; npm root + 2 CF workers + github-actions | Merge is manual | PR CI applies — **but CF-worker dep PRs get zero CI (PE-M2), and github-actions PRs touching build-images.yml get zero pre-merge execution (PE-M9)** |
| Doc-version sync | ci.yml doc-sync | No | **No — observe mode**, version strings only (PE-M7) |
| Image build/publish | build-images.yml → GHCR, 8 images, `:latest` + `:sha-*` | No | **No gate on CI green; no failure alerting** (PE-M9) |
| Schema migration | `scripts/migrate-manual.sh` (ledgered, ON_ERROR_STOP, --status/--baseline) | **Yes — manual, ordering-critical; the runbook's migration step is non-executable on the prod host (PE-H1)** | Ledger + CI parity diff |
| Compose config change | Two `docker compose config --format json` diffs | **Yes — manual prose, CLAUDE.md-only, absent from deploy.md (PE-H1)** | Human diff review |
| Deploy | SSH root → git pull → compose pull → `up -d --force-recreate --no-deps <svcs>` | **Yes — fully manual** (Entry 183: executed cleanly with digest-verified rollback anchors + 10-min health watch — a discipline that exists only in LAB_NOTEBOOK, not deploy.md) | Manual curls + manual health watch |
| Post-deploy network fixup | `scripts/post-compose-up.sh` (reconnect ollama + Gitea) | **Yes — forgettable; wiki-ingest/ollama tier break silently if skipped** | None |
| CF workers deploy | `wrangler deploy` per package | **Yes — manual, no CI** (PE-M2) | wrangler typecheck-on-deploy only |
| Host crons (backup/offsite/rehearsal/ingest) | Unraid `/boot/config/plugins/dynamix/custom.cron` | **Yes — manual root install** | None; no absence detection (PE-H4) |
| Rollback | `:sha-*` pin via override file | **Yes — documented procedure remains destructive (PE-C1); the safe procedure lives only in Entry 183** | None |

## Deployment Strategy Assessment

- **Strategy identified:** recreate (surgical per-service `--force-recreate --no-deps`), `:latest` pull-based, single environment (no staging).
- **Fit for risk tolerance:** Partial. Appropriate for a single-user homeserver. Entry 183 demonstrates the *practiced* procedure is now genuinely strong — pre-deploy GHCR manifest-digest-verified rollback anchors (which caught a wrong timestamp-inferred slack-bot tag), 10-minute crash-loop watch, explicit prohibitions on bare `up -d` / `--remove-orphans` / deploy.md §5.
- **Core concern this cycle:** the gap between practiced and documented procedure has **widened**. The best deploy/rollback procedure in the system's history is recorded in a lab-notebook entry; the runbook a non-builder operator would reach for still contains the empty-DB landmine (PE-C1) and four non-executable/misleading sections (PE-H1). Fixing deploy.md is a ~1-hour documentation task that has now outlived two review cycles and one production deploy that explicitly routed around it.

## Infrastructure-as-Code Audit

| Dimension | Finding | Severity |
|-----------|---------|----------|
| Coverage (declared vs manual) | Unchanged from v4: compose declares all 13 services with healthchecks, limits, restart policies, Loki logging. Out-of-band: ollama+Gitea (D31, manual reconnect after every `up`), Unraid crons (reference files exist), CF workers, Loki plugin, GHCR auth, rclone crypt remote, host override (contents only in ADR-0004 prose) | Medium (PE-M1, PE-M5) |
| Idempotency | Strong — ledgered migrations, generated init-schema + CI parity diff, idempotent compose, cron files with install/rollback/verify | — |
| State drift risk | Landmine still disarmed only by the gitignored host-only override, and the repo's rollback runbook still destroys it (PE-C1). Alert rules/dashboards remain dual-source vs the shared observability project with no sync mechanism (PE-H2) | Critical / High |
| Environment parity | Unchanged — 2 documented prod deviations (override binds, core-api 0.0.0.0 sed); test compose is postgres+redis+sidecar only (QA-M3 standing deferral); enforced by operator discipline only | Low |

## Configuration Management Assessment

Unchanged from v4. Secrets policy remains exemplary: Bitwarden-only, `deploy/.env.secrets.template` inventory, `load-secrets.sh`/`verify-secrets.sh` with SHA sidecar + Pushover drift alert, 3-step lockstep rule, CI-enforced redaction/roundtrip guards; no live secrets in-repo; `.gitignore` covers `.env*`. Open: **PE-M4** (wholesale `env_file: .env.secrets` into 7 services — every container gets every secret; fix with per-service env fragments), **PE-L1** (.env.example incomplete + describes the retired llm.k4jda.net/spark-embedding architecture). Fail-closed patterns (`:?` guards on POSTGRES/REDIS passwords, NODE_ENV fail-closed, require-core-api-url) intact.

## Observability Scorecard

Unchanged from v4 — no observability code/config changed since. Condensed:

| Signal | Instrumented? | Alarmed? | Runbook Linked? |
|--------|--------------|----------|-----------------|
| Latency (p99) | Yes — histograms + recording rules | Rules only; delivery unproven (PE-H2) | **No — slo-alert.md missing (PE-H3)** |
| Error rate | Status labels exist; **no 5xx-rate rule** — a sustained 500 storm below the latency SLO is signal-free outside logs | No | No |
| Throughput | Yes — captures counter + capture-flow proxy | Yes (CaptureFlowStale + pipeline-health Pushover 6h) | Yes — capture-flow-alert.md |
| Saturation | Partial — core-api process metrics only; no disk-space alert for backup target/pgdata in this repo | No (in this repo) | No |
| Health check | Yes — Docker healthchecks 11/13, `/health` per-dependency, container-health skill q15m→Pushover (but skill probes dead `litellm`, skips faster-whisper — PE-M3) | Yes | Yes — container-health-alert.md |
| Dependency health | Yes — postgres/redis/LLM checks, budget + Composio gauges, queue gauges | Yes | Yes |
| External availability | Yes — CF synthetic monitor, 5-min cron, Pushover + recovery | Yes | Partial (monitor's own deploy manual, unwatched — PE-M2) |
| Logging | Strong — pino JSON + Loki driver (accepted drop-on-unreachable mode) | — | observability.md stale (PE-H1) |
| Distributed tracing | None — acceptable for single-host single-user | — | — |

## Alert Quality Assessment

All v4 items persist unchanged:
- **PE-H3:** `ApiP99LatencySLOBreach`/`SearchP99LatencySLOBreach`/`McpP99LatencySLOBreach` still annotate the nonexistent `docs/runbooks/slo-alert.md` (slo.yml:79/102/124). Every other alert links 1:1 to a real runbook.
- **PE-H2 [requires investigation]:** the 7 rule files + dashboards are consumed by nothing in this repo post-ADR-0004; ownership/sync with the shared observability project undeclared; whether `WorkersMetricsAbsent`/`PushgatewayStale` — the only detectors of a dead workers container, itself the app-layer Pushover engine — actually deliver a notification remains unverifiable here. Failure scenario stands: workers dies → all Pushover alerting goes dark → only watchers are rules whose delivery path is unproven.
- No error-rate alert; SLO rules dashboard-only per their own comments.
- **PE-M8:** `scripts/validate-alert-rules.sh` still not in any CI job.

## Operational Readiness Assessment

Can a tier-1 on-call engineer (not the builder) handle a P1? **Partially — and the deploy/rollback documents would still actively mislead them.** This is now demonstrated rather than hypothetical: the builder prohibited his own runbook's §5 during the 2026-07-12 production deploy (Entry 183 :12666).

- **Runbooks:** Partial. 12 runbooks; alert runbooks remain genuinely good (exit-code diagnosis, exact commands). deploy.md dangerous (PE-C1) + stale in 4 ways (PE-H1); observability.md two generations stale; slo-alert.md missing (PE-H3); no chassis-loss composition runbook (PE-M5); web-rollback.md decayed (PE-L5).
- **Deployment rollback:** Manual; documented-but-unsafe-as-written. The practiced rollback (sha-tag re-pull + digest anchors) is sound but exists only in LAB_NOTEBOOK.
- **Incident process:** Partial — per-alert runbooks; no overall on-call doc (acceptable single-operator).
- **PE-M9 (Medium — escalated from v4 PE-L4) — ungated image publish now has a live trigger path and an unalerted failure mode.** `build-images.yml` runs only on push to main, with no dependency on CI success and no failure notification. Two scenarios: (a) admin direct-push (`enforce_admins=false`) publishes untested `:latest` images silently picked up by the next `docker compose pull` — v4 scenario, unchanged. (b) **New:** five Dependabot GH Actions **major** PRs are open (#236 setup-node 5→6, #239 pnpm/action-setup 4→6, #240 setup-python 5→6, #241 cache 5→6, #242 docker/build-push-action 6→7). #242 modifies all 11 `docker/build-push-action@v6` steps in build-images.yml — a workflow with **zero PR-time execution** (push-trigger only, and required checks don't cover it). If a merged actions major breaks the publish workflow, it fails post-merge with no alert; `:latest` goes silently stale; the next `docker compose pull` "succeeds" and redeploys old code with no signal — deploy.md §2/§3 verify tag *strings*, not digests (the digest check is Entry 183 lab practice only). Fix: gate publish on CI via `workflow_run`, add a failure notification (Pushover step), fold Entry 183's digest verification into deploy.md §3, and treat #239/#236/#242 as deploy-pipeline changes requiring a post-merge build-images run check.
- **PE-M1/M2/M7** persist as adjudicated: proven deploy sequence unscripted; CF workers outside CI (now with unvalidated Dependabot churn); doc-sync observe-mode structurally blind to the drift class that produced PE-C1.

## Disaster Recovery Fidelity

Unchanged from v4:

| Metric | Stated | Measured/Tested | Gap |
|--------|--------|-----------------|-----|
| RPO | Not formally stated; effective 24h design (03:00 backup, 03:45 encrypted offsite, 30-day retention) | Weekly rehearsal row-counts (exact COUNT(*) per D128, ±10%); offsite canary verified once at install (2026-06-11) | **A131 still open — first scheduled offsite/rehearsal runs never confirmed in logs, ~13 months since install (PE-H4)**; no formal RPO statement to test against |
| RTO | **Not stated anywhere** | DB-restore proven weekly into ephemeral container; full-host recovery never rehearsed | Unbounded/unknown RTO for chassis loss (PE-M5) |

- **PE-H4 [requires investigation]:** no dead-man's switch added — all backup-chain alerting remains push-on-failure from the scripts. Lost cron entries (Unraid flash persistence quirk) or unreadable `.env.secrets` in cron context (`. ./.env.secrets 2>/dev/null` swallows the error) stops backups with zero signal. Fix unchanged from v4: verify logs now; add a freshness assertion (pipeline-health checks `latest/manifest.json` mtime < 26h, or `openbrain_backup_age_seconds` gauge + rule, or healthchecks.io-style ping).
- **PE-M5:** full rebuild still requires ~8 manual steps scattered across five documents (secrets rebuild, override recreation from ADR-0004 prose, cron reinstall, GHCR login, Loki plugin + daemon restart, rclone remote, network reconnect, tunnel state); composition never written down or rehearsed.
- Strong points stand: automated weekly restore rehearsal with row-count validation, copy-not-sync offsite (ransomware-deletion isolation), documented crypt-key custody, CI-enforced backup secrets redaction.

## Net-new Low finding

- **PE-L6 (Low) — Dependabot ecosystem coverage gap.** `dependabot.yml` covers npm (root + 2 CF workers) and github-actions only. Not covered: **pip** (root `pyproject.toml`; `packages/voice-pipecat/requirements.txt` + `pyproject.toml`; `packages/file-ingestion/requirements.txt`; `docker/ingest-sidecar/tests/requirements.txt`; 3 `scripts/requirements-*.txt`) and **docker** (6 Dockerfiles' base images). The Python sidecars are invisible to the very alerting layer that PRs #232–#234 just remediated for npm, and the Phase 9.5 explicit third-party pins (redis 7.4-alpine, cloudflared 2025.6.1, etc.) will age silently — the exact recurrence pattern the config's own header comment says it exists to prevent. Add `pip` + `docker` ecosystem blocks; compose-file pins additionally need a periodic manual review note (Dependabot does not parse compose).

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 4 |
| Medium | 9 |
| Low | 5 |
| **Total** | **19** |

3 findings tagged [requires investigation] (PE-H2, PE-H4, PE-M3) — need live-host / shared-stack verification unavailable to this read-only review.

**Critical:** PE-C1 (deploy.md §5 rollback clobbers-then-deletes the postgres/redis raw-bind override → re-arms the empty-DB landmine; §8 false `postgres_data` claim; explicitly routed-around in production per Entry 183 yet still unfixed — second consecutive review cycle as the domain's sole Critical).
**High:** PE-H1 (deploy/observability runbooks contradict post-ADR-0004 reality, incl. a migration step non-executable on the prod host), PE-H2 (alert rule/dashboard ownership + delivery path ambiguous; dead-workers detection delivery unproven), PE-H3 (3 SLO alerts → nonexistent slo-alert.md), PE-H4 (no backup dead-man's switch; A131 unverified since 2026-06-11).
**Medium:** PE-M1 (proven deploy sequence unscripted incl. post-up network fixup), PE-M2 (CF workers outside CI/CD, now receiving unvalidated Dependabot churn), PE-M3 (container-health probes dead litellm, skips faster-whisper), PE-M4 (wholesale secret injection into 7 services), PE-M5 (no bare-metal recovery runbook; RTO unstated/untested), PE-M6 (workers coverage gate dormant; vitest-3 baseline shift pending), PE-M7 (doc-sync observe-mode can't catch runbook drift), PE-M8 (validate-alert-rules.sh not in CI), PE-M9 (image publish ungated on CI + unalerted on failure; escalated by 5 pending GH Actions major PRs incl. docker/build-push-action 6→7 with zero PR-time execution; silent-stale-`:latest` deploy scenario).
**Low:** PE-L1 (.env.example gaps/stale), PE-L2 (stale comments in ops scripts), PE-L3 (health-check external-call cost), PE-L5 (decayed web-rollback.md; `._*` gitignore; OPEN_ITEMS.md stale), PE-L6 (Dependabot omits pip + docker ecosystems).
