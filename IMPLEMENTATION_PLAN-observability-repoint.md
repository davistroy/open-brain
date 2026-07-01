# IMPLEMENTATION_PLAN — Re-point open-brain at the Shared Observability Stack (Phase 1.3)

**Generated:** 2026-07-01 via `/personal-plugin:ultra-plan`
**Source:** `1.3-open-brain-repoint-handoff.md` (observability-migration orchestrator, homeserver repo) + full live verification (homeserver `docker inspect`/`wget`/git, read-only)
**Supersedes nothing** — discrete cross-repo change, independent of the completed A132 plan (`IMPLEMENTATION_PLAN.md`)
**ADR:** `docs/adr/ADR-0004-observability-repoint.md` (**Proposed**)
**Lab notebook:** Entry 181 (investigation + plan-of-record; deploy results appended there)
**Total scope:** 3 phases (CS-B repo · CS-C deploy · CS-D verify); ~½ day; 1 PR + 1 manual surgical deploy
**Sequencing:** strict — Phase 1 (PR merged) → Phase 2 (deploy, gated) → Phase 3 (verify). The interim runtime bridge (CS-A) is **dropped** by owner decision.

---

## Goal

Stop open-brain *owning* the GPL stack; join the external `observability` compose network as a **client** so the shared Prometheus scrapes `core-api:3000/metrics` and workers push to `pushgateway:9091`. Resolves the firing `WorkersMetricsAbsent` + `open-brain-core-api` target-down alerts, and disarms the pre-existing postgres/redis volume-drift landmine in the same coherent change.

## Plan Summary

| Phase | Change Set | Effort | Depends on | Status |
|------|-----------|--------|-----------|--------|
| 1 | **CS-B** — repo topology change (external net + attach core-api/workers + delete 4 GPL services & 3 orphaned volume defs) | S (~1h) | — | PENDING (PR) |
| 2 | **CS-C** — landmine disarm (override binds) + config-diff gate + surgical `--no-deps` recreate + doc correction | M (~2h) | Phase 1 merged | PENDING (homeserver) |
| 3 | **CS-D** — verify networks/target/alert/Loki + retire 4 Exited GPL containers | S (~½h) | Phase 2 | PENDING (homeserver) |

**Dropped:** CS-A interim runtime bridge (owner skipped; alerts stay firing until Phase 2). If ever used, the correct command is `docker network connect --alias core-api observability open-brain-core-api` — the `--alias` is mandatory (see U-2).

---

## Pre-Plan Gates (Constraints — from CLAUDE.md + Phase 0)

| Constraint | Position | Plan compliance |
|---|---|---|
| Protect unrecoverable work (backup before mutate) | CRITICAL | Phase 2 opens with `pg_dump` + backup of appdata `docker-compose.yml`+`docker-compose.override.yml`; postgres/redis never recreated (`--no-deps`) |
| Lab notebook entry before any system-modifying action | BLOCKING | Entry 181 exists; Phase 2 results appended before/as the deploy proceeds |
| Homeserver deploy mechanics | ACTIVE | `sudo docker compose`; `.env` root-only; **no python3 on Unraid → `sed`/`awk` only**; adopt-main-compose + re-apply deviations; **never `--remove-orphans`** (profile-gated live observability stack) |
| No host-specific absolute paths in `main` (public repo) | ACTIVE | Bind paths live in the gitignored `docker-compose.override.yml`, not `main` (ADR-0004) |
| Branch protection — required checks `Integration tests` + `build-and-test`, PR-based | ACTIVE | Phase 1 via PR; **verified CI-safe** (CI never invokes `main` compose; U-3) |
| Learning capture — update CLAUDE.md + memory after non-trivial findings | ACTIVE | Phase 2 corrects the stale "postgres bind preserved by deviations" note |

---

## Phase 1 — Repo Topology Change (CS-B) · ADR-0004

> Portable `main` change. No host paths. CI-safe (U-3): CI uses `docker compose -f docker-compose.test.yml` only; no workflow runs `compose config`/`up` on `main`.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 1.1 | Declare the external `observability` network | `docker-compose.yml` (top-level `networks:`) | `observability: { external: true }` added under the existing `open-brain:` network. | PENDING |
| 1.2 | Attach core-api to `observability` | `docker-compose.yml` `core-api.networks` | `core-api.networks` = `[open-brain, observability]`. Comment: shared Prometheus scrapes `core-api:3000/metrics`. | PENDING |
| 1.3 | Attach workers to `observability` | `docker-compose.yml` `workers.networks` | `workers.networks` = `[open-brain, observability]`. Comment: workers push to `pushgateway:9091`. | PENDING |
| 1.4 | Delete the 4 GPL service blocks | `docker-compose.yml` `services:` | `loki`, `pushgateway`, `prometheus`, `grafana` service blocks removed (the `# ── Observability stack ──` section). | PENDING |
| 1.5 | Remove the 3 orphaned volume defs | `docker-compose.yml` top-level `volumes:` | `prometheus_data`, `grafana_data`, `loki_data` removed. `postgres_data`/`redis_data`/others unchanged. | PENDING |
| 1.6 | Verify non-changes | `docker-compose.yml`, review only | `x-logging` anchor unchanged (`loki-url: ${LOKI_URL:-http://localhost:3100/...}`); no `PUSHGATEWAY_URL` added (code default `pushgateway:9091` is correct — U-1); `config/{loki,prometheus,grafana}/` left in place (out of scope). | PENDING |
| 1.7 | Open PR, land CI-green | — | PR merged with required checks (`Integration tests`, `build-and-test`) green. Compose-only diff — no code/image change. | PENDING |

**DoD (runnable):**
- `git diff` shows only the 3 edits (network decl, 2 service `networks:` additions, 4 service deletions + 3 volume deletions).
- `docker compose -f docker-compose.yml config -q` **on a host where the `observability` network exists** exits 0 (local dev without the external net is expected to error — not a CI gate; U-3).
- PR required checks green.

---

## Phase 2 — Landmine Disarm + Durable Deploy (CS-C) · ADR-0004

> **Protect-unrecoverable + BLOCKING lab entry gate this phase.** postgres/redis are never recreated here (`--no-deps`), but the override reconciliation disarms the drift for all future deploys.

| # | Work item | Where | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 2.1 | Lab entry + backups | homeserver | Append the CS-C execution block to Entry 181. `pg_dump` (per CLAUDE.md pre-deploy pattern) + `cp docker-compose.yml docker-compose.yml.bak-<ts>` + `cp docker-compose.override.yml docker-compose.override.yml.bak-<ts>`. | PENDING |
| 2.2 | Disarm landmine in the override | `/mnt/user/appdata/open-brain/docker-compose.override.yml` | Add raw-bind reconciliation matching the running mounts: `postgres.volumes: [/mnt/user/appdata/open-brain/pgdata:/var/lib/postgresql/data]`; `redis.volumes: [/mnt/user/appdata/open-brain/redis-data:/data]` (merged with the existing `redis.ports`/`core-api.ports`). | PENDING |
| 2.3 | Capture pre-change config render | homeserver | `sudo docker compose config > /tmp/cfg.before` — records current merged render (postgres/redis binds, core-api port, current networks/services). | PENDING |
| 2.4 | Adopt new `main` compose + re-apply deviations | `/mnt/user/appdata/open-brain/docker-compose.yml` | `git fetch origin && git checkout origin/main -- docker-compose.yml`; re-apply the core-api `3002:3000` deviation via **`sed`** (Unraid has no python3), matching the current working state (D131). | PENDING |
| 2.5 | **CONFIG-DIFF SAFETY GATE** | homeserver | `sudo docker compose config > /tmp/cfg.after`; `diff /tmp/cfg.before /tmp/cfg.after` shows **ONLY**: core-api +`observability`, workers +`observability`, the 4 GPL services removed. **postgres/redis MUST still render as binds; core-api port unchanged.** Any other delta (esp. postgres/redis reverting to named volumes, or a duplicate `3002` publish) → **STOP**, fix the override (fallback: `sed` the base binds), re-diff. `sudo docker compose config -q` exits 0. | PENDING |
| 2.6 | Surgical recreate (no pull) | homeserver | `sudo docker compose up -d --force-recreate --no-deps core-api workers`. No `docker compose pull` (compose-only change; reuse current `:latest`). `--no-deps` keeps postgres/redis/etc. untouched. **No `--remove-orphans`.** | PENDING |
| 2.7 | Correct stale docs | `CLAUDE.md` (+ memory) | Fix the "Postgres data is a bind mount preserved by the working-tree `MM` deviations" line → the appdata compose declares a **named** volume; the bind survives only until recreate; the override now pins it. Add the config-diff-gate deploy learning. | PENDING |

**DoD (runnable):**
- `diff /tmp/cfg.before /tmp/cfg.after` → only the intended delta (asserted in 2.5).
- `sudo docker compose config -q` → exit 0.
- `docker inspect open-brain-postgres --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'` → still `bind /mnt/user/appdata/open-brain/pgdata` after deploy.
- core-api + workers containers recreated (new `Created` timestamp); postgres/redis timestamps **unchanged**.

---

## Phase 3 — Verify + Retire Vestigial (CS-D)

| # | Work item | Where | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 3.1 | Networks attached | homeserver | `docker inspect open-brain-core-api` / `open-brain-workers` → both `open-brain_open-brain` and `observability`. | PENDING |
| 3.2 | Prometheus target UP | homeserver | `wget -qO- http://127.0.0.1:9090/api/v1/targets` → `open-brain-core-api` job `"health":"up"`. | PENDING |
| 3.3 | Alert resolves | homeserver | After the next ~15-min push cycle: `wget -qO- http://127.0.0.1:9090/api/v1/alerts` → `WorkersMetricsAbsent` absent/`inactive`; `push_time_seconds{job="open-brain"}` fresh. | PENDING |
| 3.4 | Loki still receiving | Grafana/Loki | `{compose_project="open-brain"}` returns recent lines (log driver → daemon `localhost:3100` → `observability-loki`, unchanged). | PENDING |
| 3.5 | Retire vestigial GPL containers | homeserver | `docker rm open-brain-grafana open-brain-prometheus open-brain-loki open-brain-pushgateway` (already `Exited (0)`). **No `--remove-orphans`.** | PENDING |
| 3.6 | Close-out | Entry 181 / A133 / D133 | Append results to Entry 181; mark A133 DONE; flip D133 → ACTIVE; ADR-0004 → Accepted. | PENDING |

**DoD (runnable):** 3.1–3.4 commands pass; `docker ps -a | grep -E 'open-brain-(grafana|loki|prometheus|pushgateway)'` → empty after 3.5.

---

## Risk Assessment

| Risk | Mitigation | Rollback |
|---|---|---|
| Bare `up -d` detaches postgres/redis onto empty named volumes | Only ever `--force-recreate --no-deps core-api workers`; config-diff gate; override disarms the drift | Data intact at bind paths; restore prior override, recreate |
| Override merges `volumes` by *append* (both mounts at one target) rather than *replace* | **Config-diff gate (2.5) renders the merge before any `up`**; fallback = `sed` the base working-tree binds | Revert override from backup |
| core-api port duplication (base + override both publish 3002) | Config-diff + `config -q` before `up`; assert core-api port unchanged vs `cfg.before` | Revert compose from `.bak-<ts>` |
| Tempting `--remove-orphans` after GPL removal (would kill the profile-gated live observability stack) | Explicit rule everywhere; retire GPL containers by name via `docker rm` | n/a (avoided) |
| External `observability` network missing at deploy | Verified present (`docker network ls`); `config -q` fails fast if absent | n/a |

## Unknowns Register

| ID | Unknown | Severity | Affects | Resolution |
|----|---------|----------|---------|------------|
| U-1 | `PUSHGATEWAY_URL` source/default | **Resolved** | Phase 1.6 | Unset in container + absent from `.env.secrets` → code default `http://pushgateway:9091` (push-metrics.ts:74) is correct; no env change |
| U-2 | Interim bridge resolves `core-api`? | **Resolved** | (CS-A, dropped) | No — bare `docker network connect` omits the `core-api` alias; must be `--alias core-api`. Durable compose path auto-adds the alias |
| U-3 | Does `external:true` in `main` break CI? | **Resolved** | Phase 1 | No — CI uses `docker compose -f docker-compose.test.yml` exclusively; no workflow runs `compose`/`config` on `main` |
| U-4 | Compose volume-merge = replace-by-target vs append | **Med** | Phase 2.5 | Resolved by the config-diff gate **before** any `up`; fallback to base-compose `sed` |
| U-5 | Exact current core-api port stanza to replicate | Low | Phase 2.4 | Captured from `cfg.before`; asserted unchanged in the diff |
| U-6 | Other data volumes drifted (financial/utility/voice_spool/whisper) | Low | (out of scope) | Not recreated by this deploy (`--no-deps`); full all-volume audit deferred to the daemon-restart window |

## Scope Boundaries

**Covers:** the observability re-point (`main`), the postgres/redis volume-drift disarm (`override`), the safe surgical deploy, vestigial GPL container retirement, and the CLAUDE.md stale-note correction.

**Does NOT cover (recommended follow-ups):**
- Consolidating the core-api-`0.0.0.0` + redis deviations fully into `docker-compose.override.yml` (currently split across `sed` + override) — would remove the per-deploy `sed` step.
- Deleting the repo `config/{loki,prometheus,grafana}/` files (now unused; harmless).
- Pruning stale `open-brain_{prometheus,grafana,loki}_data` named volumes.
- Full data-volume drift audit for the non-core-api/workers services (daemon-restart window, with the deferred observability-loopback + postgres `shm_size` batch).

## Consolidated Verification Commands (Definition of Done)

| Check | Command | Expect |
|---|---|---|
| Config-diff gate | `diff /tmp/cfg.before /tmp/cfg.after` | only {core-api/workers +observability, 4 GPL services removed} |
| Compose valid | `sudo docker compose config -q` | exit 0 |
| postgres still bound | `docker inspect open-brain-postgres --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'` | `bind /mnt/user/appdata/open-brain/pgdata` |
| Networks attached | `docker inspect open-brain-core-api --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}} {{end}}'` | contains `observability` |
| Prometheus target UP | `wget -qO- http://127.0.0.1:9090/api/v1/targets \| grep open-brain-core-api` | `"health":"up"` |
| Alert resolved | `wget -qO- http://127.0.0.1:9090/api/v1/alerts \| grep WorkersMetricsAbsent` | absent / `inactive` |
| GPL retired | `docker ps -a \| grep -E 'open-brain-(grafana\|loki\|prometheus\|pushgateway)'` | empty |
