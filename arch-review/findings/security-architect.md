# Security Architect Findings

**Reviewer:** Security Architect
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Review generation:** v5 (supersedes 2026-07-09 v4; adjudication-first pass)
**Confidence:** Medium

> **Tooling caveat:** As in v4, no SAST or dependency scanner was available
> (`semgrep`, `bandit`, `eslint`, `pip-audit`, `safety`, `trivy`, `govulncheck` all
> `not_available`). Evidence base is manual code review + fresh `pnpm audit` + git-history
> verification. This remains the largest coverage gap.

> **Scope note:** the only code merged since v4 is the Dependabot dependency remediation
> (PRs #232–#234 + `cd14c1f` dependabot.yml, Entry 183) plus test backfill and dead-code
> removal (`core-api/src/services/sse.ts` deleted — security-neutral). Verified via
> `git log/diff` — no application-logic, auth, or network-exposure changes. This pass
> therefore adjudicates every v4 finding with fresh evidence, then reports one net-new
> dependency-surface finding (SEC-B1). ADR-0002/D131/D132 owner risk-acceptances are
> respected, not re-litigated.

---

## v4 Adjudication Summary

| v4 ID | v4 Severity | Verdict | Evidence (this pass, 2026-07-12) |
|-------|-------------|---------|----------------------------------|
| SEC-A1 voice-pipecat `ws://0.0.0.0:8765` zero-auth | High | **STILL OPEN** | `docker-compose.yml:259-260` still publishes `"8765:8765"`/`"8766:8766"` (no loopback prefix); `packages/voice-pipecat/src/config.py:44` default `host = "0.0.0.0"`; `src/main.py:59-105` `handle_websocket_connection` → `websockets.serve(handler, …)` with **no token/Bearer/secret check anywhere in the package** (grep for auth/bearer/secret/token returns only LLM API-key config); still **zero mentions** of pipecat/8765 in `docs/adr/ADR-0002-lan-exposure-model.md` and `docs/SECURITY.md` |
| SEC-A2 mobile Bearer unreachable in prod topology | Medium (RI) | **STILL OPEN** | `packages/web-next/proxy.ts:21` still unconditionally sets `X-Open-Brain-Caller: web-next-public`; `core-api/src/middleware/mobile-auth.ts:105` still fires only on `caller === 'mobile-app'` → `MOBILE_API_KEY` never validated via the CF-tunnel path. Still requires owner confirmation of intended mobile ingress |
| SEC-A3 voice-capture `:3001` on `0.0.0.0`, secret unset in prod (warn-allow) | Medium | **STILL OPEN** | `docker-compose.yml:373` still `"3001:3001"`; `voice-capture/src/server.ts:19-21` still logs "UNAUTHENTICATED (pre-rollout warn-and-allow)" when `VOICE_CAPTURE_SECRET` unset; intake confirms secret still NOT SET in prod. Fail-closed-when-set + timingSafeEqual code is correct and unchanged — the control is scaffolded but inactive |
| SEC-A4 LLM prompt-injection residual | Medium | **STILL OPEN (accepted)** | `shared/src/lib/prompt-builder.ts` present; `SafePromptBuilder` used across 12+ non-test call sites (entity.ts, synthesize.ts, MCP search-brain/list-captures, 6 worker skills). SECURITY.md §3 future work (output-schema validation, Loki redaction alert) still pending |
| SEC-A5 dependency backlog (4C/35H/65M/8L) | Medium | **CHANGED — substantially remediated; downgraded to Low** | Fresh `pnpm audit`: **0 critical / 2 high / 24 moderate / 3 low** (was 4/35/65/8). Both v4 runtime advisories fixed: `hono@^4.12.25` (core-api + voice-capture package.json; lockfile 4.12.25) and `nodemailer@^9.0.1` (workers). vitest 2→3 killed the critical GHSA-5xrq-8626-4rwp; shell-quote critical gone. Remaining 2 highs are `vite <=6.4.2` dev-scope; moderates are transitive/dev except SEC-B1 below and a not-exploitable js-yaml (local trusted config only). `.github/dependabot.yml` now enables weekly grouped updates + auto security fixes — recurrence control in place |
| SEC-A6 app containers run as root | Low | **STILL OPEN** | Only `packages/voice-pipecat/Dockerfile:29` sets `USER pipecat`; main `Dockerfile`, `web-next/Dockerfile`, `docker/ingest-sidecar/Dockerfile` still have no `USER` directive |
| SEC-A7 `._*` AppleDouble junk not gitignored | Low | **STILL OPEN** | `.gitignore:55` has only `.DS_Store`; `._.DS_Store`, `packages/._.DS_Store`, `packages/web-next/._.DS_Store` still untracked per git status |

**Re-verified clean (no regression since v4):** secret grep (only test fixtures `test-secret` in ingest-sidecar tests), no PEM blocks, no committed `.env`/`.env.secrets` files, no `eval`/shell-exec, no `verify=False`/`rejectUnauthorized:false`, all three Bearer validators (`mcp/auth.ts`, `mobile-auth.ts`, `admin-auth.ts`) unchanged (timing-safe, fail-closed, hash-only logging), admin two-step reset + queue-clear origin guard + audit rows unchanged, `proxy.ts` public-boundary overwrite intact, `isInternalIp()` defense-in-depth intact.

---

## Threat Model Summary

Unchanged from v4 — the trust boundaries did not move (dependency-only delta). Register carried forward with updated residuals:

| Threat ID | Category | Description | Likelihood | Impact | Control Exists? | Residual Risk |
|-----------|----------|-------------|------------|--------|-----------------|---------------|
| S-1 | Spoofing | LAN host claims `X-Open-Brain-Caller: internal:*` to core-api | Med | High | Partial — `isInternalIp()` blocks public IPs only; LAN trusted by design | **Accepted** (ADR-0002/D131) |
| S-2 | Spoofing | Mobile Bearer bypassed — `proxy.ts` rewrites caller before `requireMobileAuthIfMobileCaller` fires | Med | Med | Dead in prod topology; CF Access is the only real control | SEC-A2 (RI) |
| S-3 | Spoofing | Unauthenticated WebSocket to voice-pipecat | Med (LAN) | Med-High | **None** | SEC-A1 |
| T-1 | Tampering | Prompt injection via capture content | Med | Med | `SafePromptBuilder` (pattern strip + nonce fencing) | SEC-A4 (probabilistic) |
| T-2 | Tampering | LAN host injects captures via unauth voice paths | Med | Med | Bearer scaffolded but inactive (voice-capture); none (pipecat) | SEC-A1/A3 |
| R-1 | Repudiation | Destructive admin action denied | Low | Med | `admin_audit` (TRUNCATE- and prune-excluded, invariant-tested) | Adequate |
| I-1 | Info Disclosure | Secrets in logs/repo | Low | High | Bitwarden-only; SHA-256-prefix token logging; redaction CI guards | Adequate — re-verified clean |
| I-2 | Info Disclosure | Postgres/Redis LAN-reachable | Low | High | Loopback binds + requirepass (ADR-0002 deployed) | Adequate |
| I-3 | Info Disclosure | Unauth fetch of Bull Board static assets via serveStatic slash bypass | Low | Very Low (public npm UI assets only) | adminAuth on `/queues/*`; vulnerable `@hono/node-server@1.19.11` | SEC-B1 (new) |
| D-1 | DoS/cost-drain | Unauth paid-API endpoints (Deepgram/Anthropic via pipecat; Whisper via voice-capture) | Med | Med (budget) | None on pipecat; budget breaker meters OpenAI only | SEC-A1/A3 |
| D-2 | DoS | Transitive-dep ReDoS/resource exhaustion | Low | Low | Backlog cut 112→29 paths; Dependabot automation live | SEC-A5 (now Low) |
| E-1 | EoP | Container escape lands as root | Low | Med | Non-root only on voice-pipecat | SEC-A6 |

---

## Authentication & Authorization Assessment

Unchanged since v4 (verified byte-for-byte on the relevant middleware — no auth code in the merged delta). Strengths re-confirmed: timing-safe fail-closed Bearer validators with hash-only logging; admin destructive-op chain (origin allowlist fail-closed on unknown `NODE_ENV`, two-step single-use Redis token, confirmation phrase, audit rows); rate-limit defense-in-depth (`isInternalIp` + `proxy.ts` overwrite); Bull Board UI behind `adminAuth()` (`routes/admin.ts:407`).

Open weaknesses remain SEC-A1 (no auth at all on pipecat WS) and SEC-A2 (mobile Bearer architecturally unreachable).

---

## SAST Findings (Triaged)

No automated SAST available; manual triage re-confirmed the v4 table with no new dynamic-SQL/exec sites introduced (the only source change was dead-code *removal*).

| ID | File | Line | Vulnerability class | Severity | Exploitability | Remediation |
|----|------|------|---------------------|----------|----------------|-------------|
| M-1 | `core-api/src/services/search.ts` | ~255 | `sql.raw()` in `SET LOCAL hnsw.ef_search` | Info | Not exploitable — zod-validated int (1–1000) from config | None |
| M-2 | `core-api/src/mcp/tools/list-entities.ts` | 59-72 | `ORDER BY` fragment interpolation | Info | Not exploitable — whitelisted 3-way switch; filters are bound params | None |
| M-3 | `admin.service.ts` / `himalaya.ts` | — | `spawn`/`execFile` | Info | Not exploitable — array-arg, no shell | None |
| M-4 | `docker/ingest-sidecar/trigger_server.py` | 228 | Trigger secret check | Info | Correct — `hmac.compare_digest`, loopback-bound | None |

Injection posture remains clean: Drizzle parameterization throughout, `toPgTextArray`/`pgUuidArray` helpers in use, no string-concatenated SQL, no `eval`, no shell injection, no TLS-verification bypass.

---

## Dependency Vulnerabilities

Fresh `pnpm audit` (2026-07-12): **0 critical / 2 high / 24 moderate / 3 low** across 1,841 dependencies — down from 4/35/65/8 at v4. Matches the intake's Entry 183 outcome (119→20 GitHub alerts). Triage of everything with any runtime relevance:

| Package | Installed | Advisory | Severity | Exploitability in THIS system | Fix |
|---------|-----------|----------|----------|-------------------------------|-----|
| @hono/node-server | 1.19.11 | GHSA-92pp-h63x-v22m serveStatic middleware bypass via repeated slashes (<1.19.13) | Moderate | **Marginal — see SEC-B1.** core-api DOES use `serveStatic` (`routes/admin.ts:2,301`, Bull Board `HonoAdapter`) on a path guarded by `adminAuth()`. A successful bypass would serve only Bull Board's public static UI assets (queue-data APIs are Hono routes, not serveStatic); service is LAN-only + admin rate-limit tier. Patch regardless — it is the sole remaining runtime-code-path advisory. | `@hono/node-server@^1.19.13` |
| js-yaml | 4.1.x | GHSA-h67p-54hq-rp68 quadratic DoS via merge-key aliases (CVE-2026-53550) | Moderate | **Not exploitable** — runtime use (slack-bot/voice-capture lightweight config load, ConfigService) parses only local, operator-authored YAML mounted read-only; no attacker-controlled YAML path exists | js-yaml ≥4.2.0 via next Dependabot wave |
| vite | ≤6.4.2 | GHSA-fx2h-pf6j-xcff `server.fs.deny` bypass (+1 more high path) | High ×2 | **Dev-only** — vite dev server never runs in prod containers or CI-exposed | Dependabot PRs #235–#243 in flight |
| brace-expansion, esbuild, ip-address, postcss, qs, tar, uuid, yaml, @babel/core, @tootallnate/once | transitive | DoS/XSS/file-read (dev-server class) | Mod/Low | **Transitive, dev/build/mobile-weighted** — none on the Hono request path | grouped Dependabot updates (now automated weekly) |

**v4 runtime items confirmed FIXED:** `hono@4.12.25` (CORS advisory patched), `nodemailer@9.0.1`, vitest 3 (critical UI-server advisory), shell-quote critical gone. **New recurrence control:** `.github/dependabot.yml` (weekly grouped minor/patch, isolated majors, root + email-worker + synthetic-monitor ecosystems).

---

## Secret Management Audit

Re-verified — still **excellent**, no regression:
- Hardcoded-credential grep: only `test-secret` fixtures in `docker/ingest-sidecar/tests/` (test-scoped, correct).
- No PEM blocks, no committed `.env`/`.env.secrets` anywhere (find returned zero non-template env files).
- `.gitignore` still covers `.env.secrets*`; Bitwarden 3-step lockstep + load/verify/roundtrip scripts + backup redaction CI guard unchanged.
- Token logging remains SHA-256-prefix-only across all auth paths.
- Housekeeping residue: SEC-A7 (`._*` not gitignored) still open.

---

## Injection Risk Assessment

- **SQL:** clean (SAST table above). No new sites since v4.
- **Command:** clean — array-arg `spawn`/`execFile` only.
- **Prompt:** `SafePromptBuilder` coverage intact (12+ call sites); residual is inherent/accepted (SEC-A4). Loki alert for repeated redactions still TBD.
- **PG array literals:** `toPgTextArray` (core-api search) + `pgUuidArray` (workers) patterns in place per Phase-10/Entry-180 hardening.

---

## Network Security Assessment

Unchanged from v4 — verified in current `docker-compose.yml`:
- Loopback-bound (correct): postgres `127.0.0.1:5432`, redis `127.0.0.1:6380`+requirepass, file-ingestion `127.0.0.1:8080`, faster-whisper `127.0.0.1:10300`.
- `0.0.0.0` accepted by ADR-0002: web-next `:3003`, core-api `:3002` (D131).
- `0.0.0.0` **NOT in the exposure model**: voice-pipecat `:8765/:8766` (SEC-A1); voice-capture `:3001` whose D132 Bearer control is inactive in prod (SEC-A3).
- TLS terminates at Cloudflare; no in-code TLS bypass anywhere.

---

## Security Logging & Audit Trail

- `admin_audit` coverage (reset-data + queue-clear, all outcomes, actor/IP/origin) unchanged; TRUNCATE- and retention-prune-exclusion invariant tests still present.
- Auth failures log at warn with token hash + path.
- **Gap (carried):** no security event on unauthenticated ingest acceptance (pipecat connection open; voice-capture warn-allow logs once at boot, not per-request); SafePromptBuilder redaction Grafana alert still TBD (SECURITY.md §1.5).

---

## Compliance Control Gaps

**Framework: Unknown / N/A** (single-user personal system, no regulatory scope). Carried note: schema holds health/financial/insurance data — any move to multi-user or hosted service triggers a formal control-mapping requirement. RC-10 (repo PUBLIC with LAN topology detail) remains an owner decision pending outside this domain's severity ledger (tracked by risk-compliance).

---

## Security Debt Register

| Finding | Severity | Exploitation Scenario | Remediation | Effort |
|---------|----------|----------------------|-------------|--------|
| **SEC-A1** voice-pipecat `ws://0.0.0.0:8765` zero-auth, absent from ADR-0002 exposure model *(v4 carry, unchanged)* | **High** | Compromised IoT/guest device on the home LAN connects to `ws://homeserver:8765`; `handle_websocket_connection` accepts any socket → full Pipecat pipeline (Deepgram STT → Anthropic LLM → TTS) → (a) drains paid Deepgram+Anthropic spend that the OpenAI-metered $50 breaker plausibly does not cover, (b) injects arbitrary captures into the KB. No rate limit on the port. | Bearer/shared-secret check in the WS handler (mirror `VOICE_CAPTURE_SECRET` fail-closed-when-set pattern); loopback-bind 8765/8766 (no LAN consumer identified); add pipecat spend to the budget breaker; add to ADR-0002 table. Flagged as go-condition A136 in v4 — **no motion since**. | M |
| **SEC-A2** mobile Bearer (`MOBILE_API_KEY`) architecturally unreachable *(v4 carry, unchanged; requires investigation)* | **Medium** | Mobile → CF tunnel → web-next `proxy.ts:21` rewrites caller to `web-next-public` before core-api's `requireMobileAuthIfMobileCaller` (fires only on `mobile-app`) → Bearer never validated; CF Access is the sole mobile control. | Confirm intended mobile ingress; either validate Bearer at/before the rewrite, exempt a dedicated route, or document CF-Access-only and delete the dead middleware. | S-M |
| **SEC-A3** voice-capture `:3001` on `0.0.0.0` with `VOICE_CAPTURE_SECRET` unset in prod (warn-allow phase 1) *(v4 carry, unchanged)* | **Medium** | D132's stated control is inactive: any LAN host POSTs audio → paid Whisper transcription + injected capture, unauthenticated. | Complete phase 2: set the secret (BWS item scaffolded) → fail-closed; then the deferred 8.2 loopback bind. | S |
| **SEC-A4** LLM prompt-injection residual *(v4 carry, accepted)* | **Medium** | Adversarial capture content evades the static 14-pattern strip (novel/Unicode/non-English payloads); blast radius bounded by autonomy gates + offline workers. | SECURITY.md §3 backlog: output-schema validation, Loki redaction alert, content-is-data system framing. | M |
| **SEC-A5** dependency vuln backlog *(v4 Medium → **downgraded to Low**: 112→29 paths, 0 critical, both runtime advisories patched, Dependabot automation live)* | **Low** | Remaining highs are vite dev-scope; moderates transitive/dev except SEC-B1 and a not-exploitable js-yaml (trusted local config only). Residual risk is hygiene drift, now automated against. | Merge in-flight Dependabot PRs #235–#243; monitor weekly grouped updates. | S |
| **SEC-B1** *(NEW)* `@hono/node-server@1.19.11` < 1.19.13 — serveStatic middleware bypass (GHSA-92pp-h63x-v22m) on an actually-used runtime path | **Low** | core-api's Bull Board (`routes/admin.ts:301`) serves static UI assets via the vulnerable `serveStatic` behind `adminAuth()` on `/queues/*`. A repeated-slash bypass could serve those assets unauthenticated — impact is minimal (public npm UI assets; queue-data APIs are Hono routes outside serveStatic), and the service is LAN-only. It is, however, the only remaining advisory touching live runtime code. | Bump `@hono/node-server@^1.19.13` in core-api + voice-capture (next Dependabot wave or direct). | XS |
| **SEC-A6** app containers run as root (only voice-pipecat sets `USER`) *(v4 carry, unchanged)* | **Low** | Container escape/RCE in core-api/workers/slack-bot/voice-capture/web-next/ingest-sidecar lands as UID 0 in-container. | Add non-root `USER` to each prod stage. | S |
| **SEC-A7** `._*` AppleDouble junk untracked, not gitignored *(v4 carry, unchanged)* | **Low** | Hygiene only — risk of accidental future commit. | Add `._*` to `.gitignore`; clean untracked files. | XS |

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 4 |

*SEC-A2 is additionally flagged **requires_investigation** (exploitability depends on the mobile ingress path + CF Access native-app behavior, unverifiable from code alone).*

**Net movement since v4:** dependency posture materially improved (SEC-A5 Medium→Low; 0 criticals; recurrence automation added); one new Low (SEC-B1); every other v4 finding is unchanged — in particular the v4 High (SEC-A1, also exec-summary go-condition A136) has had **no remediation motion**.
