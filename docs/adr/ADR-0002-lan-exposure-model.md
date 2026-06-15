# ADR-0002: LAN Exposure Model — Bind Data Stores to Loopback, Dual-Bind core-api for Tailscale MCP

**Status:** Proposed
**Date:** 2026-06-15
**Deciders:** Troy Davis (single-user system owner)
**Driven by:** `/ultra-plan` remediation of arch-review v3 — findings SEC-02, SEC-08, SEC-11, PLT-L1, PLT-L3 (LAN-perimeter cluster, change set CS-1)

---

## Context

`docker-compose.yml` publishes every service port to `0.0.0.0` on the Unraid host's LAN interface. The architecture review (2026-06-10) found this is the system's softer attack surface: the trust model was hardened against the *internet* path (Cloudflare Access → tunnel → `proxy.ts` overwrites `X-Open-Brain-Caller` → `isInternalIp()` defense-in-depth), but `isInternalIp()` *trusts* RFC1918 + Tailscale CGNAT source IPs. Any LAN host (a compromised IoT device, a guest laptop) can therefore:

- reach `core-api:3002` directly, claim `X-Open-Brain-Caller: internal:workers`, and read/write all personal data (no in-boundary auth — accepted single-user design);
- connect to `postgres:5432` using the `openbrain_dev` default-password fallback;
- connect to password-less `redis:6380` and read 5-minute admin reset tokens, rate-limit windows, and BullMQ job payloads;
- POST spoofed health metrics to the unauthenticated `pushgateway:9091`.

The complicating constraint: **core-api `:3002` has a legitimate external consumer.** OpenClaw (on bond.k4jda.net) reaches the MCP endpoint at `100.101.61.122:3002/mcp` over Tailscale (per memory `openclaw-integration.md`; token = `MCP_API_KEY`). Binding core-api purely to `127.0.0.1` would silently break OpenClaw's MCP access. Every other published port has **no** legitimate external consumer — Cloudflare Tunnel reaches services over the `open-brain` Docker network (verified in `config/cloudflare/tunnel.yaml`), not via published host ports; `web-next:3003` and `grafana:3050` are reached by Troy's own browser on the LAN. Mobile/iOS voice (`:3001`) is handled separately in ADR-scope CS-8 (INT-M5).

## Decision

**Bind all data-store and internal-only ports to `127.0.0.1`; dual-bind core-api to loopback + the Tailscale interface IP; keep `web-next` and `grafana` on the LAN; fail closed on credentials.**

Concretely, in `docker-compose.yml`:

| Service | Port | Old bind | New bind | Rationale |
|---|---|---|---|---|
| postgres | 5432 | `0.0.0.0` | `127.0.0.1` | No external consumer; `docker exec` for host admin |
| redis | 6380 | `0.0.0.0` | `127.0.0.1` | + `--requirepass ${REDIS_PASSWORD}` |
| pushgateway | 9091 | `0.0.0.0` | `127.0.0.1` | Prometheus scrapes over Docker network |
| prometheus | 9090 | `0.0.0.0` | `127.0.0.1` | Internal; Grafana queries over Docker network |
| loki | 3100 | `0.0.0.0` | `127.0.0.1` | (Note: Docker log driver reaches it via host IP per PLT-H3/CS-4) |
| file-ingestion | 8080 | `0.0.0.0` | `127.0.0.1` | Internal sidecar |
| faster-whisper | 10300 | `0.0.0.0` | `127.0.0.1` | Internal; voice-capture reaches over Docker network |
| voice-capture | 3001 | `0.0.0.0` | (deferred to CS-8) | INT-M5 adds Bearer auth first, then loopback-binds |
| **core-api** | 3002 | `0.0.0.0` | `127.0.0.1` **+ `${TAILSCALE_IP}`** | OpenClaw MCP over Tailscale must survive |
| web-next | 3003 | `0.0.0.0` | `0.0.0.0` (keep) | Troy's LAN browser access to the dashboard |
| grafana | 3050 | `0.0.0.0` | `0.0.0.0` (keep) | Troy's LAN browser access to dashboards |

Credentials fail closed: `POSTGRES_PASSWORD:?must be set` and `GRAFANA_ADMIN_PASSWORD:?must be set` (remove `:-openbrain_dev` / `:-admin` fallbacks). New `REDIS_PASSWORD` secret follows the P08 3-step lockstep (BWS → `.env.secrets.template` + `secrets-map.sh` → `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379` consumers).

`${TAILSCALE_IP}` is parameterized in `.env` (default `100.101.61.122`) so the compose file is host-portable and the dev laptop (no Tailscale) can leave it unset to bind loopback-only.

## Alternatives Considered

1. **Re-point OpenClaw at the LiteLLM gateway MCP (`llm.troy-davis.com/mcp`) and bind core-api loopback-only.** Cleanest perimeter (zero LAN-published app ports), but touches a second system (bond.k4jda.net OpenClaw config + token chain) and couples this remediation to the standalone LiteLLM proxy's MCP routing, which the review explicitly placed out of scope. Deferred as the long-term target; recorded as follow-up.
2. **Bind core-api to `127.0.0.1` only and accept the OpenClaw break.** Rejected — OpenClaw MCP access is an active, used integration; silently breaking it to close a finding trades one problem for another.
3. **Status quo + risk-accept SEC-02.** Rejected — defeats the entire CS-1 change set; the review rated LAN exposure High precisely because the compensating control (`isInternalIp` trusting RFC1918) makes the LAN the *easier* path than the hardened internet path.
4. **`requirepass` on Redis but leave ports on `0.0.0.0`.** Rejected as half-measure — Postgres and Pushgateway would remain open; defense should be at the bind layer, not only the auth layer.

## Consequences

**Positive:** Collapses most of the LAN attack surface with one compose edit + one new secret. Postgres/Redis/Pushgateway become unreachable from other LAN hosts. Credentials fail closed (a silent `.env.secrets` load failure now refuses to boot rather than falling back to a well-known password).

**Negative / risks:**
- **Boot-order dependency:** the `${TAILSCALE_IP}` bind requires `tailscale0` to be up before Docker publishes the port. Mitigation: Unraid plugin start order already brings Tailscale up early; a `post-compose-up.sh` smoke check (CS-4/CS-9) verifies the MCP port answers on the Tailscale IP after `up`.
- **Host admin friction:** `psql`/`redis-cli` from the host shell now require `docker exec` instead of direct connection. Acceptable; documented in deploy runbook.
- **New secret to manage:** `REDIS_PASSWORD` enters the BWS rotation surface (90-day staleness alert via `secret-rotation` skill).

**Verification:** From a separate LAN host, `nmap <homeserver-lan-ip>` shows only `3003` + `3050` open (plus host services outside this stack); `3002/5432/6380/9091` filtered. From bond.k4jda.net, `curl 100.101.61.122:3002/api/v1/captures?limit=1` with the MCP bearer still succeeds. `docker compose config` validates; full-stack health passes; one search round-trips (exercises Redis auth).

**Rollback:** revert the compose diff + `docker compose up -d --force-recreate`. The `REDIS_PASSWORD` secret can remain in BWS unused.
