# Security Architect Findings

**Reviewer:** Security Architect
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** Medium

---

## Methodology & Coverage Notes

All SAST tooling (semgrep, bandit, eslint, pip-audit, safety, trivy, govulncheck) was
**unavailable** in this environment. Static analysis degraded to grep-based source review of
authn/authz middleware, route handlers, SQL sinks, command-exec sinks, prompt construction,
secret handling, and Docker/network configuration. Dependency analysis used `pnpm audit`
(lockfile-based; ran successfully offline against the advisory DB).

**Significant coverage gap:** The system's entire confidentiality model rests on **Cloudflare
Access** sitting in front of `brain.troy-davis.com`. CF Access policies are configured in the
Cloudflare dashboard, **not in this repository** — they cannot be verified from code. Finding
SEC-01 is therefore flagged requires-investigation. The runtime container's exact published-port
binding on the Unraid host (interface scope) likewise cannot be confirmed from compose alone.

Prior remediation (PRs #180–#189) was spot-verified as present (proxy.ts header overwrite,
`isInternalIp()` defense-in-depth, fail-closed `checkOrigin()`, two-step reset-data, secret
redaction in backups, SafePromptBuilder). These are **not** re-reported.

---

## Threat Model Summary (STRIDE)

| Threat ID | Category | Description | Likelihood | Impact | Control Exists? | Residual Risk |
|-----------|----------|-------------|------------|--------|-----------------|---------------|
| T-01 | Spoofing | Public client forges `X-Open-Brain-Caller: internal:*` to gain rate-limit bypass / internal trust | Med | Med | Partial — proxy.ts overwrites header; `isInternalIp()` rejects public source IPs | **Med** — depends on Next.js proxy integrity (SEC-03) and on source IP not being internal (cloudflared/web-next IP *is* internal, so isInternalIp does not guard the tunnel path) |
| T-02 | Spoofing | Attacker reaches core-api:3002 / postgres:5432 / redis:6380 directly on the LAN, bypassing CF perimeter | Med | High | None at app layer (single-user, no in-boundary auth) | **High** (SEC-02) |
| T-03 | Spoofing | CF Access misconfigured/absent → entire dashboard + API public | Low–Unknown | Critical | CF Access (not in repo) | **High / unverifiable** (SEC-01) |
| T-04 | Spoofing | Forged email `From` injects a capture via the email worker | Low | Low | Sender allowlist (enforced at CF Email Worker only) | Low — but allowlist is perimeter-only, not enforced at core-api (SEC-12) |
| T-05 | Tampering | Prompt injection in untrusted email/document/voice content steers an LLM | Med | Med | SafePromptBuilder on read/synthesis paths; **NOT on extract-entities / extract-commitments** | **Med** (SEC-05) |
| T-06 | Tampering | Unauthenticated BullMQ queue clear hides/drops pipeline jobs | Med | Med | Queue-name whitelist only; no auth, no origin check | **Med** (SEC-04) |
| T-07 | Tampering | SQL injection via Drizzle / raw SQL | Low | High | Parameterized tagged templates; advisory on drizzle-orm 0.45.1 | Med (SEC-06) |
| T-08 | Repudiation | Admin destructive action without attribution | Low | Med | `admin_audit` table on every reset attempt; CF Access email as actor | Low — strong for reset-data; weak for queue-clear (no audit row, no actor) |
| T-09 | Info Disclosure | Secrets in repo / logs / backups | Low | High | Bitwarden-only; `.gitignore` covers `.env*`; token-hash-only logging; backup redaction guard | Low — controls verified present |
| T-10 | Info Disclosure | Redis (no password) holds reset tokens + rate-limit state | Med | Med | Network isolation only | **Med/Low** (SEC-08) |
| T-11 | DoS | Public ingress overwhelmed | Med | Med | In-memory sliding-window rate limiter (per-IP/caller); CF in front | Low–Med — limiter state is per-process, lost on restart; multiple replicas would not share |
| T-12 | DoS | Vulnerable deps (Next.js SSRF/DoS, ReDoS in picomatch/path-to-regexp) | Med | Med | None until bumped | Med (SEC-03) |
| T-13 | Elevation of Privilege | LAN/internal caller claims `internal:` identity to bypass mobile-auth + rate limit | Med | High | mobile-auth only triggers on `mobile-app` caller; everything else passes through unauthenticated by design | **High** (SEC-02) — combines with T-02 |
| T-14 | Elevation of Privilege | Command injection via pg_dump / sidecar subprocess | Low | High | Array-arg spawn, no shell; constant-time sidecar auth | Low — controls verified adequate |

---

## Authentication & Authorization Assessment

The system is explicitly single-user with **no in-boundary authentication** — a deliberate,
documented design choice. Confidentiality depends entirely on the perimeter (Cloudflare Tunnel +
Cloudflare Access). The code-level auth controls are:

- **MCP Bearer (`mcp/auth.ts`)** — `timingSafeEqual` with length pre-check, fail-closed when
  `MCP_BEARER_TOKEN`/`MCP_API_KEY` unset, token logged as SHA-256 prefix only. **Sound.**
- **Mobile Bearer (`middleware/mobile-auth.ts`)** — same hardened pattern; fail-closed (503) when
  `MOBILE_API_KEY` unset; **but only runs when `X-Open-Brain-Caller: mobile-app` is present**
  (`requireMobileAuthIfMobileCaller`). Any caller that omits or alters that header skips Bearer
  validation entirely. This is intentional (web/internal callers are unauthenticated by design),
  but it means mobile-auth is **not** a confidentiality boundary — it only gates the mobile rate
  tier. An attacker who reaches core-api directly simply omits the header.
- **Admin Bearer (`middleware/admin-auth.ts`)** — hardened, fail-closed. Applied to
  `/config/reload` and the Bull Board **GET** UI. **Not** applied to `/reset-data` (by design —
  compensated by origin + two-step token + phrase) **nor to `/queues/:name/clear`** (SEC-04 — a
  real gap, no compensating origin check).
- **Caller-identity / rate-limit scheme (`rate-limit.ts`)** — the `isInternalIp()`
  defense-in-depth correctly rejects a *public* source IP claiming `internal:` identity. **But on
  the production tunnel path the source IP core-api observes is the cloudflared/web-next container
  IP, which is RFC1918/internal** — so `isInternalIp()` returns `true` and the *only* thing
  preventing a forged caller header on that path is `proxy.ts` overwriting it to
  `web-next-public`. That makes Next.js proxy integrity (SEC-03) load-bearing for T-01.

**Net:** authn primitives are individually well-built (timing-safe, fail-closed, hash-only
logging). The weakness is architectural: too much rests on the unverifiable CF Access layer
(SEC-01) and on host-port isolation (SEC-02), and the caller-identity defense has a blind spot on
the legitimate tunnel path.

## SAST Findings (Triaged)

Grep-based (no SAST binaries available). False positives removed; ranked by exploitability.

| ID | File | Line | Vulnerability | Severity | Exploitability | Remediation |
|----|------|------|---------------|----------|----------------|-------------|
| S-1 | `routes/admin.ts` | 318 | `POST /queues/:name/clear` registered with **no `adminAuth()` and no `checkOrigin()`** | Medium | Reachable through public `/api/*` proxy; only CF Access + queue-name whitelist gate it | Add `adminAuth()` or `checkOrigin()` + `admin_audit` row |
| S-2 | `workers/jobs/extract-entities.ts` | 120 | Raw `{{content}}` of untrusted capture body into LLM prompt, no SafePromptBuilder | Medium | Any ingested email/doc/voice content; poisons entity graph | Wrap content via `SafePromptBuilder.wrapContent()` |
| S-3 | `workers/jobs/extract-commitments.ts` | 174 | Same raw `{{content}}` injection into LLM prompt | Medium | Same as S-2; commitments feed proactive skills | Same as S-2 |
| S-4 | `services/search.ts` | 225 | `sql.raw(String(this.hnswEfSearch))` | Low (FP-ish) | `hnswEfSearch` is zod-validated int 1–1000 from config, not user input | Safe; keep the guard comment |
| S-5 | `jobs/update-access-stats.ts` | 194 | `sql.raw(String(staleDays))` interpolated into INTERVAL | Low | `staleDays` is an internal numeric job param, not user input | Safe; assert `Number.isInteger` for defense-in-depth |
| S-6 | `mcp/auth.ts`, `mobile-auth.ts` | 47/73 | Length pre-check before `timingSafeEqual` leaks token length | Low | Token length is not secret (RFC 6750); documented accepted trade-off | No action |

No hardcoded credentials, no `-----BEGIN PRIVATE KEY-----` blocks, no committed `.env*` files, no
`verify=False`/`rejectUnauthorized:false` found. `pg_dump` and the Python sidecar use array-arg
`spawn`/`subprocess.run` with no shell — **no command injection.** Drizzle uses parameterized
tagged templates throughout — **no first-party SQL injection found.**

## Dependency Vulnerabilities

`pnpm audit`: **102 advisories (4 critical / 36 high / 56 moderate / 6 low).** Triaged to those
reachable in the production runtime (most criticals are dev-only tooling).

| Package | Version | Advisory | Severity | Exploitability (this system) | Fix |
|---------|---------|----------|----------|------------------------------|-----|
| next | ^16.2.4 | App Router Middleware/Proxy bypass; SSRF; DoS (GHSA-vfv6-92ff-j949 et al.; fixed 16.2.5) | **High** | `proxy.ts` is the security boundary that overwrites the caller header — a proxy bypass defeats T-01's only guard on the tunnel path. Public ingress. | Bump `next` ≥ 16.2.5 (one-line; trivial) |
| drizzle-orm | ^0.45.1 | SQL injection via improperly escaped input (high) | **Medium** | Production ORM. Codebase uses parameterized templates; exploitability depends on whether the vulnerable function/pattern is reached — **could not confirm from grep**. Flagged requires-investigation. | Verify affected range vs 0.45.1; bump to patched |
| simple-git | ^3.27.0 | Remote Code Execution (high) | **Medium** | Used by `shared/services/wiki-git.ts` (wiki ingest). Repo URL is config-controlled (`WIKI_REPO_URL`), not user input — low real-world reach. | Bump to patched simple-git |
| hono | ^4.12.5 | JWT NumericDate validation (low, GHSA-hm8q-7f3q-5f36) | Low | Open Brain does **not** use Hono's JWT `verify()` — auth is custom `timingSafeEqual`. Not exploitable. | Bump opportunistically |
| vitest / shell-quote / @tootallnate/once | dev | "arbitrary file read", "newline escape" (critical/low) | Low | Dev/test tooling — **not in the production container image**. | Bump in dev deps |
| axios / lodash / @xmldom/xmldom / picomatch / path-to-regexp | transitive | prototype pollution, ReDoS, code-injection, XML injection | Low–Med | Transitive; no confirmed first-party call path. picomatch/path-to-regexp ReDoS would need attacker-controlled glob/route patterns (none found). | `pnpm dedupe` + bump roots; re-audit |

**Honest uncertainty:** I did not fabricate CVSS numbers. The advisory titles above are verbatim
from `pnpm audit`; exploitability assessments are mine and conservative. The Next.js bump is the
single highest-value, lowest-effort dependency action.

## Secret Management Audit

| Location | Handling | Finding |
|----------|----------|---------|
| `.gitignore` | covers `.env`, `.env.local`, `.env.*.local`, `.env.secrets*`, `deploy/.env.secrets*` (template allowlisted) | **Compliant** |
| `git ls-files` | only `*secret*` matches are scripts/tests (`secrets-map.sh`, `load-secrets.sh`, redaction-guard tests) — no secret values | **Compliant** |
| `mcp/auth.ts`, `mobile-auth.ts`, `admin-auth.ts` | tokens compared timing-safe; logged only as SHA-256 16-char prefix | **Compliant** |
| `admin.service.ts` pg_dump | `PGPASSWORD` passed via child env, not argv (not visible in process list) | **Compliant** |
| `docker-compose.yml` `POSTGRES_PASSWORD` | `${POSTGRES_PASSWORD:-openbrain_dev}` — **dev default fallback** | **Low risk** — if `.env.secrets` is not loaded, Postgres comes up with the well-known password `openbrain_dev`. Combined with SEC-02 (5432 exposed) this is exploitable. Recommend removing the default and failing closed. |
| `redis` service | `redis-server --appendonly yes` — **no `--requirepass`** | **SEC-08** — Redis has no auth at all. |
| Bitwarden round-trip | backup redaction guard (`test-backup-secrets-redaction.sh`), 3-step lockstep, SHA256 sidecar | **Strong** — verified present |

## Injection Risk Assessment

- **SQL:** Drizzle parameterized tagged templates everywhere; the two `sql.raw()` sites (S-4, S-5)
  interpolate only internal validated numerics. No first-party SQLi. (drizzle-orm advisory tracked
  as a dependency item, SEC-06.)
- **Command:** `pg_dump` (array args, no shell) and sidecar `subprocess.run([...], shell omitted)`
  with constant-time Bearer auth and fail-closed empty-secret handling. No command injection.
- **Prompt injection:** `SafePromptBuilder` (random fenced delimiters + `[REDACTED]` denylist) is
  adopted on synthesize, MCP tools (search/list/get), entity briefs, and proactive worker skills
  (email-compose, weekly-brief, daily-sweep, daily-connections, memory-consolidation, refine-brief).
  **Gap (SEC-05):** the two *ingest* extraction stages — `extract-entities.ts` and
  `extract-commitments.ts` — feed raw `{{content}}` (the highest-volume untrusted path: every
  email, document, and voice transcript) into the LLM with no wrapping or sanitization. The P14b
  call-site migration covered the read side but missed the write/extraction side. Note: the
  `SafePromptBuilder` denylist is inherently bypassable (paraphrase, non-English, encoding) — the
  fenced-delimiter randomization is the stronger control, and the system's autonomy-gating means
  injected text cannot directly trigger high-impact actions. Realistic impact here is **entity/
  commitment-graph poisoning**, not action execution.
- **SSRF:** All worker `fetch()` calls target `${coreApiUrl}` or config-pinned spend/cost URLs —
  no user-controlled URL fetch found. Next.js SSRF advisory (SEC-03) is the only SSRF exposure and
  is a framework bug, not application code.

## Network Security Assessment

- **TLS:** terminates at Cloudflare; tunnel carries plaintext HTTP internally — acceptable for a
  Docker-network hop. No disabled cert validation anywhere in the codebase.
- **CORS:** restricted allowlist (`brain.k4jda.net`, `brain.troy-davis.com`, localhost dev) —
  good.
- **SEC-02 — host port exposure (High):** `docker-compose.yml` publishes `postgres 5432:5432`,
  `redis 6380:6379`, `core-api 3002:3000`, plus voice/whisper/loki/prometheus, with **no
  `127.0.0.1` bind prefix** — i.e. bound to `0.0.0.0` on the Unraid host. On the home LAN this
  makes the **entire unauthenticated core-api**, the Postgres instance (default-password fallback),
  and the **password-less Redis** reachable by any LAN host. core-api on the LAN sees an internal
  source IP, so `isInternalIp()` *trusts* it — a LAN client can claim `X-Open-Brain-Caller:
  internal:workers`, bypass rate limiting, and (since there is no in-boundary auth) read/write all
  captures, settings, briefs, and trigger admin endpoints subject only to origin/phrase checks.
- **Egress:** no egress controls (no finding raised — out of scope for a single-user homelab, but
  noted: a compromised worker can reach arbitrary hosts).

## Security Logging & Audit Trail

- `admin_audit` (migration 0023) records every reset-data attempt
  (requested/executed/blocked/error) with actor (CF Access email), origin, IP — **excluded from
  the TRUNCATE list** with a code-level invariant test. Strong.
- `ai_audit_log` records LLM cost/usage per call. Good for budget + abuse detection.
- Auth events logged at warn/error with token **hash only** — no secret leakage.
- **Gaps:** (1) `/queues/:name/clear` writes **no audit row and captures no actor** (SEC-04). (2)
  No security event log for repeated 401s / rate-limit-exceeded beyond a `logger.warn` — no
  alerting path. (3) PII-in-logs: the prompt-builder logs a 120-char `preview` of stripped content
  at debug level — at debug verbosity this could surface fragments of personal capture content into
  Loki. Low, but recommend gating preview behind an explicit flag.

## Compliance Control Gaps

No regulatory framework is declared for this system, and as a single-user personal knowledge base
it is **out of scope for GDPR/HIPAA/SOC2 in the formal sense**. Against a generic CIS/OWASP-ASVS
baseline the notable gaps are: (a) data-store authentication (Redis no-auth, Postgres
default-password fallback — ASVS V1.2/V2), (b) network segmentation of admin/data ports
(ASVS V1.14), (c) dependency currency (ASVS V14.2 — 36 high advisories). **Applicable framework:
Unknown / self-imposed.**

## Security Debt Register

| Finding | Severity | Exploitation Scenario | Remediation | Effort |
|---------|----------|----------------------|-------------|--------|
| SEC-01 CF Access unverifiable | High (req-inv) | If CF Access is not enforced on `brain.troy-davis.com`, the full dashboard + API + MCP is internet-exposed with zero authentication — anyone reads every personal/financial/career capture and can POST to admin endpoints from the allowed origin. | Confirm CF Access policy covers the hostname; document the policy in-repo (e.g. `deploy/cf-access.md`); add a startup assertion that requests carry `cf-access-authenticated-user-email`. | M |
| SEC-02 Host ports on 0.0.0.0 | High | A LAN host (compromised IoT device, guest on flat network) connects to `unraid-ip:3002` and reads/writes all data unauthenticated; or to `:6380` (Redis, no password) to read admin reset tokens and rate-limit state; or `:5432` with `openbrain_dev`. isInternalIp() *trusts* the LAN source. | Bind published ports to `127.0.0.1:` on the host (or remove publishing for postgres/redis entirely — only core-api/web-next need host exposure, and even those only via cloudflared). Set Redis `--requirepass`. Remove the `openbrain_dev` default. | M |
| SEC-03 Next.js 16.2.4 proxy bypass | High | Crafted request bypasses `proxy.ts`, so a client-supplied `X-Open-Brain-Caller: internal:*` reaches core-api; since the tunnel/web-next source IP is internal, isInternalIp() honors it → rate-limit bypass and internal-trust spoofing. Plus framework SSRF/DoS. | Bump `next` to ≥ 16.2.5. One-line lockfile change. | S |
| SEC-04 Queue-clear unauthenticated | Medium | Attacker (via public `/api/*` proxy, behind CF Access) POSTs `/api/v1/admin/queues/capture-pipeline/clear` to drop `delayed` (scheduled) or `failed` jobs — silently halting scheduled skills and erasing evidence of pipeline failures. No audit row written. | Add `adminAuth()` (or at minimum `checkOrigin()` + `admin_audit`) to the clear route. | S |
| SEC-05 Prompt-injection in extraction | Medium | A crafted email/document body containing injection text is processed by `extract-entities`/`extract-commitments`; the LLM emits attacker-chosen entities/commitments, poisoning the knowledge graph and downstream proactive skills. | Route `capture.content` through `SafePromptBuilder.wrapContent()` in both jobs before `templates.render()`. | S |
| SEC-06 drizzle-orm advisory | Medium | SQL injection advisory on the production ORM; reachability unconfirmed. | Verify advisory affected range vs 0.45.1; bump to patched. | S |
| SEC-07 simple-git RCE | Medium | RCE advisory in wiki-ingest's git client; repo URL is config-pinned so low reach. | Bump simple-git to patched. | S |
| SEC-08 Redis no password | Low | Any container on the `open-brain` network (or LAN via SEC-02) has unauthenticated full Redis access: admin reset tokens, rate-limit windows, banners, BullMQ jobs. | Set `--requirepass` from `.env.secrets`; update `REDIS_URL`. | S |
| SEC-09 Rate-limiter state non-shared/volatile | Low | Per-process in-memory window; lost on restart and not shared across replicas — a restart-loop or future scale-out weakens DoS protection. | Acceptable for single-process; note for any multi-replica future (move to Redis-backed). | M |
| SEC-10 Debug preview of stripped content | Low | At debug log level, 120 chars of personal capture content reaches Loki. | Gate `preview` behind an explicit env flag; default off. | S |
| SEC-11 Postgres default password | Low | `${POSTGRES_PASSWORD:-openbrain_dev}` brings DB up with a known password if secrets aren't loaded; exploitable with SEC-02. | Remove the default; fail closed if unset. | S |
| SEC-12 Email allowlist perimeter-only | Low | Sender allowlist runs in the CF Email Worker, not core-api; a direct `POST /api/v1/captures` (SEC-02 path) injects a capture from any claimed source. | Acceptable by single-user design; note that captures POST is unauthenticated by intent. | — |

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 4 |
| Low | 5 |

(The 4 `pnpm audit` "critical" advisories are dev-only tooling not present in the production image
and are triaged to Low. SEC-01 and SEC-06 are additionally flagged **requires-investigation** —
CF Access enforcement and drizzle-orm reachability cannot be confirmed from the repository.)
