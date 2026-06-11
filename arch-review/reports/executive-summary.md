# Architecture Review — Executive Summary

**System:** Open Brain — self-hosted personal AI knowledge infrastructure (v1.6.0, main @ ac42938)
**Review Date:** 2026-06-10
**Review Lead:** Architecture Review Team (9 agents)
**Scope:** Full monorepo (9 packages), Docker/compose infra, config YAMLs, scripts (backup/DR/secrets), CI workflows, migrations/schema, MCP surface, Cloudflare workers, observability config, docs. Out of scope: live homeserver runtime (except one read-only crontab check by Risk & Compliance), external vendors' internals, the standalone LiteLLM proxy, OpenClaw.

> Supersedes the 2026-04-18 review. All nine agents verified prior-review remediations (PRs #180–#189 + 2026-05-09 cohesive remediation) as genuinely closed before raising new findings: web consolidation, caller-trust model with `isInternalIp()`, BYPASS_CALLERS hoist, ingest N+1, hybrid_search LIMIT push-down, batch-UPSERT invariant, autonomy gates, admin_audit, secrets-free backups, cost-field fail-fast, Composio metering — all confirmed present and correct.

---

## Review Coverage

| Domain | Confidence | Runtime | Tools Available | Tools Missing | Findings |
|--------|-----------|---------|----------------|---------------|----------|
| Solutions Architect | High | 500s | — | cloc, tokei, plantuml | C:0 H:1 M:2 L:6 RI:1 (10) |
| Data Architect | High | 541s | — | psql, redis-cli (static only) | C:0 H:2 M:4 L:6 RI:1 (13) |
| Integration Architect | High | 427s | curl, jq | spectral, openapi-generator | C:0 H:1 M:6 L:2 (9) |
| Software Engineer | High | 605s | — | cloc, eslint, pylint, radon, lizard | C:1 H:2 M:5 L:9 RI:1 (18) |
| Performance Engineer | Medium | 572s | — | k6, ab, wrk, hey, vegeta | C:0 H:1 M:6 L:5 (12, 1 RI within M) |
| QA Architect | High | 500s | — | jest/pytest/vitest CLIs (not on PATH) | C:0 H:2 M:6 L:5 (13) |
| Security Architect | Medium | 680s | pnpm audit | semgrep, bandit, trivy, pip-audit, safety | C:0 H:3 M:4 L:5 (12, 2 RI within) |
| Platform Engineer | High | 501s | docker | terraform, helm, kubectl | C:0 H:4 M:10 L:5 RI:2 (21) |
| Risk & Compliance | High | 484s | git, jq, ssh (1 live crontab check) | gh (unauthenticated) | C:0 H:2 M:4 L:3 RI:2 (11) |
| **Totals** | | | | | **C:1 H:18 M:47 L:46 RI:7 (119)** |

**Coverage notes:**
- No SAST binaries anywhere (semgrep/bandit/trivy etc.) — security analysis was grep-based plus a successful offline `pnpm audit`. This is the second consecutive review with this gap (QA Medium-8).
- No load-test tooling and no live DB access — Performance Engineer's quadratic-job and spreading-activation findings are structural estimates pending the 6 recommended validation scenarios in its report.
- Cloudflare Access enforcement (the system's outermost confidentiality control) is configured in the CF dashboard and **cannot be verified from the repository** — flagged requires-investigation (SEC-01).
- Risk & Compliance performed one read-only live check: `crontab -l` on the homeserver, which **confirmed** the restore-rehearsal cron is NOT installed — resolving what three other agents could only flag as requires-investigation.

---

## Go / No-Go Recommendation

**Recommendation: CONDITIONAL GO** (system is in production; continue operating with immediate remediation)

**Rationale:** The architecture is fundamentally sound — fit score 5/5, prior-review remediation verified durable, idempotency/secrets/runbook discipline genuinely strong. But the review found one Critical correctness bug that silently disables the system's entire capture-recovery architecture, and a cluster of "designed but never switched on" controls (restore rehearsal, offsite backup, coverage gates, CI image for the production UI) that collectively mean the safety net the operator believes exists largely does not.

**Conditions (resolve within ~1 week):**
1. **SE-1** — Fix the stuck-capture sweep status filter (`'received'` → `'pending','processing','extracted'`) in `daily-sweep.ts` + `stale-captures.ts`, with a test pinning the filter to `PIPELINE_STATUSES`. ~2 hours; restores the recovery architecture.
2. **RC-2** — Install the restore-rehearsal cron on the homeserver (verified live as absent; ~7 weeks of backups never restore-validated). Minutes of work; the control is already built.
3. **SEC-03** — Bump `next` to ≥ 16.2.5 (App Router proxy-bypass advisory; `proxy.ts` is the load-bearing caller-identity control on the public path). One-line change.
4. **RC-1 / DA-H2 / PLT-H4** — Stand up the offsite backup the TDD already documents (rclone-crypt weekly, key in BWS). Today primaries + all 21 retained backups share one chassis. Half a day.

---

## Critical and High Findings Summary

| ID | Domain | Severity | Finding | Business Impact | Effort |
|----|--------|----------|---------|----------------|--------|
| SE-1 | Software Eng | **Critical** | Both stuck-capture sweepers filter on `pipeline_status IN ('received','processing')` — `'received'` is not a valid status. Captures stranded in `'pending'` (failed enqueue) or `'extracted'` (embed retry exhaustion — the exact case the "no embedding fallback, queue and retry" design depends on the sweep to recover) are never re-enqueued. | An OpenAI outage > 2h strands captures permanently un-embedded (FTS-only, silent quality loss). The designated recovery safety net recovers almost nothing. | 2h |
| RC-1 / DA-H2 / PLT-H4 | Risk, Data, Platform | High | No offsite backup. Primaries, all ~21 retained backups, and pre-wipe dumps share one Unraid chassis. TDD documents a weekly rclone-crypt offsite sync that does not exist (repo + live crontab checked). | Fire/theft/ransomware/multi-disk failure destroys 11K+ irreplaceable captures incl. health, insurance, financial records and every backup simultaneously. | 0.5d |
| RC-2 (+SA-10, PLT-RI-1) | Risk (live-verified) | High | Restore-rehearsal cron (P16) designed, documented, never installed — confirmed via live `crontab -l`. Only the 03:00 backup runs. | Backups have never been machine-validated as restorable; the "tested weekly" DR claim is void. | minutes |
| DA-H1 / SA-2 | Data, Solutions | High | `init-schema.sql` drift is worse than tracked: missing `app_settings` (0010) in addition to known 0012/0028/0030, while including 0029/0031. Both integration-test suites bootstrap **exclusively** from this drifted file (the "source of truth through 0031" comment in workers test setup is false). No machine-checked equivalence between the snapshot and the 33-migration chain. | CI integration tests run against a schema that diverges from production; a disaster-recovery rebuild under stress produces a half-schema'd system (no settings store = no email allowlist, no autonomy level). Compounds at the system's weakest moment. | 0.5–1d |
| SEC-02 | Security | High | Compose publishes core-api :3002, Postgres :5432 (with `openbrain_dev` default-password fallback), password-less Redis :6380, Pushgateway :9091 etc. to `0.0.0.0` on the LAN. core-api has no in-boundary auth and `isInternalIp()` *trusts* RFC1918 sources. | Any LAN host (compromised IoT, guest device) can read/write all personal data, claim `internal:*` caller identity, read admin reset tokens from Redis. | M |
| SEC-03 | Security | High | `next ^16.2.4` < 16.2.5 fix for App Router middleware/proxy bypass (+SSRF/DoS advisories). `proxy.ts` is the single control overwriting `X-Open-Brain-Caller` on the tunnel path. | Proxy bypass defeats the only caller-identity guard on the production ingress path. | S |
| SEC-01 | Security | High (RI) | Cloudflare Access enforcement is unverifiable from the repo — the entire confidentiality model rests on it. | If misconfigured/absent, full dashboard + API + MCP is internet-exposed unauthenticated. | Verify: minutes |
| PLT-H1 | Platform | High | `web-next` (the production UI) is missing from `build-images.yml` — only 7 of 8 images built by CI. Deploy runbook's "every merge pushes fresh images" claim is false for the UI. | Every `docker compose pull` deploy ships a stale UI or fails; silent drift between main and production ingress. | S |
| PLT-H2 | Platform | High | Workers container is a single point of alerting failure: all container-health/queue gauges are pushed *from workers* to Pushgateway, which retains stale values forever. No `absent()`/staleness rules; workers has no Docker healthcheck. | Workers dies → every alert freezes at "healthy", all Pushover-sending skills stop, queues back up silently overnight. The synthetic monitor watches core-api, not workers. | S–M |
| PLT-H3 / SA-3 | Platform, Solutions | High | Loki log-driver default URL (`loki:3100`) is unresolvable from the daemon-level driver, and observability.md Step 6 instructs the operator to switch to exactly that broken value. Driver drops (not buffers) lines when Loki is unreachable. | Following the runbook silently destroys all container logs — precisely during incidents, when they're needed. | S (doc+env fix) / M (json-file+Alloy redesign) |
| QA-H1 | QA | High | Coverage gates are dormant: thresholds configured in workers (78/81 + four per-file 100% locks) and core-api (80/80), but no test script or CI step ever passes `--coverage` — verified via git history. CLAUDE.md documents the gate as "enforcing"; it has never gated a run. | Coverage (incl. 100%-locked files like `base-skill.ts`, `spend-tracker.ts`) can erode silently while documentation claims otherwise. | S |
| QA-H2 / PLT-M8 | QA, Platform | High | `build-and-test` was never promoted to a required status check despite CLAUDE.md recording the blocker (A126) as resolved. Only the integration suite gates merge. | Failing unit tests, typecheck, or builds across all 7 TS packages can merge to main; slack-bot (492 tests), web-next, mobile have zero blocking automation. | One API call |
| SE-2 | Software Eng | High | `POST /captures/:id/retry` is a silent 200-no-op for `'failed'` captures — `ingestion-worker.ts:100` treats failed as terminal. | The manual recovery path for failed document captures doesn't work, compounding SE-1. | S |
| SE-3 / PE-L3 | Software Eng, Perf | High | POST-search pagination structurally broken: route slices `[offset, offset+limit]` from a result already capped at `limit` — page 2+ is always empty. | Any paginating client (mobile, agents) silently sees only page 1. | S |
| INT-H1 | Integration | High | slack-bot `CoreApiClient.request()` (~35 methods) has no timeout and no retry — the only unhardened internal boundary, despite being the documented single choke point. | Wedged core-api connection hangs Bolt handlers past Slack's ack window; user-visible silent failures. | S |
| PE-H1 | Performance | High | `memory-consolidation-query.ts` + `capture-dedup-sweep.ts` each run a weekly O(N²) cosine self-join (HNSW cannot serve a join predicate; LIMIT applies after full evaluation). ~60M distance computations at 11K captures; quadruples per corpus doubling; infeasible ~50–100K. | The fastest-growing cost in the system; weekly batch window blowout, then outright failure, well before any search-path limit. | M (per-row HNSW k-NN rewrite) |

---

## Cross-Domain Risk Map

**1. The disaster-recovery moment is the system's compounding weak point.** Four independent findings converge on the same scenario: no offsite backup (RC-1/DA-H2/PLT-H4) means a chassis event destroys everything; the rehearsal cron was never installed (RC-2) so restorability is unproven; init-schema drift (DA-H1/SA-2) means even a successful restore-from-scratch produces a broken schema (no `app_settings` → no email allowlist, no autonomy levels); and no migration ledger (DA-M1 — drizzle `meta/` is empty, so `scripts/migrate.sh` cannot work) means nobody can tell which migrations a rebuilt DB received. Each is cheap to fix; together they mean the current DR posture is substantially weaker than the (excellent) backup tooling suggests.

**2. The capture-recovery architecture is broken end-to-end, and its failure would be invisible.** SE-1 (sweep filters on an invalid status) disables automated recovery; SE-2 (retry endpoint no-op) disables manual recovery; SE-4 (dedup classifies a capture's own retry as duplicate) neuters BullMQ's own retries within the 5-min TTL; SE-5 (`DelayedError` thrown without `moveToDelayed`) makes the budget hard-stop burn retry attempts and dead-letter jobs into the unrecoverable `'extracted'` state. Compounding: PLT-H2 means that if the workers container itself dies, all alerting freezes at "healthy" — the failure would also be silent. Fixing SE-1 (2h) plus the Pushgateway staleness rules (S) breaks the compounding chain.

**3. LAN is an unguarded second perimeter.** SEC-02 (0.0.0.0 port publishing) + SEC-08 (password-less Redis) + SEC-11/PLT-L1 (default-password fallbacks) + INT-M5 (mobile voice uploads going direct to unauthenticated plaintext `:3001`, bypassing the existing core-api proxy) + PLT-L3 (unauthenticated Pushgateway accepting spoofed health metrics). The trust model was hardened against the *internet* path (CF Access, proxy.ts, isInternalIp) — but `isInternalIp()` *trusting* RFC1918 sources makes the LAN the easier attack path. One compose edit (bind 127.0.0.1 / unpublish + requirepass) collapses most of this.

**4. The budget circuit breaker has blind spots exactly where the April incident happened.** INT-M2: `checkBudget()` covers only gateway-routed calls — `EmbeddingService` and voice-capture's direct OpenAI client bypass it entirely; bulk paths are precisely where the prior $100 runaway occurred. SE-5 means even the covered path's hard-stop misbehaves. RC-3 raises the stakes: health and insurance data now ride these same vendor channels without documented provider retention/training posture (RC-5).

**5. Convention-enforced invariants keep drifting despite exceptional discipline — the meta-finding.** The Solutions Architect's evolution assessment names this as the first real constraint: correctness depends on ~40 CLAUDE.md rules followed by one careful operator. This review found the predictable drift instances: dormant coverage gates documented as "enforcing" (QA-H1), unpromoted required check documented as promotable (QA-H2), TDD documenting an offsite backup that doesn't exist (RC-1), CLAUDE.md documenting "SET LOCAL" while code session-SETs on a pooled connection (PE-M1/DA-L1), six type-mirror surfaces where the lockstep rule says four (SA-1), deploy.md describing deleted services (PLT-M2), init-schema "source of truth" comments that are false (DA-H1). **Resolution direction: convert the top conventions into CI-enforced invariants** — schema-snapshot diff, drift-guard tests for web-next/mobile unions, cron-slot uniqueness test (SA-8/QA), coverage activation, doc-drift checks.

**Conflict resolved during synthesis:** QA's environment-fidelity section credits `validate-init-schema.sh` with cross-validating init-schema against migrations, while the Data Architect proved 4 migrations absent from the file. Both are factually right: the validator exists but runs conditionally (only when schema paths change — QA Low-11) and validates CHECK-constraint parity, not table-set completeness. Data Architect's finding stands; the validator needs a completeness check and unconditional execution. Severity tiebreak by business impact: High (it gates both CI fidelity and DR).

**Requires-investigation resolutions during synthesis:** RC's live crontab check resolves SA-10 and PLT-RI-1 (rehearsal cron: confirmed NOT installed → RC-2 is a confirmed High, not RI). DA's R1 (host-level replication possibly covering backups) remains open but RC's live check found no offsite cron — treat RC-1 as confirmed pending only the urBackup question.

---

## Remediation Roadmap

### Immediate (Critical — this week)
1. **SE-1** — Fix sweep status filters in `workers/src/jobs/daily-sweep.ts:39` + `workers/src/skills/stale-captures.ts:165`; pin to `PIPELINE_STATUSES` with a test. *(Software Eng, 2h)*
2. **RC-2** — SSH to homeserver, install `deploy/cron/unraid-restore-rehearsal.cron` per its own instructions; confirm first Sunday Pushover. *(Ops, minutes)*
3. **SEC-03** — Bump `next` ≥ 16.2.5, commit lockfile. *(S)*
4. **SEC-01** — Verify CF Access policy covers brain.troy-davis.com; document in `deploy/`; consider a startup assertion on the CF Access email header. *(Ops, minutes–M)*

### Short-term (High — 30 days)
5. **RC-1/DA-H2/PLT-H4** — Offsite backup: rclone-crypt weekly push of `$BACKUP_ROOT/latest` to B2/Drive (key in BWS, not on host); add Pushover-on-failure to backup.sh and move its log off RAM-backed /tmp (PLT-M9). *(0.5d)*
6. **DA-H1/SA-2** — Regenerate `init-schema.sql` from `pg_dump --schema-only` of a fully-migrated DB; add CI parity check (two scratch DBs, diff schema dumps); fix the false "source of truth" comments; make `validate-schema` unconditional (QA-L11). Longer-term: adopt a migration ledger (DA-M1). *(0.5–1d)*
7. **SEC-02 (+SEC-08, SEC-11, PLT-L1, PLT-L3)** — Bind published ports to 127.0.0.1 or unpublish postgres/redis/pushgateway; `--requirepass` on Redis; remove `openbrain_dev` and Grafana `admin` default fallbacks (fail closed). *(M)*
8. **PLT-H1** — Add web-next to `build-images.yml`; verify GHCR tag exists (PLT-RI-2). *(S)*
9. **PLT-H2** — Add `absent()`/`push_time_seconds` staleness rules for workers-pushed metrics; add a workers Docker healthcheck (+ slack-bot, cloudflared — PLT-M6). *(S–M)*
10. **PLT-H3/SA-3** — Fix compose Loki default URL + observability.md Step 6 now (S); evaluate json-file + Alloy/Promtail redesign to eliminate the silent-drop class (M).
11. **QA-H1 + QA-H2** — Add `--coverage` to workers/core-api test scripts (or CI step); promote `build-and-test` to required check; correct CLAUDE.md. *(S)*
12. **SE-2, SE-3** — Retry-endpoint no-op fix (share semantics with SE-4); POST-search pagination fix. *(S each)*
13. **INT-H1** — `AbortSignal.timeout(15_000)` in slack-bot `CoreApiClient.request()`; treat 409 as success on captures_create if retries added. *(S)*
14. **PE-H1** — Rewrite both weekly similarity scans as per-row HNSW k-NN probes (shared implementation, incremental-friendly). *(M)*

### Medium-term (Medium — 90 days)
- **Budget-breaker coverage** (INT-M2 + SE-5): route embeddings + voice classification spend through `checkBudget()`; fix `DelayedError`/`moveToDelayed` usage and the dead `PAUSE_DELAY_MS`.
- **Soft-delete leak** (SE-6 = DA-M2): add `deleted_at` filter to `spreading_activation()` (new migration) + `findRelatedCaptures()` hydration — MCP agents currently receive consolidated-away content by default.
- **Prompt-injection ingest side** (SEC-05/S-2/S-3): wrap `{{content}}` via SafePromptBuilder in `extract-entities.ts` + `extract-commitments.ts` (P14b covered read side only).
- **Ingestion edge cases**: SE-4 (dedup key should include captureId), INT-M3 (email worker `setReject` → forward/queue on transient failure), INT-M4 (voice transcript dead-letter), INT-M5 (route mobile voice through the existing core-api proxy).
- **Contract hardening**: SA-1 drift-guard tests for web-next/mobile type mirrors; INT-M6 generate OpenAPI from Zod (`@hono/zod-openapi`); SA-8/QA cron-slot uniqueness test; SE-12 fix the two Sunday cron collisions.
- **Data layer**: DA-M3 (access-stats producer `defaultJobOptions` — unbounded Redis leak per search), PE-M1/DA-L1 (ef_search + hybrid_search in one transaction), PE-M2 (stored tsvector column), PE-M3 (Redis `--maxmemory 400mb noeviction`), PE-M4 (CPU limits, esp. faster-whisper), DA-M4/RC-3/RC-5 (data-classification + provider-settings doc; encryption-at-rest decision).
- **Ops/QA**: PLT-M1 (Alertmanager or correct the safety-net claims), PLT-M2/M3 (deploy.md refresh + post-compose-up.sh step), PLT-M5 (single deploy script + smoke test), PLT-M7 (pin third-party images), QA-M3 (enable INGEST_E2E in CI), QA-M4 (CI-run the secrets regression guards), QA-M5 (proxy.ts test + Playwright smoke in CI), QA-M7 (workers suite in local runner), QA-M8 (CodeQL default setup), PE-M5 (spreading-activation degree cap — investigate first), PE-M6 (SLO targets + alert rules), INT-M7 (outbound-dependency histogram), RC-4 (event-table retention), RC-6 (mobile token rotation procedure), SEC-04 (adminAuth + audit row on `/queues/:name/clear`), SEC-06/SEC-07 (drizzle-orm + simple-git advisory bumps).

### Opportunistic (Low)
46 Low findings across domains — see domain reports. Highest-leverage clusters: doc-drift one-pass (SA-6, TD-3, SE-9, QA-L10, PLT-L5), healthcheck completion (SA-5, PLT-L4), MCP tool contract honesty (SE-8 `tag_filter`, SE-10 `vector` mode), partial unique index on `content_hash` (DA-L3), `email_classifications` uniqueness (DA-L5), voice upload size cap (PE-L4), embedding column over-fetch (PE-L2).

---

## Risk Acceptance Register

| Finding | Domain | Severity | Acceptance Rationale | Owner |
|---------|--------|----------|---------------------|-------|
| No in-boundary auth; perimeter-only trust model | Security | — | Documented single-user design (PRD); compensating controls verified. Becomes unacceptable the moment a second user or host appears. | Troy |
| `POST /admin/reset-data` without Bearer auth | Security | — | Accepted pre-existing posture; two-step token + phrase + origin + audit verified intact. (Contrast: `/queues/:name/clear` — SEC-04 — has none of these and is NOT accepted; fix it.) | Troy |
| Single host, no HA, bus factor 1 | Platform/Risk | — | Inherent to a personal homelab; P08 runbooks make recovery mechanical. Offsite backup (RC-1) is the non-negotiable complement. | Troy |
| 24h RPO (daily dump, no WAL archiving) | Data | — | Sources (Slack/email/voice) are independently retainable; conscious trade. State it explicitly in docs (PLT-M10). | Troy |
| No encryption at rest | Data/Risk | Medium | TDD acknowledges; physical+network security posture. Revisit given health/insurance data now stored (RC-3) — at minimum encrypt the offsite copy (rclone-crypt does this). | Troy |
| Vendor ToS-tier relationships (no DPAs) | Risk | — | Consumer/API tiers are the only option for a personal system; document provider settings (RC-5) instead. | Troy |
| In-memory rate limiter (per-process) | Security/Perf | Low | Correct for one replica; precondition flag for any horizontal scale (P33 is scale-gated anyway). | Troy |
| Cost-tiering convention vs all-OpenAI hot path | Solutions | — | Documented decision (TDD §2.1); enforced where it matters (batch aggregation, budget breaker). | Troy |

---

## Domain Report Index

| Domain | File | Findings |
|--------|------|----------|
| Solutions Architect | `arch-review/findings/solutions-architect.md` | 10 |
| Data Architect | `arch-review/findings/data-architect.md` | 13 |
| Integration Architect | `arch-review/findings/integration-architect.md` | 9 |
| Software Engineer | `arch-review/findings/software-engineer.md` | 18 |
| Performance Engineer | `arch-review/findings/performance-engineer.md` | 12 |
| QA Architect | `arch-review/findings/qa-architect.md` | 13 |
| Security Architect | `arch-review/findings/security-architect.md` | 12 |
| Platform Engineer | `arch-review/findings/platform-engineer.md` | 21 |
| Risk & Compliance | `arch-review/findings/risk-compliance.md` | 11 |

Coverage metadata: `arch-review/findings/.meta.json` · Intake: `arch-review/intake.md`
