# Architecture Review — Executive Summary

**System:** Open Brain — self-hosted personal AI knowledge platform (v1.6.0)
**Review Date:** 2026-07-12
**Review Lead:** Architecture Review Team (9 agents)
**Review generation:** v5 — supersedes 2026-07-09 v4 (v4 artifacts preserved at `~/dev/personal/open-brain-backups/arch-review-v4-20260709/`)
**Scope:** Entire repository (all packages, scripts, config, compose, CI/CD, runbooks, Cloudflare workers, schema machinery) + adjudication of every v4 finding. Out of scope: live homeserver state (read-only, no SSH), load-test execution, the standalone observability compose project, LiteLLM proxy internals.

---

## Review Coverage

| Domain | Confidence | Runtime | Tools Available | Tools Missing | Findings |
|--------|-----------|---------|----------------|---------------|----------|
| Solutions Architect | High | 341s | git, grep | cloc, tokei, plantuml | C:0 H:0 M:10 L:4 (RI:3) |
| Data Architect | High | 220s | psql (no target DB) | mysql, redis-cli | C:0 H:1 M:5 L:5 (RI:2) |
| Integration Architect | High | 276s | curl, jq | openapi-generator, spectral | C:0 H:0 M:6 L:6 |
| Software Engineer | High | 438s | grep, wc, vitest-coverage | cloc, eslint, radon, lizard | C:0 H:3 M:5 L:14 (RI:2) |
| Performance Engineer | High | 198s | — (code-level only) | k6, ab, wrk, hey, vegeta | C:0 H:1 M:3 L:7 (RI:1) |
| QA Architect | High | 320s | vitest via pnpm exec, gh api | global test binaries | C:0 H:3 M:4 L:8 (RI:1) |
| Security Architect | **Medium** | 453s | pnpm audit | semgrep, bandit, trivy, pip-audit, safety | C:0 H:1 M:3 L:4 (RI:1) |
| Platform Engineer | High | 343s | docker | terraform, helm, kubectl (n/a) | C:1 H:4 M:9 L:5 (RI:3) |
| Risk & Compliance | High | 352s | git, jq, gh | vendor dashboards | C:0 H:2 M:3 L:5 (RI:1) |
| **Totals (raw, pre-dedup)** | | ~25 min wall | | | **C:1 H:15 M:48 L:58 — 129 findings, 14 requires-investigation** |
| **Totals (deduplicated)** | | | | | **C:1 + 12 unique High** (3 High duplicates fold into the DA-1 and QA-1 clusters) |

**Coverage notes (surfaced from metas):**
- Security is the only Medium-confidence domain: no SAST/scanner binaries (semgrep/bandit/trivy absent); manual review + `pnpm audit` substitute. Deployed secret state (`VOICE_CAPTURE_SECRET`) taken from intake, not verified live.
- All domains: live homeserver state unverifiable — specifically whether the Sun 2026-07-12 02:00 `data-retention-prune` run FK-failed (DA-1/RI-A), scheduled offsite/rehearsal cron executions (A131), shared-stack Alertmanager delivery (PLT-H2), and litellm network attachment.
- QA executed a live vitest-3 workers coverage run (1091/1091 pass, 73.72% lines) and live `gh api` branch-protection/CodeQL checks — coverage numbers in this report are re-measured, not carried forward.
- Adjudication basis: git history confirms the only post-v4 merges are Dependabot PRs #232–#234 + `cd14c1f` (dependabot.yml) — every v4 finding site was re-verified at HEAD rather than assumed.

**v4 → v5 adjudication outcome:** of ~117 v4 findings, **2 genuinely improved** (dependency backlog: 112 vulns/4 critical → 29/0, downgraded to Low; security scanning: CodeQL default setup + Dependabot automation landed 2026-07-12, QA-6 downgraded), **1 corrected in scope** (perf PE-M2: `embedBatch()` exists but has zero callers — fix smaller than v4 stated), **everything else STILL OPEN**, including all four v4 go-conditions. One v4 High materialized into an active production failure (DA-1). The Dependabot remediation itself was verified regression-free (nodemailer 9's breaking change doesn't apply to the SMTP-only usage; vitest 3 needed no config change; the `sse.ts` dead-code removal left zero dangling references) and was executed with exemplary discipline (digest-verified rollback anchors, isolated waves, constitution-correct coverage fix).

---

## Go / No-Go Recommendation

**Recommendation: CONDITIONAL GO** — the system is in production and architecturally sound (pattern fit remains 5/5), but the same four conditions from v4 carry forward unmet, and one has transitioned from "will fail" to "presumed failing in production."

**Rationale:** Three days elapsed since v4; the only work shipped was the (well-executed, but discretionary) Dependabot remediation, while all four dated go-conditions sat unactioned — including one whose hard deadline lapsed the morning of this review. The codebase is healthy; the risk is concentrated in operator follow-through on known, small, fully-specified fixes. This is now a **third-cycle pattern**: each condition costs ~1 hour to half a day; carrying them costs a booby-trapped recovery path, a silently failing retention control, and an unmetered paid-API attack surface.

**Conditions (priority order):**
1. **TODAY — DA-1/A135:** Ship migration 0036 (`briefs.source_skill_log_id` → `ON DELETE SET NULL`) + per-table try/catch in `pruneRetentionData()` + init-schema regen; then check prod `retention_audit`/worker logs for the 2026-07-05 and 2026-07-12 02:00 runs and clear failed jobs. The job is presumed to have failed twice in production.
2. **Before next deploy or incident — PLT-C1/A134:** Rewrite `docs/runbooks/deploy.md` §5/§8 (restore-from-backup semantics, config-diff gate, `--remove-orphans` prohibition, correct volume claims). ~1 hour. Entry 183's deploy explicitly routed around this runbook — institutionalize the safe procedure it used.
3. **This week — SEC-A1/A136:** Stop voice-pipecat or bind `127.0.0.1:8765` pending #54/#57; add it to ADR-0002's port table + SECURITY.md.
4. **Owner decision — RC-10:** Flip repo private (or document explicit acceptance in the Risk Acceptance Register). Entry 183 added deployed image digests to the public record.
5. **New this cycle — RC-19 (the root cause of 1–4):** Institute a dated operator-actions checklist reviewed on the monthly-audit cadence, with heartbeat (not failure-only) alerts. Without a forcing function, conditions 1–4 will still be open at v6.

---

## Critical and High Findings Summary (deduplicated)

| ID | Domain(s) | Severity | Finding | Business Impact | Remediation Effort |
|----|-----------|----------|---------|-----------------|-------------------|
| PLT-C1 (A134) | Platform (file label PE-C1) | **Critical** | deploy.md §5 rollback `cat >`-truncates then `rm`s the production `docker-compose.override.yml` — the only file pinning postgres/redis raw binds; §8 falsely claims `postgres_data` named volume holds the live DB. The safe procedure exists only in LAB_NOTEBOOK Entry 183. | Following the documented rollback during an incident detaches the production DB onto empty volumes. The recovery path is booby-trapped precisely when it's needed. | ~1 hour (docs) |
| DA-1 (A135) | Data + Software (SW5-H3) + Risk (RC-19 facet) + Solutions (SA-14) | **High — actively failing** | `data-retention-prune` skills_log DELETE FK-blocked by `briefs.source_skill_log_id` (no ON DELETE, init-schema.sql:1816); no per-table isolation (data-retention-prune.ts:80-118); no migration 0036. Hard deadline (Sun 2026-07-12 02:00) passed unmet — presumed second consecutive production failure. The other 4 tables prune only by array-ordering luck. | Retention control (RC-4) silently broken weekly; skills_log grows unbounded; retention_audit incomplete. | Half a day (migration + try/catch + test + init-schema regen) |
| SEC-A1 (A136) | Security | **High** | voice-pipecat `ws://0.0.0.0:8765` zero-auth (compose:259; config.py:44 defaults 0.0.0.0); absent from ADR-0002 exposure model and SECURITY.md. Zero remediation motion across two cycles. | Any LAN socket drives paid Deepgram+Anthropic (outside the OpenAI-only budget breaker) and can inject captures. | One line (bind/stop) + doc updates |
| RC-10 | Risk | **High** | Repo live-verified PUBLIC (`gh repo view`) with 250+ LAN/topology references; Entry 183 added deployed image digests to the public record. | Public blueprint of home-network attack surface + an inventory of currently-inert controls. | Owner decision (minutes) |
| QA-1 / SW5-H1 | QA + Software | **High — third cycle** | Workers coverage gate dormant (`test` script lacks `--coverage`); re-measured live under vitest 3: **73.72% vs 78 floor** (a true, never-inflated number). The untested spine is growing: `scheduler.ts` 0% (307→495 lines since v4-era measurement), `skill-execution.ts` 0.41%, `ingest-process.ts` 0%, consolidation query layer 4.7%. Both Entry-180 production incidents lived in this band. Functions 81.75% is only 0.75pp above its own threshold. | The code that runs every scheduled job has zero CI verification; regressions ship undetected. | ~493-line test catch-up, then one-word script change |
| QA-2 | QA | **High** | Full-stack ingest e2e permanently disabled in CI (ci.yml:212 deferral comment). | The bug classes it defends were all historically deploy-discovered. | Medium (full-stack test compose) |
| QA-3 | QA | **High** | Web UI (270 src files) has zero component tests; one Playwright smoke that no workflow invokes and which self-skips without a live stack. | The sole UI ships on manual testing only. | Medium (wire smoke into CI + top-page component tests) |
| SW5-H2 / perf PE-H1 | Software + Performance | **High** | `runAgent()` has no context/token budget; monthly-reflection.ts:164 interpolates full untruncated capture content (×200 captures ×5 tools ×10 iterations) — root cause of #204's 6.5M-token blowup. Entry 180's 120s timeout bump was a symptom patch. | Monthly skill fails or burns budget; every agent-loop skill inherits the defect. | Small–medium (budget at the runAgent layer) |
| PLT-H1 | Platform | **High** | deploy.md/observability.md contradict post-ADR-0004 reality: §7 still documents the 4 GPL containers deleted 2026-07-01; §4's migration step is non-executable on Unraid (no psql); the config-diff gate + `--remove-orphans` prohibition live only in CLAUDE.md/LAB_NOTEBOOK. | A non-builder operator following the runbooks fails or causes harm mid-incident. | 2–4 hours (docs) |
| PLT-H2 | Platform | **High (RI)** | Alert-rule/dashboard ownership ambiguous post-ADR-0004: the 7 in-repo rule files + dashboards are mounted by nothing; sync with the shared stack is undeclared; `WorkersMetricsAbsent`/`PushgatewayStale` delivery is unproven. | Workers is the Pushover engine; if it dies, the only watchers are rules whose delivery path is unverified → total alerting darkness. | Small (verify once + ownership note) — needs live host |
| PLT-H3 | Platform | **High** | 3 SLO alerts annotate `docs/runbooks/slo-alert.md`, which does not exist (slo.yml:79/102/124). | An SLO breach fires with a dead runbook link mid-incident. | ~1 hour |
| PLT-H4 (A131) | Platform + Risk (RC-12) + QA (RI-1) | **High (RI)** | No dead-man's switch on the backup chain; all alerting is push-on-failure from the scripts themselves; A131 (verify the first scheduled offsite/rehearsal runs) open since 2026-06-11 — ~1 month of unverified runs. Lost Unraid cron entries or an unreadable `.env.secrets` in cron context (`. ./.env.secrets 2>/dev/null` swallows the error) = silent backup death. | DR is believed-working but unproven; the silent failure mode is undetectable. | Verify logs once + freshness gauge (half a day) |
| RC-19 | Risk | **High — NEW** | Dated operator actions have no forcing function: A135's hard deadline passed while discretionary work shipped in the same window; A134 sat through a real deploy that explicitly routed around it; the voice secret has been unset ~6 weeks; A131 ~1 month. The gap is prioritization visibility, not discipline (Entry 183 shows excellent change management when work is scheduled). | Without a forcing function, the same four go-conditions will still be open at v6. | Small (dated checklist on monthly-audit cadence + heartbeat alerts) |

---

## Cross-Domain Risk Map

1. **"Configured but not armed" (Solutions theme — now with a live casualty).** Dormant workers coverage gate (QA-1) + warn-allow voice Bearer with the secret unset ~6 weeks (SEC-A3/IA-M2/RC-11 — D132's risk acceptance rests on an INACTIVE control) + observe-only doc-sync (PE-M7/QA-10) + unverified DR (PLT-H4/A131) + a retention job failing its charter (DA-1). DA-1 is the first instance where this class produced an actual production failure; the others are the same failure mode waiting for a trigger.
2. **Runbook drift × landmine architecture.** PLT-C1 compounds with ADR-0004's decision to keep the bind reconciliation in a gitignored, host-only override: the single file that keeps production data attached is exactly what the documented rollback destroys. doc-sync (observe mode, version-strings only) is structurally blind to this drift class — the control that should catch PLT-C1 cannot.
3. **Automation added faster than gates.** Dependabot now auto-bumps weekly into: (a) Cloudflare workers with zero CI compile/test — open PRs include the mail parser (postal-mime) and a workers-types 4→5 major (QA-7, aggravated); (b) `build-images.yml`, which has no PR-time execution and no publish-failure alert — a broken GH Actions major (#242 touches all 11 build steps) fails silently post-merge and the next `docker compose pull` redeploys stale `:latest` with no signal (platform PE-M9, escalated Low→Medium); (c) dependabot.yml omits the `pip` and `docker` ecosystems, so the Python sidecars and Phase-9.5 image pins age invisibly (platform PE-L6).
4. **Alerting single-point-of-failure chain.** Workers container = the app-layer Pushover engine → its external watchers are Prometheus rules whose post-ADR-0004 delivery is unproven (PLT-H2) → the backup chain has no heartbeat (PLT-H4) → a dead workers container plus a quietly dead cron = data-loss exposure with zero signal at every layer.
5. **Coverage truth vs. coverage theater (QA-15, NEW).** vitest 3 revealed core-api's gate had passed on inflated measurement since Phase 1 (test files counted as covered source; true coverage 76.48% vs the 80 gate). Remediation was constitution-correct (backfill + dead-code removal, no threshold cut, landed same-day) → honest **81.52%**, a real margin of only 1.52 pts. Stale "85.57%" figures in earlier reports must not be trusted. Workers' 73.72% was never inflated — a true, unmoved deficit. Lesson generalizes: when arming gates for other packages (QA-14), exclude test globs explicitly.

**Conflict log:** No inter-domain contradictions this cycle. Resolved tensions: SA-14 (Medium, per-table isolation) vs DA-1 (High) — same fix, resolved to High under Data ownership (active production failure, business impact tiebreaker). Platform's "~13 months since install" for A131 corrected to ~1 month (installed 2026-06-11). v4's "85.57%" core-api coverage figure superseded by QA-15's measured 81.52%. v4's perf PE-M2 claim ("no batch embedding support") corrected — `embedBatch()` exists, merely unwired.

---

## Remediation Roadmap

### Immediate (Critical / actively failing — this weekend)
1. **DA-1/A135** — migration 0036 + per-table try/catch + init-schema regen + prod `retention_audit` verification (Data; half-day). *The only finding failing in production right now.*
2. **PLT-C1/A134** — deploy.md §5/§8 rewrite using Entry 183's proven sha-tag re-pull procedure (Platform; ~1h).
3. **SEC-A1/A136** — voice-pipecat: bind loopback or stop the container; add to ADR-0002 port table + SECURITY.md (Security; ~1h).
4. **RC-10** — repo visibility owner decision (Risk; minutes).

### Short-term (High — within 30 days)
1. **RC-19** — dated operator-actions checklist on the monthly-audit cadence + heartbeat alerts (Risk; small). *Do this first — it is the forcing function for everything else on this list.*
2. **QA-1/SW5-H1** — workers test catch-up (~493 lines: scheduler.ts, skill-execution.ts, ingest-process.ts, memory-consolidation-query.ts), then add `--coverage` to the workers test script (QA/SW; 2–3 days).
3. **SW5-H2/perf PE-H1** — context/token budget in `runAgent()` + truncated tool returns in monthly-reflection — fixes #204 class-wide (SW; 1 day).
4. **PLT-H1/H3** — runbook reconciliation sweep: deploy.md §4/§7, observability.md, create slo-alert.md (Platform; half-day).
5. **PLT-H2/H4 + A131** — one live-host session: alert-delivery test, offsite/rehearsal cron-log check, then add a backup freshness gauge + rule (Platform; half-day on-host).
6. **Voice Bearer phase 2** — set `VOICE_CAPTURE_SECRET` in prod (makes D132's acceptance real; closes IA-M2/SEC-A3/RC-11) (minutes on-host + iOS Shortcut header).
7. **SEC-B1 (NEW)** — bump `@hono/node-server` ≥ 1.19.13 (GHSA-92pp-h63x-v22m serveStatic bypass; live runtime path via Bull Board static assets, LAN-only) (one line).
8. **QA-7** — email-worker `tsc --noEmit` CI step + ~10-case vitest suite BEFORE merging the open workers-types 4→5 / postal-mime Dependabot PRs (small).
9. **Platform PE-M9** — watch one post-merge build-images run when merging #239–#242 GH Actions majors; add publish-failure alerting or a digest check to the deploy procedure (small).

### Medium-term (Medium — within 90 days)
1. **QA-2** — full-stack ingest e2e compose in CI (unblocks QA-3's Playwright wiring and QA-11 a11y).
2. **QA-3** — web-next component tests for top pages + wire the Playwright smoke into CI.
3. **QA-4** — promote `validate-schema` + `python-lint` to required checks; promote CodeQL once its signal stabilizes (QA-6r).
4. **SEC-A2 (RI)** — owner decision on mobile ingress: route mobile around proxy.ts's caller overwrite so Bearer auth is reachable, or document CF Access as the sole mobile control and remove the dead code path.
5. **IA-M1** voice-spool 409 poison-pill (dead-letter after N attempts); **IA-M3** minimal OpenAPI or shared client types for the slack-bot drift shims; **IA-M4** outbound-dependency metrics per the ADR-0004 telemetry contract.
6. **Perf PE-M1** `.max()` cap on search offset; **perf PE-M2** wire the existing `embedBatch()` into the chunk-embed path; **perf PE-M3/IA-M5/#217** BullMQ repeatable-job reconciliation on startup.
7. **SA-5** t1_spark fallback chain + fail-fast `validateTaskRouting()` in `load()`; **SA-6** TDD/README architecture-claims sweep (the "migrations run automatically" sentence at TDD.md:4035, container counts, ADR-0003 status).
8. **Platform PE-L6** add `pip` + `docker` ecosystems to dependabot.yml; **RC-13** document `BWS_ACCESS_TOKEN` in the secrets template/map.
9. **doc-sync** — promote from observe mode or delete it (PE-M7/QA-10); the current state is worse than either.

### Opportunistic (Low)
- The two `durationMs > 0` → `>= 0` flake one-liners (QA-9 — third cycle; correct pattern already exists at weekly-brief.test.ts:634).
- `._*` in .gitignore; close #226; CHANGELOG/OPEN_ITEMS/README-version refresh; correct stale coverage figures in docs to 81.52%.
- IA-L6 SMTP timeouts (nodemailer defaults allow ~10-min stalls vs the 15s convention); SW5-L12 core-api MCP-server coverage headroom (1.52 pts); `.npmrc` with `legacy-peer-deps` in both cloudflare dirs; pnpm.overrides expiry annotations; container USER directives (SEC-A6); ESLint expansion + `--max-warnings` ratchet (QA-12); real-sleep test sites (QA-13); shared-package coverage visibility (QA-14); remaining perf PE-L items per the performance findings file.

---

## Risk Acceptance Register

| Finding | Domain | Severity | Acceptance Rationale | Owner |
|---------|--------|----------|---------------------|-------|
| core-api `0.0.0.0:3002` LAN exposure | Security | Medium | D131 (ADR-0002 amendment): reliability over purity — dual-bind has a dockerd/tailscaled boot race; OpenClaw depends on LAN reach. Trusted-LAN + Bearer-on-MCP mitigations. | Troy (accepted 2026-06-30) |
| voice-capture `0.0.0.0:3001` with Bearer | Security | Medium | D132: Bearer is the control, LAN bind stays for iOS Shortcut latency. **⚠ Acceptance currently INVALID — predicated on `VOICE_CAPTURE_SECRET` being set, which it is not (~6 weeks). Becomes valid the moment the secret is set.** | Troy (conditional) |
| Prompt-injection residual in agent skills | Security | Low | SEC-A4: SafePromptBuilder at 12+ call sites; single-user system over own data; full mitigation impossible with current LLM tooling. | Troy (accepted v4) |
| Loki drop-on-unreachable log mode | Platform | Low | Docker loki driver falls back to `none`; accepted for a single-node home lab vs. buffering complexity. | Troy (accepted P11a) |
| Single-user no-auth core design | Solutions | — | By design (PRD); perimeter controls (CF Access, tunnel, LAN) substitute for app-layer auth. Revisit only if user count changes. | Troy (design) |
| `temporal_weight` 0.0 cold start | Data | Low | Deliberate cold-start default pending usage data. | Troy |
| Repo PUBLIC (RC-10) | Risk | High | **NOT accepted — pending owner decision since Phase 10.4. Must be either flipped private or explicitly accepted here by v6.** | Troy (decision due) |

---

## Domain Report Index

| Domain | File | Finding Count |
|--------|------|--------------|
| Solutions Architect | `arch-review/findings/solutions-architect.md` | 14 (M:10 L:4, RI:3) |
| Data Architect | `arch-review/findings/data-architect.md` | 13 (H:1 M:5 L:5, RI:2) |
| Integration Architect | `arch-review/findings/integration-architect.md` | 12 (M:6 L:6) |
| Software Engineer | `arch-review/findings/software-engineer.md` | 24 (H:3 M:5 L:14, RI:2) |
| Performance Engineer | `arch-review/findings/performance-engineer.md` | 12 (H:1 M:3 L:7, RI:1) |
| QA Architect | `arch-review/findings/qa-architect.md` | 16 (H:3 M:4 L:8, RI:1) |
| Security Architect | `arch-review/findings/security-architect.md` | 8 (H:1 M:3 L:4, RI:1) |
| Platform Engineer | `arch-review/findings/platform-engineer.md` | 19 (C:1 H:4 M:9 L:5, RI:3) |
| Risk & Compliance | `arch-review/findings/risk-compliance.md` | 11 (H:2 M:3 L:5, RI:1) |

**What is working well (credit where due):** pattern fit 5/5 — the monorepo + config-as-data + BullMQ-skills architecture remains right for this scale; the D134 three-wave Dependabot remediation is the strongest change-management evidence any cycle has produced (digest-verified rollback anchors, isolated waves, constitution-correct coverage fix); injection posture verified clean (Drizzle parameterization, `toPgTextArray`/`pgUuidArray`, timing-safe validators); secrets discipline holds (zero hardcoded secrets, redaction guards green); CodeQL + grouped Dependabot automation landed since v4; the schema-fidelity machine (generated init-schema + parity CI + ledger) continues to hold the DA-H1 drift class at zero.
