# Risk & Compliance Findings

**Reviewer:** Risk & Compliance
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High
**Note:** Compliance assessment is based on code and configuration analysis only (plus authenticated read-only `gh` API checks of repo visibility and issue state). Legal/regulatory determination requires qualified legal review. For a single-user, self-hosted system the operative risk frame is catastrophic loss (data destruction, credential compromise, vendor account loss, cost runaway) plus third-party PII / client-confidentiality stewardship — not enterprise audit readiness.

This is the v5 review, superseding 2026-07-09 (v4). The only code merged since v4 is the Dependabot dependency remediation (PRs #232–#234, Entry 183, D134) plus the Dependabot grouped-updates config (`cd14c1f`). Accordingly this cycle is dominated by adjudication: **every v4 Risk & Compliance finding is STILL OPEN**, and the operator-action backlog pattern flagged as a meta-observation in v4 has now produced a concrete production control failure (A135 deadline missed) — it is formalized as a finding this cycle (RC-19).

---

## Prior-Review Adjudication (v4 2026-07-09 → v5 2026-07-12)

| v4 Finding | v5 Status | Evidence |
|------------|-----------|----------|
| **RC-10 (High)** — repo PUBLIC, decision unowned | **STILL OPEN** | Verified live this session: `gh repo view davistroy/open-brain` → `"visibility":"PUBLIC"`. No commit since v4 touches visibility or scrubs LAB_NOTEBOOK/topology content. The unmade decision is now ~2 weeks past the Phase 10.4 flag with a v4 High finding on record. LAB_NOTEBOOK has grown to 184 entries (Entry 183 adds deploy digests + homeserver service inventory to the public record). |
| **RC-11 (Medium)** — voice Bearer warn-and-allow, secret unset in prod | **STILL OPEN** | `packages/voice-capture/src/server.ts:19-21` unchanged (warn "POST /api/capture is UNAUTHENTICATED (pre-rollout warn-and-allow)"). No LAB_NOTEBOOK entry records provisioning `VOICE_CAPTURE_SECRET`; A137 still lists "voice Bearer phase 2" as remaining roadmap. Interim posture now ~6 weeks old with no expiry set. |
| **RC-12 (Medium)** — scheduled offsite/rehearsal runs never verified (A131) | **STILL OPEN** | Action item A131 (dated 2026-06-11, priority HIGH) remains open in LAB_NOTEBOOK (line 154). Now **~4.5 weeks** of unconfirmed scheduled runs; still no success-heartbeat or backup-age alert (silence remains indistinguishable from success). |
| **RC-13 (Medium)** — secret-rotation skill inert (no `BWS_ACCESS_TOKEN` in workers); Gmail OAuth re-consent pending | **STILL OPEN** | `BWS_ACCESS_TOKEN` still appears only as a comment (`docker-compose.yml:469`), still absent from `deploy/.env.secrets.template`. No notebook entry records provisioning the token or completing the Gmail re-consent. 90-day staleness alerting for all secrets remains non-functional. |
| **RC-14 (Low)** — change-tracking layer drift | **STILL OPEN, slightly worse** | Issue #226 still OPEN (verified via `gh`) though fixed in PR #230; `OPEN_ITEMS.md` still says "Last reconciled: 2026-06-30" and still claims A132 "Waves 3–4 remain" (shipped in June); `doc-sync` CI still `continue-on-error: true` (ci.yml:235); 24 remote branches; `._*`/`.DS_Store` junk now visible untracked in `git status`. |
| **RC-15 (Low)** — soft-deleted captures never hard-purged | **STILL OPEN** | `RETENTION_POLICY` (`data-retention-prune.ts:29-35`) covers 5 event tables only; `captures` with `deleted_at` absent. |
| **RC-16 (Low)** — email-worker rejections unlogged | **STILL OPEN** | `cloudflare/email-worker/src/index.ts:108-109,209` — rejections still `console.log` + `setReject` only. PR #232 touched only the worker's lockfile (npm audit fix), not logging. |
| **RC-17 (Low)** — no erasure capability for third-party PII | **STILL OPEN** | `captures.ts:100` — DELETE remains `softDelete()` only; no person-scoped purge across captures/embeddings/entity graph/associations/backups. |
| **RC-18 (Low)** — security-event durability (Loki-only, 30d, drop-on-unreachable) | **STILL OPEN** | No `security_events` table or `admin_audit` mirroring added; no migration since 0035. |
| **RI-3** — provider account-level retention/opt-out settings unverified | **STILL OPEN** | `docs/PROVIDER_SETTINGS.md` retains the "verify with current Enterprise vs. standard terms" (OpenAI) and "confirm under current plan" (Deepgram) placeholders. Quarterly review due ~2026-09-30. |
| **v4 meta-finding** — post-merge operator actions sit unowned for weeks | **MATERIALIZED — formalized as RC-19 (High)** | The pattern predicted a control failure; one occurred: A135's hard deadline (Sun 2026-07-12 02:00) passed today with no fix merged. See RC-19. |

**Cross-domain v4 items in this domain's blast radius (counted in their owning domains, adjudicated here for the record):**

| Item | v5 Status | Evidence |
|------|-----------|----------|
| **DA-1 / A135 (High, Data)** — skills_log retention prune FK-blocked by `briefs.source_skill_log_id` (no ON DELETE) | **STILL OPEN — deadline PASSED** | No migration 0036 exists; `pruneRetentionData()` still has no per-table isolation (one FK violation aborts the loop; `skills_log` is last in `RETENTION_POLICY`, so earlier tables still prune, but the job fails and `retention_audit` is silently incomplete for skills_log — `init-schema.sql:1816` confirms the bare FK). The action item's own deadline — "before Sun 2026-07-12 02:00" — was **this morning**; the scheduled run has now presumably failed again in production (unverifiable without homeserver access). The audit-trail retention control (RC-4's closure mechanism) is partially broken and its failure is invisible except in BullMQ job state / Loki. |
| **PLT-C1 / A134 (Critical, Platform)** — deploy.md rollback re-arms the data-loss landmine | **STILL OPEN** | `docs/runbooks/deploy.md` §5 unchanged: `cat > .../docker-compose.override.yml` **overwrites** the production override that pins postgres/redis raw binds (ADR-0004), and "Remove override when done" then `rm`s it entirely — after which any recreate of postgres/redis lands on empty named volumes. This is the documented BC/DR rollback procedure being itself a data-loss vector. A134 is flagged "CRITICAL — before next deploy/incident"; a deploy (Entry 183) has since occurred — fortunately without needing rollback. |
| **SEC-A1 / A136 (High, Security)** — voice-pipecat `ws://0.0.0.0:8765` zero-auth | **STILL OPEN** | A136 open in action items; no compose/code change since v4. Same "risk-acceptance predicated on an absent control" family as RC-11. |

**New positive evidence since v4 (governance credit, uncounted):**
- **Dependabot remediation executed with model discipline (Entry 183, D134):** 119 → 20 open alerts, **0 critical**, in three isolated waves (transitive refresh / nodemailer 9 / vitest 3), each independently revertible; deployed to homeserver at `sha-31bc56c` with digest-verified rollback anchors and postgres/redis untouched; residual dev-scope `vite` high tracked as A139 with rationale. This upgrades the v4 vendor-supply-chain context note materially.
- **`cd14c1f` enables Dependabot grouped updates + automated security fixes** — converts one-off remediation into a standing cadence control (9 grouped PRs already open).
- The Entry 183 deploy followed the config-diff-gate procedure — the change-management control is being used, not just documented.

---

## Detected Regulatory Scope

Unchanged from v4; re-validated. No new data types, vendors, or geographies entered the system in the 3-day window (dependency-only changes).

| Framework | Applies? | Reason |
|-----------|----------|--------|
| GDPR / UK-GDPR | Marginally | US operator, personal/household activity. Residual exposure: third-party correspondents' PII (email bodies, transcripts naming colleagues/clients) transmitted to OpenAI/Anthropic. Operator is a consultant — client-confidential material can enter via email/voice; binding obligations are **contractual (client MSAs/NDAs)**, not statutory. |
| CCPA/CPRA | No | Not a business. |
| HIPAA | No | Not a covered entity/BA. Structured health data (`lab_results`, `insurance_policies`) classified and flow-mapped (PROVIDER_SETTINGS.md §2); no embedding column, never reaches OpenAI directly. |
| PCI-DSS / SOX | No | No cardholder data; personal financial records only. |
| FTC Act §5 | Indirect | Only if commercialized. |

**Effective control frame:** catastrophic-loss avoidance + third-party PII / client-confidentiality stewardship + vendor data-sharing hygiene + public-repo information-disclosure hygiene (RC-10).

---

## Compliance Control Mapping

| Control Area | Framework | Status | Evidence | Gap |
|-------------|-----------|--------|----------|-----|
| Access control | Household | **Good (accepted posture), two inert controls** | CF Tunnel + CF Access; MCP Bearer; mobile Bearer (fail-closed); admin reset two-step + origin allowlist + fail-closed NODE_ENV; `isInternalIp()` spoof defense; queue-clear origin-guarded (SEC-04). | Voice Bearer still warn-and-allow, secret unset (RC-11, ~6 weeks); voice-pipecat zero-auth (SEC-A1, security domain). |
| Audit logging | Household | **Good design, one broken limb** | `admin_audit` (TRUNCATE-excluded + prune-excluded, both code-asserted); `retention_audit` (0035); `ai_audit_log` real costs; `skills_log`; CHECK-constrained `pipeline_events`. | **Retention prune itself failing on skills_log FK (DA-1)** — `retention_audit` silently incomplete; failed-auth events still Loki-only 30d drop-on-unreachable (RC-18); email-worker rejections ephemeral (RC-16). |
| Data encryption at rest | Household | **Good** | Primaries unencrypted on Unraid (accepted); offsite rclone-crypt (contents + filenames), keys only in BWS + obscured rclone.conf. | None new. Key loss = offsite undecryptable (accepted, bus-factor note). |
| Data encryption in transit | Household | **Good** | CF Tunnel TLS; vendor HTTPS; Tailscale; Postgres/Redis loopback-bound. | None material. |
| Data retention | Household | **Degraded since v4 (in effect, not design)** | 14/4/3 local + 30d offsite backups; Loki 720h; automated event-table pruning + retention_audit. | skills_log prune FK-blocked, deadline passed (DA-1); soft-deleted captures never hard-purged (RC-15). |
| Right to erasure | GDPR-adjacent | **Absent (low exposure)** | Soft-delete only (`captures.ts:100`). | No person-scoped purge (RC-17). |
| Breach notification readiness | Household | **Informal** | Pushover alerting; 12 runbooks; LAB_NOTEBOOK as incident record. | No PII-holder inventory. Accepted at scale; not counted. |
| Vendor agreements (DPA) | Household | **N/A — consumer/API tiers** | PROVIDER_SETTINGS.md posture + quarterly cadence; supply-chain now on Dependabot grouped cadence (`cd14c1f`). | Account-level retention/opt-out settings still unverified (RI-3). |
| Change management | Household | **Good and demonstrably practiced** | Branch protection (2 required checks); LAB_NOTEBOOK blocking precondition (184 entries, D1–D134); config-diff deploy gate used in anger (Entry 183). | Rollback runbook is itself a landmine (PLT-C1); doc-sync observe-mode + tracking drift (RC-14); operator-action queue unowned (RC-19). |

---

## Audit Trail Assessment

Design unchanged and strong (see v4 for the full inventory: dual code-asserted `admin_audit` permanence invariants, `retention_audit` for automated deletions, queue-clear auditing). **The material change this cycle is operational, not structural:** the retention job that produces `retention_audit` has a known FK failure on `skills_log` (DA-1) whose fix deadline passed at 02:00 today. Because `pruneRetentionData()` has no per-table error isolation, the job aborts at the last policy entry, the `skills_log` retention_audit row is never written, and the failure surfaces only as a BullMQ failed job — the audit trail of the audit-trail control is the thing degraded. Carried gaps RC-16/RC-18 unchanged.

---

## Data Residency Assessment

Unchanged from v4 (dependency-only merge window). Primary data on US home server; offsite = client-side-encrypted rclone crypt to Google Drive (ciphertext only); observability on same-LAN shared stack; no cross-border obligations. Vendor flows per PROVIDER_SETTINGS.md §1 still match code inspection. The one residency-adjacent item that could have moved did not: RI-3 verification placeholders persist.

---

## Third-Party Risk Register

| Vendor | Data Shared | Risk Level | DPA/SCC in Place? | Finding |
|--------|------------|------------|------------------|---------|
| OpenAI | All capture text (embeddings + inference) | **High** (volume + sensitivity + no fallback) | No (API ToS) | Retention/training settings documented but unverified (RI-3). Medium lock-in (corpus re-embed to switch). |
| Anthropic (API + Claude CLI) | Skill prompts; batch synthesis incl. lab/insurance summaries | **High sensitivity / low volume** | No | Account-level verification outstanding (RI-3). API key shared with OpenClaw — blast-radius note. |
| Cloudflare | Inbound email content, tunnel metadata, CF Access identity | Medium | No | Ingress SPOF; accepted. |
| Google Drive (offsite) | Encrypted backup blobs only | **Low** (ciphertext) | No | Correct client-side crypt; scheduled-run verification outstanding (RC-12). |
| Google (Gmail OAuth via email-classify) | Mailbox read scope | Medium | No | **Still degraded — OAuth re-consent pending since ~June** (RC-13 cluster). |
| Deepgram | Voice audio (voice-pipecat only) | Low | No | Retention "confirm under current plan" placeholder (RI-3). |
| Slack | Messages, bot tokens | Medium | No | Accepted. |
| Composio | OAuth tokens to Gmail/Outlook/Drive/Notion/Slack | **High trust concentration** | No | Quota meter + Pushover warn in place; concentration accepted. |
| Pushover | Notification titles + short text | Low | No | Accepted. |
| Bitwarden (BWS) | All secrets + offsite-crypt keys | High trust (appropriate) | No | Bus-factor-1; recovery mechanical via P08 runbook. Workers machine token still unprovisioned (RC-13). |
| GitHub | Code, LAB_NOTEBOOK, CI logs, runbooks | **Medium–High (elevated)** | No | **Repo PUBLIC** (RC-10); public record now also includes deployed image digests + service inventory (Entry 183). |
| Grafana/Prometheus/Loki (shared LAN stack) | Metrics + all container logs | Low (same trust domain) | Self | Log-drop-on-unreachable affects forensic completeness (RC-18). |
| npm/Expo supply chain | — | **Low–Medium (improved from Medium)** | — | 119→20 open alerts, 0 critical, after D134 three-wave remediation; grouped Dependabot + automated security fixes now standing (`cd14c1f`); residual dev-scope `vite` high tracked (A139). Detail owned by Security/Software domains. |

---

## Business Continuity Assessment

- **DR plan documented: Yes** — backup.sh (exact-count manifests, D128), restore-rehearsal + cron + runbook, offsite-backup + cron + runbook, single-command secrets rebuild (`load-secrets.sh`), deploy runbook. **However the rollback section of the deploy runbook is booby-trapped (PLT-C1/A134, still open):** following §5 verbatim overwrites and then deletes the production `docker-compose.override.yml` that pins postgres/redis raw binds — the documented recovery procedure re-arms the ADR-0004 data-loss landmine. A deploy has occurred since this was flagged CRITICAL (Entry 183, no rollback needed — luck, not control).
- **DR plan tested: PARTIAL — manually proven 2026-06-11; scheduled runs still unverified after ~4.5 weeks** (A131 open since 2026-06-11; RC-12). Fail-only alerting means silence ≠ success.
- **Offsite backup: exists, encrypted, daily cron, 30d retention, copy-not-sync** — subject to RC-12 verification.
- **Retention/data-lifecycle: automated but currently failing on skills_log** (DA-1, deadline passed today).
- **Incident response: Partial** — per-alert runbooks + LAB_NOTEBOOK as incident record; no formal IR doc (acceptable at scale).
- **SLA commitments vs architecture capability: Aligned** — SLO.md is self-measurement, not commitment; best-effort posture appropriate.
- **Bus factor: 1, structurally** (accepted; recovery mechanical via runbooks). Not counted.

---

## Change Management Controls

- **Branch protection:** unchanged from the v4-verified posture (2 required checks, `enforce_admins=false`, no required reviews, no CODEOWNERS) — deliberate solo posture, no drift.
- **The controls are being used:** Entry 183's deploy followed the config-diff gate, recorded digest-verified rollback anchors, and executed the dependency remediation in three isolated, bisectable waves (D134) — the strongest single piece of change-management evidence any cycle has produced.
- **But the tracking layer continues to rot (RC-14):** doc-sync CI still observe-mode; OPEN_ITEMS.md a month stale and factually wrong about wave status; issue #226 open though fixed; 24 remote branches; junk files untracked. For a governance model whose compensating control **is** the written record, this remains a slow leak.
- **And the operator-action pipeline after merge has now demonstrably failed (RC-19):** a CRITICAL (A134) and a HIGH-with-hard-deadline (A135) sat in the action-item table for 3 days while discretionary dependency work was prioritized; A135's deadline passed this morning.

---

## Findings Detail

### High

- **RC-10 (carried from v4, High) — Repository is PUBLIC with the full operational record; the visibility decision remains unmade.** Re-verified live: `"visibility":"PUBLIC"`. All v4 particulars stand (12,700+-line LAB_NOTEBOOK with LAN topology, cron schedules, backup paths, and — most pointedly — an accurate public inventory of which security controls are currently inert, now including A134–A137). Entry 183 added deployed image digests and the healthy-service inventory to the public record. Reconnaissance amplification + personal-privacy exposure, not direct compromise. Remediation unchanged: make the call — flip private (preferred, one command, no known consumers) or accept public deliberately and scrub/relocate the operational record. This is now the second consecutive cycle carrying the finding and the third carrying the unowned decision.

- **RC-19 (NEW, High — formalizes the v4 meta-finding) — The post-merge operator-action queue is an unowned single point of failure, and it has now caused a production control failure.** Evidence across the queue: A135 (retention-prune FK fix, HIGH, hard deadline "before Sun 2026-07-12 02:00") — deadline passed today, no fix merged, the Sunday 02:00 run has presumably failed again; A134 (deploy-runbook rollback landmine, CRITICAL, "before next deploy/incident") — open 3 days, a deploy has since occurred; A131 (verify scheduled backup/rehearsal runs, HIGH) — open ~4.5 weeks; voice Bearer phase 2 — ~6 weeks; workers `BWS_ACCESS_TOKEN` — since Entry 180 (~2 weeks); Gmail OAuth re-consent — ~5 weeks; RC-10 decision — ~2 weeks. Meanwhile discretionary work (Dependabot remediation, executed excellently) was completed in the same window — the problem is not capacity or discipline but **prioritization visibility**: dated, deadline-bearing operator actions have no forcing function. Remediation: (1) immediately, execute A135 + A134 before the next scheduled Sunday run / next deploy; (2) structurally, adopt the standing dated operator-actions checklist (the `operational-followups.md` memory file is 90% of it) reviewed on the monthly-audit cadence, with hard-deadline items promoted to calendar/Pushover reminders, and add success-heartbeats so inert controls self-announce (covers RC-12's alerting gap too).

### Medium

- **RC-11 (carried, Medium) — D132's risk acceptance still predicated on a control that is not switched on.** `server.ts:19-21` unchanged: `VOICE_CAPTURE_SECRET` unset → `POST /api/capture` unauthenticated on the LAN; the loopback-bind alternative (8.2/SEC-02) was deferred *in favor of* this Bearer. Interim posture ~6 weeks old, no expiry, publicly documented (RC-10). Execute the runbook's phase 2 or set an explicit expiry.
- **RC-12 (carried, Medium) — Scheduled backup/DR automation still never verified in operation (A131, now ~4.5 weeks).** Fail-only alerting means absence-of-run is undetectable. Minutes of homeserver work: check `rclone lsf` remote timestamps + rehearsal log/Pushover history; add a success-heartbeat or backup-age>26h alert.
- **RC-13 (carried, Medium) — Secret-rotation staleness control inert in production; Gmail OAuth re-consent still pending.** `BWS_ACCESS_TOKEN` still absent from workers env and from `deploy/.env.secrets.template` (comment-only at docker-compose.yml:469); 90-day staleness alerting for all secrets non-functional; email-classify vendor integration degraded ~5 weeks.

### Low

- **RC-14 (carried, Low) — Change-tracking layer drift, slightly worse.** #226 still open though fixed (PR #230); OPEN_ITEMS.md a month stale and wrong about A132 wave status; doc-sync CI observe-mode (ci.yml:235); 24 remote branches; `._*`/`.DS_Store` untracked junk. One housekeeping session; flip doc-sync to enforcing.
- **RC-15 (carried, Low) — Soft-deleted captures never hard-purged.** Not in `RETENTION_POLICY`; consolidation's soft-deleted originals retain content + embeddings indefinitely. Candidate: `deleted_at < now() - 90d` prune entry with retention_audit logging + backup-age precondition. Bundle with the A135 fix (same file, same migration window).
- **RC-16 (carried, Low) — Email-worker rejections unlogged.** `console.log` only in the CF worker; a month-old "was someone probing the email ingress?" question still cannot be answered.
- **RC-17 (carried, Low) — No erasure capability for third-party PII.** Soft-delete only; realistic trigger remains a client-confidentiality request; household exposure Low.
- **RC-18 (carried, Low) — Security-event durability.** Failed mobile/MCP auth + rate-limit denials Loki-only (30d, drop-on-unreachable, external-stack dependency). Mirror auth failures into `admin_audit` or add a `security_events` table.

### Requires Investigation

- **RI-3 (carried) — Provider account-level retention/training-opt-out settings still unverified.** PROVIDER_SETTINGS.md placeholders unchanged (OpenAI "verify with current Enterprise vs. standard terms"; Deepgram "confirm under current plan"). Perform the actual account-dashboard verification at the quarterly review (~2026-09-30) at latest; record observed state + date.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 5 |
| Requires Investigation | 1 |

(Cross-domain items DA-1/A135, PLT-C1/A134, SEC-A1/A136 are adjudicated above but counted in their owning domains, not here.)

---

## Recommended Priorities

1. **A135 + A134 first (RC-19's immediate arm):** migration 0036 `ON DELETE SET NULL` + per-table isolation in `pruneRetentionData()` before next Sunday 02:00; rewrite deploy.md §5/§8 before the next deploy or incident. Both were fully specified in v4; only execution is missing.
2. **RC-10:** make the visibility decision — this gates nothing and costs nothing.
3. **RC-19 structural fix:** dated operator-actions checklist on the monthly-audit cadence + Pushover/calendar reminders for deadline items + success-heartbeats (also closes RC-12's detection gap).
4. **One homeserver session:** voice Bearer phase 2 (RC-11), workers BWS token + Gmail re-consent (RC-13), verify scheduled backup runs (RC-12).
5. **RC-14 housekeeping session;** RC-15–18 + RI-3 in the next hygiene wave / quarterly provider review.

The trajectory reads: 2026-04 missing controls → 2026-06 designed-but-dormant controls → 2026-07 (v4) built-and-tested controls with last-mile switch-on risk → **v5: the last-mile pattern stopped being theoretical.** A dated HIGH fix with a hard deadline was documented, publicly visible, and still missed while discretionary work shipped in the same window. The system's engineering governance is excellent; its **operations calendar** is now the weakest control — and it is the cheapest one to fix.
