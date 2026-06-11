# Risk & Compliance Findings

**Reviewer:** Risk & Compliance
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High
**Note:** Compliance assessment is based on code and configuration analysis only (plus one read-only live check of the homeserver crontab). Legal/regulatory determination requires qualified legal review. For a single-user, self-hosted system the operative risk frame is catastrophic loss (data destruction, credential compromise, vendor account loss, cost runaway) plus third-party PII stewardship — not enterprise audit readiness.

This report supersedes the 2026-04-18 Risk & Compliance review. Section "Prior-Review Closure Verification" records what was verified closed vs. carried forward.

---

## Prior-Review Closure Verification (2026-04-18 → 2026-06-10)

| Prior finding | Status | Evidence |
|---------------|--------|----------|
| H1 (part 1): backups include plaintext `.env.secrets` | **CLOSED** | `scripts/backup.sh:78-80` explicitly excludes `.env.secrets`; regression guard `scripts/test-backup-secrets-redaction.sh`; BWS round-trip tooling (`load-secrets.sh`, `verify-secrets.sh`, `test-secrets-roundtrip.sh`) per P04b/P08. |
| H1 (part 2): backup lives on the same host, no offsite | **OPEN** → re-raised as RC-1 (High) | See RC-1. TDD documents offsite rclone-crypt that does not exist in the repo or homeserver cron. |
| H2: `reset-data` single-call destruction, no audit, no pre-wipe backup | **CLOSED** | P04a: two-step 5-min single-use Redis token + `confirm: "WIPE ALL DATA"` + origin allowlist + fail-closed NODE_ENV; pre-wipe `pg_dump` aborts the wipe on failure (`admin.ts:229-244`); every attempt writes `admin_audit` (migration 0023); `admin_audit` excluded from TRUNCATE with code-level test. Bearer-auth absence is an accepted, documented posture with compensating controls — not re-reported. |
| H3: autonomy gating not enforced across proactive skills | **CLOSED** | P05: `BaseSkill.execute()` checks `static minimum_autonomy` before `run()` (`base-skill.ts:79-85`); per-skill declarations present (email-compose `advise`, memory-consolidation `assist`, etc.). |
| M1: `callClaude` bypasses `ai_audit_log` | **CLOSED** | P02b: `callClaude` removed; zero non-test hits in `packages/`; all skills route through `LLMGatewayService.completeByTask()`. |
| M2: no retention / hard-delete for soft-deleted captures and event tables | **OPEN** → carried as RC-4 (Medium) | Only `prune-associations` (Hebbian edges) and `storage-audit` (size monitoring) exist in `scheduler.ts`. |
| M3: no DB audit row for admin actions | **CLOSED** | `admin_audit` table (migration 0023) with event_type/actor/created_at indexes; CF Access email forwarded for actor attribution. |
| M4: no regression test for zero cost fields in ai-routing.yaml | **CLOSED** | `packages/shared/src/services/ai-config-schema.ts:41-52` — `ConfigService.load()` throws fail-fast when paid-provider tiers lack `cost_per_1k_input`/`cost_per_1k_output`. |
| M5: email worker rejections not durably logged | **OPEN** → carried as RC-7 (Low) | `cloudflare/email-worker/src/index.ts:93` — `console.log` only (ephemeral CF worker logs). |
| M6: Composio single point of multi-account trust, no usage alerting | **CLOSED (controls added)** | P03: `composio-client.ts` quota meter — Redis monthly counter, hard stop at 19,000 calls, Pushover warn at 15,000. Trust-concentration on Composio itself remains inherent and accepted. |
| L1 + L4: provider account settings / ToS review cadence undocumented | **OPEN** → carried and elevated as RC-5 (Medium) | No `docs/PROVIDER_SETTINGS.md` or equivalent found; no training-opt-out / retention documentation; elevation justified because health data now flows to vendors (RC-3). |
| L2: no CODEOWNERS / branch protection | **CLOSED (deliberate posture)** | Branch protection configured Phase 5b (one required check, `enforce_admins=false`, no required reviews) — documented solo-operator decision. Could not verify live (gh CLI unauthenticated in this environment — RI-1). |
| L3: LAB_NOTEBOOK operational detail committed | **OPEN** → carried as RC-8 (Low) | LAB_NOTEBOOK.md now 162+ entries; repo visibility could not be verified (gh unauthenticated). |
| L5: Pushover receives capture snippets | Folded into vendor register; accepted. | — |

---

## Detected Regulatory Scope

| Framework | Applies? | Reason |
|-----------|----------|--------|
| GDPR / UK-GDPR | **Marginally** | US operator, personal household activity (Art. 2(2)(c) household exception analog). Residual exposure: third-party correspondents' PII (email bodies, meeting/voice transcripts naming colleagues and clients) is processed and transmitted to OpenAI/Anthropic. Troy is a consultant — client-confidential material can enter via email/voice capture; the binding obligations there are **contractual (client MSAs/NDAs)**, not statutory. |
| CCPA/CPRA | No | Not a business; no sale/sharing thresholds met. |
| HIPAA | No | Not a covered entity or business associate. **However** (new since prior review): the system now stores structured personal health data — `lab_results` (migration 0028: test names, LOINC codes, values, ordering provider) and health `insurance_policies` (migration 0029: policy numbers, insured names, coverage trees). HIPAA does not attach to an individual managing their own records, but the data sensitivity class changed materially — see RC-3. |
| PCI-DSS / SOX | No | No cardholder data, no regulated financial reporting; financial CSVs are personal records. |
| FTC Act §5 | Indirect | Only relevant if commercialized. |

**Effective control frame:** catastrophic-loss avoidance + third-party PII / client-confidentiality stewardship + vendor data-sharing hygiene.

---

## Compliance Control Mapping

| Control Area | Framework | Status | Evidence | Gap |
|-------------|-----------|--------|----------|-----|
| Access control | Household | **Good (accepted posture)** | CF Tunnel + CF Access perimeter; MCP Bearer; mobile Bearer (`mobile-auth.ts`: timing-safe compare, fail-closed 503 on missing key, dedicated 200 req/min rate tier); admin reset two-step token + origin allowlist + fail-closed NODE_ENV; rate-limit caller-spoofing defense (`isInternalIp()`). | Mobile token is a single static shared secret with no rotation/revocation procedure (RC-6). |
| Audit logging | Household | **Good** | `admin_audit` (0023, TRUNCATE-excluded, code-asserted), `ai_audit_log` (real per-tier costs since P03), `skills_log` (incl. gated-status records), `pipeline_events`, `mcp_activity`, capture provenance (`source` 9-value CHECK, 0022). | Failed mobile/MCP auth attempts and email-worker rejections persist only in pino/Loki (30d) — no durable security-event log (RC-6, RC-7). |
| Data encryption at rest | Household | **Absent (accepted)** | Postgres/Redis/backups on Unraid XFS, no disk encryption indicated. TDD §4245 acknowledges and rests on physical+network security — defensible for a home server. | TDD claims "Offsite backups encrypted via rclone crypt" — that offsite path does not exist (RC-1). |
| Data encryption in transit | Household | **Good** | CF Tunnel TLS for all public ingress; vendor APIs over HTTPS; Tailscale (WireGuard) for remote hardware; Postgres confined to Docker bridge. | None material. |
| Data retention | Household | **Partial** | Backup retention 14/4/3; Loki 720h; soft-delete (`deleted_at`) on captures; pre-wipe dumps in dedicated volume. | No hard-delete/prune for soft-deleted captures, `pipeline_events`, `mcp_activity`, `ai_audit_log`, `activity_feed` — unbounded growth, no purge path for any future erasure need (RC-4). |
| Right to erasure | GDPR-adjacent | **Absent (low exposure)** | `DELETE /api/v1/captures/:id` is soft-delete only. | No "purge all content mentioning person X" capability across captures + embeddings + entity graph + associations + audit tables (RC-9). Household context makes this Low. |
| Breach notification readiness | Household | **Informal** | Pushover alerting, runbooks for operational alerts. | No inventory of whose PII is held (correspondents/clients); no "homeserver compromised — who do I owe a heads-up" checklist. Accepted at this scale; noted, not counted. |
| Vendor agreements (DPA) | Household | **N/A — consumer/API tiers** | API-mode usage for OpenAI/Anthropic (no consumer chat products in the data path). | Provider retention/training-opt-out settings live outside the repo, undocumented and unverified (RC-5, RI-2). |

---

## Audit Trail Assessment

**Strong and materially improved since 2026-04-18.** Destructive admin operations now write durable `admin_audit` rows for every attempt (requested/executed/blocked/error) with actor attribution via the CF Access email header, and the table is excluded from the wipe itself with a code-level invariant test. LLM spend attribution is complete: `callClaude` is gone, all inference flows through `LLMGatewayService`, and `estimateTierCostUsd()` reads real per-tier costs (explicit-zero canonical for free tiers, fail-fast on missing fields). Skill executions — including autonomy-gated no-ops (`status: 'gated'`) — land in `skills_log`. Pipeline stage transitions land in `pipeline_events` with CHECK-constrained enums. Capture provenance is enforced at the DB level (9-value `source` CHECK).

**Remaining gaps:**

1. **Security-event durability.** Failed Bearer attempts (mobile, MCP), malformed auth headers, and rate-limit denials are pino log lines only — Loki's 30-day retention is the entire forensic window, and the Docker Loki driver drops (not buffers) lines when Loki is unreachable. A month-old "was someone probing the tunnel?" question cannot be answered. (RC-6)
2. **Email-worker rejections** are `console.log` in the Cloudflare worker — effectively unlogged. (RC-7)
3. **Mobile token lifecycle has no audit events** — there is no issuance/rotation/revocation to audit because the token is a static env var. (RC-6)

---

## Data Residency Assessment

All primary data resides on the US home server (`/mnt/user/appdata/open-brain/`). No cross-border transfer obligations attach (US operator). Loki log sink is LAN (`homeserver.k4jda.net:3100`). Gitea wiki is Tailscale-only, self-hosted. No data leaves the US except incidentally via global vendor infrastructure (Cloudflare).

**Vendor data flows (what actually leaves the house):**

- **OpenAI** — every capture's full text (embeddings) + prompt content for all routed inference. Highest-volume flow. Now includes embeddings of health/insurance **synthesis captures** (RC-3).
- **Anthropic (Claude Code CLI, Max subscription)** — T2 batch synthesis prompts, including **full structured lab-result payloads** (`scripts/lab-report-synthesis.py`) and **insurance coverage data** (`scripts/insurance-gap-analysis.py` calls `claude --print`). Anthropic's stated policy is no training on this traffic — a trust-boundary assumption, not code-enforced, and undocumented in-repo (RC-5).
- **Deepgram** — voice audio (capped spend).
- **Cloudflare** — raw inbound email content transits the Email Worker pre-allowlist; tunnel sees encrypted traffic metadata; CF Access sees identity.
- **Slack** — channel messages and bot interactions (inherent).
- **Composio** — OAuth tokens to external accounts; quota-metered (19K hard stop).
- **Pushover** — notification titles + capture snippets (accepted broadcast-equivalent).
- **Bitwarden** — entire secret inventory (its job).
- **GitHub** — code, CI logs, LAB_NOTEBOOK operational detail (RC-8 if visibility is ever public).

---

## Third-Party Risk Register

| Vendor | Data Shared | Risk Level | DPA/SCC in Place? | Finding |
|--------|------------|------------|------------------|---------|
| OpenAI | All capture text (embeddings + inference), incl. synthesized health/financial summaries | **High** (volume + sensitivity + no fallback) | No (API ToS) | Single point of failure by design (no fallback embeddings — queue and retry). Retention/training settings unverified (RC-5). Provider switch requires corpus re-embed (medium lock-in). |
| Anthropic (Claude CLI) | Aggregated batch synthesis incl. full lab results, insurance coverage | **High sensitivity / low volume** | No (Max subscription ToS) | Health data now in prompt payloads (RC-3); policy posture undocumented (RC-5). |
| Cloudflare | Inbound email content (worker), tunnel metadata, CF Access identity | Medium | No (consumer ToS) | Ingress single point of failure; tunnel-token compromise = full exposure; token in BWS, staleness monitored by `secret-rotation` skill (90-day alert) — good. |
| Deepgram | Voice audio | Low | No | Spend-capped; low volume. |
| Slack | Messages, bot tokens | Medium | No | `SLACK_USER_TOKEN` (xoxp) blast radius noted previously; accepted for F35. |
| Composio | OAuth tokens to Gmail/Outlook/Drive/Notion/Slack | **High trust concentration** | No (free tier) | Quota meter + Pushover alerting added (P03) — prior M6 closed. Multi-account blast radius remains inherent; "reads only, writes direct" rule is the right compensating control. |
| Pushover | Notification snippets | Low | No | Accepted. |
| Bitwarden (BWS) | All secrets | High trust (appropriate) | No | Single key-person dependency on the BWS access token + the operator's vault credentials — bus-factor-1 reality (see BCP). |
| GitHub | Code, LAB_NOTEBOOK, CI logs | Low–Medium | No | Verify repo is private; scrub LAB_NOTEBOOK before any visibility change (RC-8). |
| Gitea (self-hosted) | Wiki markdown | Low | Self | Same trust domain as homeserver. |

---

## Business Continuity Assessment

- **DR plan documented: Yes** — `scripts/backup.sh` (manifest + row counts), `scripts/restore-rehearsal.sh`, `docs/runbooks/restore-rehearsal.md`, `deploy/cron/unraid-restore-rehearsal.cron`, secrets rebuild runbook (P08: `load-secrets.sh` single-command rebuild from BWS). Genuinely good for this scale.
- **DR plan tested: NO — automation designed but not installed.** Live check of the homeserver crontab (2026-06-10) shows the nightly backup (`0 3 * * *`) installed but **no restore-rehearsal entry**. The P16 weekly rehearsal (ephemeral pg_restore + row-count validation + Pushover pass/fail) has been a "pending homeserver op" since ~2026-04-19 — ~7 weeks of backups whose restorability has never been machine-verified (RC-2).
- **Offsite backup: MISSING.** `BACKUP_ROOT=/mnt/user/backup/openbrain` is on the same Unraid host as the primaries. TDD (lines ~4040, ~4245) documents "Weekly offsite to Google Drive via rclone (30-day cloud retention)" and "Offsite backups encrypted via rclone crypt" — no such script, cron, or config exists in the repo or the homeserver crontab (`scripts/setup-rclone.sh` is the OneDrive *ingest* mirror, unrelated). One host-level event (fire, theft, filesystem corruption, ransomware) destroys primaries and all backups together (RC-1).
- **Incident response process: Partial** — runbooks exist for budget/capture-flow/container-health/pipeline/integration alerts; LAB_NOTEBOOK is the incident record (the 2026-04-15 cost incident was handled and converted into durable controls — the system demonstrably learns). No formal IR doc; acceptable at this scale.
- **SLA commitments vs architecture capability: Aligned** — no SLA; best-effort with patient retry + sweeps is appropriate.
- **Bus factor: 1, structurally.** Single operator, single host, secrets behind one Bitwarden account. Recovery-from-nothing depends on the operator + BWS access token. Accepted reality for a personal system; the P08 runbook at least makes recovery mechanical. Not counted as a finding.

---

## Change Management Controls

- **Branch protection (per CLAUDE.md Phase 5b):** one required status check ("Integration tests (core-api + real DB)"), `enforce_admins=false` (solo escape hatch), no required reviews. Deliberate, documented, proportionate. Could not verify live — gh CLI in this review environment is unauthenticated (RI-1; note CLAUDE.md's own warning that gh can silently switch accounts).
- **No CODEOWNERS** — appropriate for one contributor.
- **LAB_NOTEBOOK.md as change record:** unusual but real and enforced (blocking precondition for commits, 162+ entries, decision log with supersession). A genuine compensating control for the absent review gate — arguably stronger evidence of change rationale than most enterprise PR templates produce.
- **Deploys:** manual pull + compose on homeserver. Drift between main and production was previously undetected for weeks (31-commit gap closed 2026-05-09); no drift alarm exists. Minor; not counted separately — RC-2 is the operative instance of the "designed control not deployed" pattern.

---

## Findings Detail

### High

- **RC-1 — No offsite backup; TDD documents one that doesn't exist.** Backups, pre-wipe dumps, and primaries share one physical host. TDD claims weekly rclone-crypt offsite to Google Drive; nothing implements it (repo + live crontab checked). This is the largest remaining catastrophic-loss exposure and also a doc-vs-reality integrity gap. Remediation: implement the documented rclone-crypt weekly sync (encryption key stored in BWS, *not* on the host) or amend the TDD; either way, reconcile.
- **RC-2 — Restore rehearsal designed but not running.** `restore-rehearsal.sh` + runbook + cron file shipped in P16; the cron is not installed on the homeserver (verified live 2026-06-10: `crontab -l` shows only the 03:00 backup). Backups are unvalidated in practice — exactly the failure mode the rehearsal exists to catch. Remediation: one SSH session per the cron file's own install instructions; confirm the first Sunday pass notification.

### Medium

- **RC-3 — Health and insurance data entered the system without a sensitivity-classification update.** `lab_results` (0028) and `insurance_policies` (0029) hold structured medical lab values (with ordering provider) and policy/insured details; both flow to Anthropic via `claude --print` synthesis, and synthesis captures are embedded via OpenAI. `docs/SECURITY.md` is scoped solely to prompt injection; no document inventories data classes or vendor flows. Remediation: a one-page data-classification + vendor-flow table in docs (could live in SECURITY.md §0), so future data sources get classified deliberately.
- **RC-4 — No retention/hard-delete for soft-deleted captures and event tables** (carried from M2). `pipeline_events`, `mcp_activity`, `ai_audit_log`, `activity_feed`, and `deleted_at` captures grow unbounded; `storage-audit` monitors size but nothing prunes. Also forecloses any practical erasure capability (RC-9).
- **RC-5 — Provider account posture undocumented and unverified** (carried from L1+L4, elevated by RC-3). OpenAI org retention/training settings, Anthropic policy assumptions, and a ToS re-review cadence exist nowhere in the repo. Now that lab data rides these channels, a `docs/PROVIDER_SETTINGS.md` recording required-state per vendor + a quarterly review reminder is warranted.
- **RC-6 — Mobile bearer token has no lifecycle, and security events are ephemeral.** `MOBILE_API_KEY` is one static shared secret on a public Cloudflare-tunnel-exposed boundary: no expiry, rotation procedure, or per-device revocation; failed auth attempts (mobile, MCP) persist only in Loki (30d, drop-on-unreachable). Compensating controls are good (timing-safe compare, fail-closed 503 on missing key, dedicated rate tier, token-hash logging). Remediation: document a rotation procedure (ensure `MOBILE_API_KEY` is in BWS so the `secret-rotation` skill's 90-day staleness alert covers it), and consider mirroring auth failures into a durable table or longer-retention Loki stream.

### Low

- **RC-7 — Email-worker rejections unlogged** (carried from M5). `console.log` only; a bounded rejected-senders buffer surfaced in the dashboard would close it.
- **RC-8 — LAB_NOTEBOOK/repo-visibility hygiene** (carried from L3). The notebook contains hostnames, LAN IPs, Tailscale names, and operational detail. Fine while private; scrub before any visibility change. Repo visibility could not be verified this session.
- **RC-9 — No erasure capability for third-party PII** (carried). Soft-delete only; no person-scoped purge across captures/embeddings/entities/associations. Household exposure is low; a client-confidentiality request is the realistic trigger.

### Requires Investigation

- **RI-1 — Branch protection live state and repo visibility** could not be confirmed (gh CLI unauthenticated in this environment). Both are documented; verify with `gh auth status`, then `gh api repos/davistroy/open-brain/branches/main/protection` and `gh repo view --json visibility`.
- **RI-2 — OpenAI/Anthropic account-level retention and training-opt-out settings** live outside the repo and could not be inspected. Resolve in the course of RC-5.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 3 |
| Requires Investigation | 2 |

---

## Recommended Priorities

1. **RC-2 (minutes of work):** install the rehearsal cron — the control is already built.
2. **RC-1 (half a day):** implement the documented offsite rclone-crypt sync, key in BWS.
3. **RC-3 + RC-5 together (an hour of writing):** data-classification table + provider-settings runbook + quarterly ToS reminder.
4. **RC-4, RC-6:** schedule for the next hygiene wave.
5. RC-7/8/9 and RI items: checklist work, not engineering.

The control trajectory since the 2026-04-18 review is strongly positive: 8 of 11 substantive prior findings verified closed with durable, tested mechanisms (admin audit, autonomy gates, secrets-free backups, cost fail-fast, Composio metering). The two High findings here are both "last mile" — controls that were designed and documented but never switched on.
