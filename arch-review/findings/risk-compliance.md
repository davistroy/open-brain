# Risk & Compliance Findings

**Reviewer:** Risk & Compliance
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain`
**Confidence:** High
**Note:** Compliance assessment is based on code and configuration analysis only. Legal/regulatory determination requires qualified legal review. For a single-user, self-hosted system the risk frame is catastrophic loss (data destruction, credential compromise, third-party account suspension, cost runaway) rather than regulatory audit.

---

## Detected Regulatory Scope

The intake is explicit that this is a single-user, self-hosted personal knowledge system. Operator = data subject = data controller. Conventional regimes largely N/A:

| Framework | Applies? | Reason |
|-----------|----------|--------|
| GDPR / UK-GDPR | **Partially** | Household exception (Art. 2(2)(c)) covers purely personal activity. BUT: correspondents (email senders, people mentioned in captures) are third-party data subjects whose data is processed and transmitted to OpenAI / Anthropic. If Troy ever shares synthesis outputs externally, household exception narrows. |
| CCPA / CPRA | No | Single-person operation, no sale of personal information, well below business thresholds. |
| HIPAA | No | No PHI handling. |
| SOX / PCI-DSS | No | No regulated financial system-of-record; `data/` contains personal CSVs, not card holder data. |
| FTC Act §5 | Indirect | Privacy claims in the README/PRD would become enforceable if the system were commercialized. Not in scope today. |

**Effective control frame:** catastrophic-loss-avoidance (data destruction, credential compromise, third-party account suspension, cost runaway) — not regulatory audit. The rest of this report is scoped accordingly.

---

## Compliance Control Mapping

| Control Area | Framework | Status | Evidence | Gap |
|--------------|-----------|--------|----------|-----|
| Access control | Household | **Partial** | `adminAuth` (Bearer on `/api/v1/admin/config|queues/*`); MCP Bearer token; single-user trust model. | `POST /admin/reset-data` and `/admin/queues/:name/clear` intentionally bypass `adminAuth` ("web UI cannot send Bearer tokens"). Mitigated by confirmation phrase + admin rate limiter; still a wider attack surface than the Bearer paths. |
| Audit logging (LLM) | Household | **Good** | `ai_audit_log` (task_type, model, tokens, cost_usd, client_used, capture_id, error) with indexes; `mcp_activity`; `pipeline_events`; `skills_log` (input_summary, output_summary, result JSONB, duration_ms); `activity_feed`. | `memory-consolidation` calls Anthropic via `callClaude()` directly — audit coverage via skills_log only, not `ai_audit_log` row per call. Intake also flags weekly-brief + memory-consolidation as bypassing LLMGatewayService. |
| Audit logging (admin) | Household | **Partial** | `logger.warn([admin] Data reset initiated…)` prints a pino log line. | No database audit row for destructive admin actions (reset-data, queue clear, banner set/delete). Logs are ephemeral unless Loki retention catches them (30-day). |
| Encryption at rest | Household | **Implicit only** | Postgres volume + Redis RDB + backup archive all live on Unraid XFS; no disk-level encryption indicated anywhere. `backup.sh` emits unencrypted pg_dump + `.env` + `.env.secrets` to `/mnt/user/backup/openbrain/`. | Plain-text secrets on the backup share. Any offsite copy (rclone, USB) propagates them. |
| Encryption in transit | Household | **Good** | Cloudflare Tunnel fronts public routes with TLS 1.3; OpenAI/Anthropic over HTTPS; Tailscale overlay for remote hardware (WireGuard). | `postgresql.conf` uses `listen_addresses = '*'` on the docker network with no TLS — fine inside the bridge, concerning if Postgres port is ever exposed. |
| Data retention | Household | **Partial** | Backup: 14 daily / 4 weekly / 3 monthly (`scripts/backup.sh`). Loki: 720h (30 days). `captures.deleted_at` supports soft-delete; `captures` never hard-purged. | **No periodic hard-delete anywhere.** Memory consolidation soft-deletes originals (recoverable) but no job prunes `deleted_at IS NOT NULL` rows after N days, nor `pipeline_events`, `mcp_activity`, `session_messages`, or `ai_audit_log`. Tables grow unbounded. |
| Right to erasure | GDPR-adjacent | **Absent** | `DELETE /api/v1/captures/:id` = soft delete only (per PRD.md:1506). | If a correspondent ever asks "remove my emails from your system," there is no inventory/search for "all content mentioning person X" beyond manual entity-graph traversal, no hard-delete tool, no way to purge entity graph + embeddings for that person. Same for voice transcripts and Slack messages naming third parties. |
| Breach notification readiness | Household | **N/A** | No PII-of-others inventory, no template. | If the homeserver were compromised (SSH, Cloudflare tunnel, Slack token), there's no contact list of third parties whose data was involved. Decide whether this matters at all — likely not for most threat models, but note it. |
| Vendor agreements (DPA) | Household | **Not applicable** | Consumer tiers only; no enterprise DPAs. | OpenAI / Anthropic **consumer** terms opt captures into training by default on some SKUs — need to verify that the accounts used are API-mode (not ChatGPT/Claude.ai consumer) and that data-retention/opt-out settings are explicit. Not visible in code. |
| License compliance | FOSS hygiene | **Likely clean** | Apache 2.0 `LICENSE`. No per-package `"license"` field in `package.json` (all `private: true`). Flagged deps audited below. | `simple-git` is MIT (clean). `googleapis` is Apache-2.0 (clean). `pg`, `ioredis`, `bullmq`, `drizzle-orm`, `hono`, `@slack/bolt`, `openai`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` all MIT/Apache. No AGPL/GPL direct deps surfaced. Full `pnpm licenses list` not run in-scope. |

---

## Audit Trail Assessment

**Strong:** The LLM audit trail is explicitly designed and load-bearing. `ai_audit_log` (migration 0000 + 0013) captures every inference call with tokens, model, cost, and which client (Anthropic SDK vs OpenAI SDK). `budget-check` reads it to estimate spend when no external proxy is configured. `mcp_activity` logs every MCP tool invocation with sanitized parameters (SENSITIVE_PARAM_KEYS redacted, strings >200 chars truncated). `pipeline_events` records stage transitions. `skills_log` records skill runs with input/output summaries and structured `result` JSONB. `activity_feed` gives unified dashboard visibility. `container_health` and `backup_log` (legacy but retained) cover infrastructure.

**Gaps:**

1. **Direct Anthropic SDK calls bypass `ai_audit_log`.** `memory-consolidation.ts:360` uses `callClaude(this.anthropicClient, prompt, …)`; `weekly-brief` has both gateway and direct paths. `runAgent` multi-turn loops have dedicated `logAgentAudit` (llm-gateway.ts:~796), but `callClaude` in isolation does not guarantee a row. This is consistent with intake's flagged follow-up PR.
2. **Admin actions are not persisted to the database.** `POST /admin/reset-data`, `POST /admin/queues/:name/clear`, `POST /admin/slack/channels/:id/archive`, banner set/delete all emit pino logs but no audit row. If the homeserver is ever compromised and reset-data is invoked maliciously, the only record would be Loki (30d) and the truncation of `captures` itself.
3. **Autonomous action audit is uneven.** Auto-response shadow-mode logging is thorough (confidence factors, threshold, autonomy level). Daily-sweep, memory-consolidation, and email-compose auto-send log to `skills_log` with a result JSONB — that is actually acceptable. But there is no single audit view that answers "what proactive actions did Open Brain take in the last 24h, under what autonomy level, with what outcome?"
4. **Email worker inbound doesn't audit rejections.** Cloudflare Email Worker 403s non-allowlisted senders — there is no central log of who was rejected when (useful for spotting misdirected mail or reconnaissance).

---

## Data Residency Assessment

| Location | Data |
|----------|------|
| Homeserver (`/mnt/user/appdata/open-brain/`, Postgres, Redis, backups) | Captures, embeddings, entity graph, voice transcripts, session messages, audit logs, email drafts, allowlist |
| Homeserver (`data/` on dev box, 128 MB) | Personal financial CSVs, tax filings, brokerage transactions, order exports (gitignored) |
| OpenAI (api.openai.com/v1) | Embedding inputs (capture content) + LLM prompt content for t1_fast/t2_quality when routed; organization-level retention per OpenAI API ToS |
| Anthropic (api.anthropic.com) | LLM prompt content for t1_fast, t2_quality, weekly-brief, governance, email-compose, memory-consolidation |
| Anthropic via Claude Code CLI (`open-brain-vm`) | T2 batch synthesis prompts — subject to Claude Max subscription ToS (Anthropic states no training on API/CLI traffic; verify current policy) |
| DGX Spark / Jetson (LAN, Tailscale) | Stays on LAN; no third-party exposure |
| Deepgram | Voice audio fragments (capped $5/mo) |
| Composio | Gmail/Outlook/Drive/Notion/Slack credentials + flow logs (free 20K/mo tier — verify data handling) |
| Pushover | Notification titles + truncated bodies |
| Cloudflare | Email routing metadata + tunnel traffic metadata (not content) |
| Gitea (Tailscale-only) | Wiki page markdown (private repo, self-hosted) |
| GitHub | Source code, CI logs, PR comments (NOT prod data) — standard consumer repo |

**Cross-border transfer** is not regulated here (US operator), but the data flow to OpenAI/Anthropic is voluminous and continuous. An operator-level decision would be to confirm:

- OpenAI org is on an **API plan with zero-retention or standard 30-day retention** (org admin setting), not consumer ChatGPT terms.
- Anthropic API key is **org-level** and zero-retention eligible where available.
- Neither account has training opt-in enabled.

No code-level evidence was found of those policy settings — they live outside the repo.

---

## Third-Party Risk Register

| Vendor | Data Shared | Risk Level | Contract Posture | Finding |
|--------|-------------|------------|------------------|---------|
| **OpenAI** | Capture text (embeddings + prompts), model aliases gpt-5.4 everywhere | HIGH volume | API ToS (consumer) | Voluminous; every capture is embedded. One API-policy change (training opt-in, retention change) propagates system-wide. No abstraction for switching providers without re-embedding (embeddings dimension coupling). |
| **Anthropic API** | Synthesis, governance, weekly brief, memory consolidation, email-compose prompts + capture context | MED volume | API ToS | t2_quality only; budget cap $35/mo hard. Memory consolidation runs weekly and pushes clustered capture text for merge decisions — this is the highest-sensitivity prompt payload (aggregated personal content). |
| **Anthropic Claude Code CLI** (Max subscription) | T2 batch synthesis — aggregated batched captures | LOW call count / HIGH content | Max subscription ToS | Per current Anthropic policy, Claude Code does not train on user content. Confirm current policy — this is a trust-boundary assumption, not code-enforced. |
| **Cloudflare** (Tunnel + Email Worker) | Tunnel traffic (encrypted, metadata only) + inbound email routing | LOW | Cloudflare Free/Pro ToS | Tunnel token compromise = full API + web exposure. Email Worker handles raw inbound mail before allowlist check — Cloudflare sees content. Acceptable for personal use. |
| **Deepgram** | Voice audio | LOW volume | API ToS | Budget capped $5/mo; hardware-gated by iOS Shortcut. |
| **Composio** | OAuth tokens to Gmail, Outlook, Drive, Notion, Slack | **HIGH trust** | Free tier ToS | One vendor holds read/write tokens to five external accounts. Account compromise = multi-account compromise. No circuit-breaker if Composio itself is breached. CLAUDE.md correctly guides "direct API for writes + high volume" but read-path still depends on Composio. |
| **Pushover** | Notification titles + truncated bodies (may include capture content) | LOW | Pushover ToS | Notifications intentionally include snippet of message + "relevant captures" count. Treated as broadcast-equivalent. |
| **Gitea** (self-hosted, Tailscale-only) | Wiki markdown | LOW | Self-owned | Same trust as homeserver. |
| **GitHub** | Source, CI logs, issue/PR comments, secret scanning (GitGuardian) | LOW | GitHub ToS | LAB_NOTEBOOK.md is committed and contains detailed operational context, decision history, and occasional production debug detail — currently public visibility state of the repo matters (assumption: private or owner-only). |
| **Plaid / SimpleFIN** (future) | Financial account access tokens | HIGH (if adopted) | TBD | Currently off. Evaluate before adoption. |

**Single point of trust concentration:** Composio holds tokens for five external consumer services. This is the most consequential third-party account in the system after the LLM providers.

---

## Business Continuity Assessment

- **DR plan documented:** Partial — `scripts/backup.sh` is the canonical procedure (pg_dump custom format + config YAML + `.env.secrets` + wiki git bundle + Redis RDB). Retention is 14/4/3. Cron runs at 03:00 via host. Backup path = `/mnt/user/backup/openbrain/` on the same machine.
- **DR plan tested:** Unknown — the intake does not reference a recent restore drill. `CLAUDE.md` notes "No auto-migration on startup" and mandates manual `scripts/init-schema.sql` + `0001-0022.sql` after volume loss; this is a well-documented runbook but has never been invoked under time pressure in visible evidence.
- **Incident response process:** Ad-hoc. `LAB_NOTEBOOK.md` is the response log. Cost incident 2026-04-15 ($100+ Anthropic) was diagnosed in-session. `budget-check` job runs on a schedule and sends Pushover alerts at $30 soft / $50 hard. That **was** the fix — before the incident, cost fields in ai-routing.yaml were all zero so the circuit-breaker was blind (CLAUDE.md rule added: "verify ai-routing.yaml cost path before ANY bulk operation").
- **SLA vs architecture:** No SLA. Best-effort resilience with patient retry backoffs (30s/2m/10m/30m/2h) + daily auto-sweep at 03:00. Acceptable for single-user.

**Critical backup gaps:**

1. **Backup lives on the same machine.** `/mnt/user/backup/openbrain/` is on the same Unraid host being backed up. Single drive loss or filesystem corruption destroys both primaries and backups. No evidence of off-host copy (though LAB_NOTEBOOK references "VM cron" as canonical off-host and homeserver cron as supplemental — verify actual state; could not confirm from repo.)
2. **Backups include plaintext secrets.** `backup.sh:79-81` copies `.env.secrets` into the backup directory. Combined with on-machine storage, any backup-share read = full credential exfiltration (OPENAI, ANTHROPIC, SLACK BOT/USER/APP, DEEPGRAM, COMPOSIO, CLOUDFLARE_TUNNEL_TOKEN, PUSHOVER, GITEA, MCP bearer, ADMIN_API_KEY). Bitwarden is the source of truth but a fresh `.env.secrets` is regenerated and backed up.
3. **No verified restore procedure.** pg_dump custom format is appropriate, but there's no documented or tested "restore from backup N" runbook with success criteria.
4. **Redis RDB BGSAVE has 60s timeout then "skip."** Acceptable for small job queue, but if Redis BGSAVE ever chronically times out, the failure is logged and backup proceeds — could mask a slowly degrading Redis.

---

## Change Management Controls

- **No `CODEOWNERS` file.** Single-developer repo; direct-to-main commits are normal.
- **No branch protection on main visible** (no `.github/branch-protection*.json`, no required reviewers config). All merges are by the same operator. For single-user: acceptable.
- **CI on `main` was red for 18h** (per intake) because `pnpm -r lint` (which runs `tsc --noEmit` including tests) diverged from `tsup` build (which excludes tests). Fixed in PR #101. Highlights that lint + build should be covered by a single "passes" gate in CI, not two different type-check behaviors.
- **Secret scanning:** GitGuardian referenced in intake but no config in repo; assumed external integration.
- **Deployments are manual pull + compose up** on homeserver. No pipeline. Intake notes the homeserver was 7 PRs behind main until today — drift between main and production is undetected until an operator notices.

---

## Key Single-User Catastrophic-Loss Scenarios

This is the operative framework. Each row is a realistic loss scenario, its current mitigation, and the gap:

| Scenario | Current Mitigation | Gap |
|----------|-------------------|-----|
| **Unraid drive loss** | `backup.sh` nightly; parity in array | Backup on same host; no offsite verified |
| **Credential exfiltration from backup share** | Bitwarden is SoT | `.env.secrets` is copied in backup dir in plaintext (`backup.sh:79-81`) |
| **Cloudflare Tunnel token compromise** | Token in Bitwarden; in `.env.secrets` on host | No rotation schedule visible; no tripwire (alert if an unexpected tunnel client appears) |
| **Composio account compromise** | Per-integration OAuth scopes | Single vendor = five account blast radius; no alerting on Composio spend/usage anomalies |
| **LLM cost runaway** | `budget-check` at $30 soft / $50 hard; Pushover alerts; local `ai_audit_log` estimation fallback | Discovered 2026-04-15 that zero cost fields + wrong Jetson IP made budget blind. Fixed, but no automated test asserts that all t1_* tiers have non-zero `cost_per_1k_*` fields when `provider` is paid. Repeat-class risk. |
| **OpenAI / Anthropic account suspension** (ToS, payment failure) | None visible | All of t1_fast/t2_quality routes to Anthropic; t1_spark (Spark) is a real fallback for non-synthesis. No alarm path if paid tiers 401. |
| **Anthropic consumer-terms drift** (training opt-in default change) | None visible in code | Trust-boundary; outside code. Operator must re-verify account settings periodically. |
| **Destruction via `POST /admin/reset-data`** | Confirmation phrase `"WIPE ALL DATA"`; admin rate limiter (5 req/min) | **No `adminAuth` Bearer** (web UI cannot send). Exposed via web package on Tunnel. Confirmation phrase is in public source. Replay protection = rate limit only. If any CSRF or tunnel compromise occurs, a single POST wipes captures + entities + sessions + audit. No soft-wipe (confirm → 24h delay → execute). No automatic pre-wipe backup trigger. |
| **`POST /admin/queues/:name/clear`** | Whitelist of queue names | No adminAuth; `state: 'completed'` is legal → silently erases completion history. |
| **Slack token leak** | Bitwarden + GitGuardian | SLACK_USER_TOKEN = xoxp (user scope) can delete any message. Broader than bot scope. Justified for F35 channel cleanup but raises blast radius. |
| **Memory consolidation bad merge** | Soft-delete of originals (recoverable via `deleted_at IS NOT NULL`); `similarityThreshold 0.92`; min cluster 3; 4 AM Sundays | No cap on merges per run beyond "top 5." No undo skill. Human review not required before merges. Consolidation source type `'consolidation'` makes originals identifiable for SQL recovery, but the operator must notice the bad merge within some window; no tombstone cleanup job removes `deleted_at` rows means recovery is feasible indefinitely — that is actually a positive. |

---

## LLM Governance & Autonomy Enforcement

**Claim** (CLAUDE.md): "Autonomy levels gate all proactive features." **Reality**: `meetsAutonomyLevel()` is invoked **only in `packages/slack-bot/src/handlers/auto-response.ts`** (two sites: assist-mode DM + advise-mode threaded reply). No other proactive path checks autonomy:

- `daily-sweep-skill` (8 PM LLM summary) — no autonomy check; runs regardless of level.
- `weekly-brief` — no autonomy check; sends email/Pushover regardless.
- `memory-consolidation` — no autonomy check; soft-deletes + merges regardless.
- `email-compose` with `send_mode: 'auto-send'` — fires via Himalaya directly (`email-draft.ts:142-152`). **The `send_mode` flag is caller-specified, not autonomy-gated.** A caller (skill, Slack command, API) can request auto-send at any configured autonomy level including default `observe`.
- Auto-response-draft (buttons that let the owner "send as-is" from Slack) — requires owner approval, so autonomy is de-facto respected there.
- Daily connections / drift monitoring / wiki ingest — no autonomy check.

**This is a consistency finding, not necessarily a bug.** For a single-user personal system the owner chose what runs. But the CLAUDE.md rule and README framing imply uniform enforcement. Either:

1. **Tighten:** Have every proactive skill read `app_settings.autonomy_level` at entry and no-op / degrade to notification-only below the threshold. Cleanest.
2. **Reframe docs:** Acknowledge explicitly that autonomy gating applies only to Slack auto-response; proactive skills are enabled/disabled via scheduling not autonomy.

Either is acceptable. Silent divergence between doc claims and runtime behavior is the finding.

---

## Data Export and Portability

- **Database:** pg_dump custom format in `backup.sh` is reversible anywhere with Postgres 16 + pgvector. Good.
- **Capture-level export:** No `GET /api/v1/captures/export` or equivalent. Direct SQL only. Not a practical gap for a single user but means there is no "one-command export my whole brain as JSON" path.
- **Wiki:** Git bundle in backup = full history. Good.
- **Redis:** RDB snapshot. Good for queue state recovery.
- **Embeddings:** Re-embed-able from content; no lock-in risk.
- **Entity graph / associations:** Export only via SQL. Reasonable.

Format lock-in is low. Provider lock-in (OpenAI embeddings with `dimensions: 768` MRL parameter) is medium — switching providers requires re-embedding the corpus (one-time, non-trivial).

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 6 |
| Low | 5 |

### HIGH

- **H1. Backups include plaintext `.env.secrets` and live on the same host.** `backup.sh:79-81` copies all secret env files into the backup dir; dir is on the same Unraid XFS share. Any read of `/mnt/user/backup/openbrain/` exfiltrates the full credential set (OpenAI, Anthropic, Slack user+bot+app, Deepgram, Composio, Cloudflare Tunnel, Pushover, Gitea, MCP, ADMIN_API_KEY). Combined with no verified offsite copy (intake hints at VM cron but not confirmed), a single host compromise or drive failure is both a primary-data loss AND a credential compromise. Either encrypt the backup archive (age / gpg to a key stored OUTSIDE the host) or stop copying secrets entirely (Bitwarden is source of truth; re-seed on restore).
- **H2. `POST /admin/reset-data` is exposed via public tunnel without Bearer auth.** Authentication is a JSON confirmation phrase in public source + 5 req/min rate limit. One successful unauthenticated POST TRUNCATEs captures, entities, sessions, pipeline_events, and `ai_audit_log`. There is no pre-wipe automated snapshot, no soft-wipe (mark-then-execute), and no audit row — only a pino log line and Loki's 30-day retention. Mitigations: add a mandatory pre-wipe automated `pg_dump` (synchronous, check exit code), stage as "pending wipe, confirm again within 10 minutes," AND write an immutable `admin_audit_log` row before executing. Even in single-user context, the default should be "no single API call can destroy everything."
- **H3. Autonomy-level gating is not enforced across proactive features.** `meetsAutonomyLevel()` guards Slack auto-response only. `email-compose` `auto-send`, `memory-consolidation`, `daily-sweep-skill`, `weekly-brief`, and other scheduled skills run regardless of `app_settings.autonomy_level`. CLAUDE.md claims "Autonomy levels gate all proactive features." Either enforce uniformly (every skill reads autonomy at entry) or reframe the documentation. Risk: a user setting autonomy to `observe` expecting no proactive actions still gets outbound emails on auto-send, weekly briefs, and overnight memory-consolidation merges.

### MEDIUM

- **M1. Direct Anthropic SDK calls bypass `ai_audit_log`.** `memory-consolidation` and `weekly-brief` (direct path) call `callClaude` without guaranteed `ai_audit_log` row; budget estimation (local fallback) under-counts these calls, potentially masking drift beyond the $30/$50 thresholds. Already an intake-flagged follow-up; confirmed via grep. Route through LLMGatewayService or ensure `callClaude` always writes an audit row.
- **M2. No hard-delete / retention job for supporting tables.** `pipeline_events`, `mcp_activity`, `session_messages`, `ai_audit_log`, `activity_feed`, `container_health` grow unbounded. Low urgency given homeserver capacity, but eventually VACUUM / partition / prune is needed. Also affects any future right-to-erasure scenario for correspondents.
- **M3. No audit row for admin actions.** reset-data, queue clear, banner set/delete, Slack channel archive all log to pino only. On a 30-day Loki retention, a month-old forensic question cannot be answered. A lightweight `admin_audit_log` table (actor placeholder, action, request body hash, timestamp, outcome) is cheap insurance.
- **M4. Cost-field regression has no regression test.** 2026-04-15 cost incident root cause — zero `cost_per_1k_*` values in ai-routing.yaml — is now fixed but not asserted. Add a config-loader unit test: any `provider: anthropic|openai|openai_compat` tier must have non-zero `cost_per_1k_input` and `cost_per_1k_output` when routed to paid endpoints. Same class of bug can recur on the next tier addition.
- **M5. Email worker rejections are not centrally logged.** Cloudflare Email Worker 403s non-allowlisted senders without a durable log accessible from the dashboard. Adding an allowlist entry later requires either memory or Cloudflare logs. A small "rejected_senders" bounded buffer (last 100 rejections with timestamps) would help.
- **M6. Composio is a single point of multi-account compromise.** One compromise = Gmail + Outlook + Drive + Notion + Slack. The current "Composio for reads + low volume" rule is right. Consider revoking write scopes on all Composio OAuth grants and documenting that write operations go direct. Add a monthly check: log Composio account usage delta; alert if > 50 calls/day unexpectedly.

### LOW

- **L1. Anthropic/OpenAI account-level settings live outside the repo.** Training opt-out, zero-retention org settings, API plan tier. Document in a runbook (e.g., `docs/PROVIDER_SETTINGS.md`) the required-state of each provider account; add to monthly audit checklist.
- **L2. No CODEOWNERS / branch protection.** Acceptable single-user; flag in case the repo goes multi-contributor.
- **L3. `LAB_NOTEBOOK.md` is detailed and committed.** 449 KB of operational context, debug transcripts, and decision history. If the repo is ever made public, scrub for host names, IP addresses, and any third-party PII that crept into debug log pastes. A grep for `@`, IPs (`192.168.\d+.\d+`, public IPs), and phone patterns would take minutes.
- **L4. No documented vendor ToS review cadence.** OpenAI and Anthropic policies change. A quarterly or bi-annual read-through (15 minutes) should be on the calendar; currently nothing schedules it.
- **L5. Pushover notifications include capture snippets.** Treating Pushover as broadcast-equivalent is fine; worth calling out in the same runbook as L1 so an operator can opt-out if family members see the phone screen.

---

## Recommended Priorities (single-user catastrophic-loss frame)

1. **H1 first.** Encrypt or stop backing up `.env.secrets`. This is the single biggest blast-radius vulnerability in the system. 1-2 hours of work.
2. **H2 second.** Add pre-wipe automated backup + admin audit row on reset-data. 2-3 hours.
3. **M4 + H3 together.** Formalize the "no-zero-cost-field" test and decide whether autonomy gates all proactive skills or only Slack auto-response. Both are documentation-reality alignment issues.
4. **M1, M3** together. Route `memory-consolidation` and `weekly-brief` through LLMGatewayService (already intake-flagged); add `admin_audit_log`. One-day of cleanup.
5. **L1, L3, L4** are checklist items, not engineering.

Everything else (M2, M5, M6, L2, L5) is good hygiene for year 2 of operation — not urgent.
