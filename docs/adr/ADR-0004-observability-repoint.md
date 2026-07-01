# ADR-0004: Re-point open-brain at the Shared Observability Stack (client-joins-external-network)

**Status:** Proposed
**Date:** 2026-07-01
**Deciders:** Troy Davis (single-user system owner)
**Driven by:** `/ultra-plan` of the Phase 1.3 hand-off (`1.3-open-brain-repoint-handoff.md`, observability-migration orchestrator) — LAB_NOTEBOOK Entry 181

---

## Context

The GPL stack (Grafana / Prometheus / Loki / Pushgateway) was extracted from the open-brain compose project into a **standalone `observability` compose project** on the homeserver (Phases 1.1–1.4, live). open-brain still carries the four now-vestigial GPL service definitions (`loki`, `pushgateway`, `prometheus`, `grafana`, all `profiles: [observability]`-gated) and owns their named volumes, but it no longer runs them (`docker ps`: `open-brain-{grafana,loki,prometheus,pushgateway}` are `Exited (0)`).

Two problems, both verified live on the homeserver 2026-07-01 (read-only `docker inspect` / `wget` / git):

1. **Monitoring is broken.** The shared Prometheus (on the external `observability` bridge network) scrapes open-brain by the **compose service alias** `core-api:3000/metrics`, and open-brain workers push to `pushgateway:9091`. But core-api and workers are attached to `open-brain_open-brain` **only** — not `observability`. Live Prometheus target `open-brain-core-api` is `health:down` with `dial tcp: lookup core-api on 127.0.0.11:53: no such host`, and the `WorkersMetricsAbsent` alert is firing. `PUSHGATEWAY_URL` is unset in the workers container and absent from `.env.secrets`, so the code default `http://pushgateway:9091` (`packages/workers/src/lib/push-metrics.ts:74`) applies — correct, but only resolvable once workers joins the network.

2. **A latent volume-drift landmine.** `docker inspect` shows postgres and redis running **raw bind mounts** (`Type=bind` → `/mnt/user/appdata/open-brain/pgdata`, `/mnt/user/appdata/open-brain/redis-data`), while both the deployed appdata compose **and** GitHub `main` declare them as **plain named volumes** (`postgres_data:`, `redis_data:`, no `driver_opts`). The compose files no longer match the running containers. Any `docker compose up -d` that **recreates** postgres/redis (a no-service-filter `up`, or a future full redeploy) would attach them to empty named volumes — the DB would come up **empty** (data is not destroyed; it stays at the bind paths, but is detached). This hazard is independent of the observability change; the re-point must not trip it.

The deploy path is a **manual** `sudo docker compose up -d <services>` from `/mnt/user/appdata/open-brain` (there is no CD — CI builds/tests only). Host deviations from `main` are carried in a gitignored `docker-compose.override.yml` (ports) plus a `sed`-applied working-tree edit (core-api `0.0.0.0:3002`, per D131). The repo is **public**, so `main`'s compose is a portable source of truth and must not hardcode host-specific absolute paths.

## Decision

**open-brain joins the shared `observability` network as a client; the host-specific storage binding is reconciled in the host-only override; the deploy is gated by a `docker compose config` before/after diff.**

Four coupled sub-decisions:

1. **Topology in `main` (portable).** In `docker-compose.yml`: declare `observability: { external: true }`; add `- observability` to `core-api.networks` and `workers.networks`; delete the four `profiles:[observability]` service blocks and the now-orphaned `prometheus_data` / `grafana_data` / `loki_data` top-level volume definitions. No host paths enter `main`. Compose auto-adds the `core-api` / `workers` **service-name aliases** on every attached network, so the shared Prometheus resolves `core-api:3000` and workers resolve `pushgateway:9091` with no extra configuration.

2. **Host storage binding in `docker-compose.override.yml` (host-only, gitignored).** Reconcile the drift by declaring postgres/redis as **raw bind mounts** that match the running containers exactly:
   ```yaml
   services:
     postgres:
       volumes: [ /mnt/user/appdata/open-brain/pgdata:/var/lib/postgresql/data ]
     redis:
       ports:   [ "6380:6379" ]
       volumes: [ /mnt/user/appdata/open-brain/redis-data:/data ]
     core-api:
       ports:   [ "3002:3000" ]
   ```
   Because the running mount is a raw bind, the *matching* declaration is a raw bind path (compose v2 merges service `volumes` by container-path, so the override entry replaces the base named-volume entry for that target). This keeps `main` portable and makes the fix durable across future `git checkout origin/main -- docker-compose.yml`.

3. **Deploy safety = config-diff gate + targeted recreate.** Render `sudo docker compose config` **before** and **after** swapping in the new `main` compose; the diff must show **only** {core-api gains `observability`, workers gains `observability`, the 4 GPL services removed} and postgres/redis **still rendering as binds** with the core-api port unchanged. Any other delta → **STOP** (zero runtime impact, nothing has been recreated). Then `sudo docker compose up -d --force-recreate --no-deps core-api workers` — no image pull (compose-only change), and `--no-deps` guarantees postgres/redis are never recreated, so the landmine cannot trip even during this deploy.

4. **No interim runtime bridge** (owner decision). The alerts remain firing until the durable deploy. If a runtime bridge is ever used for interim relief, it **must** include the alias: `docker network connect --alias core-api observability open-brain-core-api` (a bare connect adds only the `open-brain-core-api` alias, leaving the `core-api` scrape unresolved).

## Alternatives Considered

1. **`driver_opts: { type: none, o: bind, device: /mnt/user/appdata/open-brain/pgdata }` on named volumes in the repo compose** (the hand-off's original suggestion). Rejected — hardcodes a homeserver-specific absolute path into the **public, portable** repo, and it still declares a *named volume* (`Type=volume`) where the container runs a *raw bind* (`Type=bind`), so it would still trigger a recreate on the next `up`.
2. **`sed` the working-tree `docker-compose.yml` binds after each `git checkout origin/main`** (mirrors the existing core-api `0.0.0.0` deviation). Rejected as the primary mechanism — it must be re-applied on every deploy and, if forgotten once, silently re-arms the exact landmine it fixes. Retained only as the **fallback** if the config-diff gate reveals the override merge doesn't render as expected.
3. **Put the observability network attachment in the override too, leaving `main` unchanged.** Rejected — the network topology *is* the source-of-truth change this ADR exists to make; `main` describing open-brain's observability client-membership is correct and portable (the external network simply must exist wherever it is deployed, which it does on the homeserver). Only the host *storage path* is host-specific and belongs in the override.
4. **Full `docker compose up -d` (no service filter) after reconciliation.** Rejected — unnecessarily recreates postgres/redis (the precise landmine risk) to achieve a change that only core-api/workers need. The targeted `--no-deps` recreate reaches the goal with zero data-store exposure.
5. **Keep the interim `docker network connect` bridge as the permanent solution.** Rejected — runtime network membership is lost on container recreate and is not source-controlled; it is at best a reversible stopgap, superseded by the compose change.

## Consequences

**Positive:**
- The shared Prometheus scrapes `core-api` and receives workers' pushes; `WorkersMetricsAbsent` + the core-api target-down alert resolve. open-brain stops duplicating the GPL stack.
- The volume-drift landmine is **disarmed durably** — the override survives future `git checkout origin/main`, so the compose files match the running containers and any future full `up` is safe.
- `main` stays portable (no host paths); the public repo describes topology, the host override describes storage.

**Negative / risks:**
- **Override merge semantics.** Compose v2 merges service `volumes` by container-path (replace), so the override's bind should replace the base's named volume for `/var/lib/postgresql/data` and `/data`. If a given compose version *appends* instead, the render would show two mounts at one target. Mitigation: the **config-diff gate renders the merged result before any `up`** — a wrong merge is caught with zero runtime impact, and the fallback is Alternative 2 (sed the base).
- **Port-deviation re-application.** The core-api `3002:3000` deviation must be re-applied (`sed`) after `git checkout origin/main -- docker-compose.yml`, matching the existing D131 pattern. The config-diff gate asserts the rendered core-api port is unchanged.
- **Orphaned GPL data.** The four `*-data` dirs under `/mnt/user/appdata/open-brain/` are now owned by the standalone observability stack; open-brain no longer references them. Any stale `open-brain_{prometheus,grafana,loki}_data` named volumes become unreferenced (prune deferred to a cleanup window).
- **`--remove-orphans` is forbidden** throughout — the live observability containers are profile-gated relative to nothing in open-brain now, but the rule stands to avoid removing anything unexpected; vestigial GPL containers are removed explicitly by name.

**Verification:** config-diff shows only the intended delta; `docker compose config -q` exits 0; postgres/redis render as binds; `docker inspect` shows core-api + workers on both `open-brain_open-brain` and `observability`; Prometheus `open-brain-core-api` target UP; `WorkersMetricsAbsent` inactive after the next ~15-min push; Loki still receiving `{compose_project="open-brain"}`; postgres/redis **row counts unchanged** across the deploy.

**Rollback:** CS-B — revert the PR (compose-only, no code/image change). CS-C — restore the backed-up appdata `docker-compose.yml` + `docker-compose.override.yml` and `up -d --force-recreate --no-deps core-api workers`. Because postgres/redis are never recreated, their data is never at risk; the config-diff gate makes the deploy abortable before any container is touched.
