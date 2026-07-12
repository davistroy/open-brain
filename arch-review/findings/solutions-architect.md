# Solutions Architect Findings

**Reviewer:** Solutions Architect
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High — full source access, exceptional documentation, and a narrow verified delta since v4 (only Dependabot PRs #232–#234 + Dependabot config `cd14c1f` merged). Three findings remain Requires Investigation (live host / shared observability stack out of scope).

> **v5 — supersedes the 2026-07-09 v4 findings.** Per review protocol, every v4 finding was adjudicated against current code before net-new hunting. Verified delta since v4: `git log` shows 12 commits, all Dependabot remediation (Waves 1–3: transitive lockfile refresh, nodemailer 8→9, vitest 2→3 + coverage-v8 lockstep, core-api dead-code removal + coverage backfill) plus `.github/dependabot.yml` (grouped weekly updates + auto security fixes). No compose, config, docs, or architecture code changed — so all 13 v4 findings were re-verified rather than assumed.

---

## Prior-Review Adjudication (v4 → v5)

| v4 ID | v4 Sev | Verdict | Evidence (verified 2026-07-12) |
|-------|--------|---------|-------------------------------|
| SA-1 dual-bind repo↔prod drift | Medium | **STILL OPEN** | `docker-compose.yml:120-124` still encodes `127.0.0.1:3002` + `${TAILSCALE_IP}:3002` dual-bind with the "NOT 0.0.0.0" comment; production runs `0.0.0.0:3002` (D131) via manual sed. **Interlock worsened by PLT-C1/A134 (platform domain, CRITICAL, still open):** `docs/runbooks/deploy.md` rollback procedure `cat >`-overwrites then `rm`-deletes the production `docker-compose.override.yml` that pins the postgres/redis raw binds — the same override-file coupling class. |
| SA-2 alert-rule/dashboard ownership seam | Medium (RI) | **STILL OPEN** | `config/prometheus/alerts/` + `config/grafana/dashboards/` unchanged since v4 (no commits touched `config/`); ADR-0004 still assigns no owner or sync mechanism. Remains Requires Investigation (shared stack repo out of scope). |
| SA-3 Ollama/Gitea out-of-band network joins | Medium | **STILL OPEN** | `scripts/post-compose-up.sh` unchanged; header lines 10–13 still instruct the retired `docker compose --profile observability up -d` (stale since ADR-0004). Script still required after every `up`. |
| SA-4 dual voice stacks + voice-pipecat outside exposure model | Medium (RI) | **STILL OPEN — escalated cross-domain** | `docker-compose.yml:259-260` still publishes `"8765:8765"` / `"8766:8766"` (0.0.0.0); grep of `packages/voice-pipecat/src/` finds no bearer/auth/secret beyond provider API keys; issues #54/#57 still open. Now also a Go-condition as SEC-A1/A136 (security domain High). Architectural finding (dual stack + ADR-0002 omission) kept Medium here to avoid double-count. |
| SA-5 fallback crosses constraint/cost boundary | Medium | **STILL OPEN** | `config/ai-routing.yaml:119` still `t1_spark.fallback: t1_fast` (free openai_compat JSON-mode → paid Anthropic without `response_format`); `loader.ts` `validateTaskRouting()` still non-fatal and still called only from `reload()` (line 115), not `load()`. |
| SA-6 doc drift incl. dangerous TDD §16 sentence | Medium | **STILL OPEN — nothing fixed** | `docs/TDD.md:4035` still says "Migrations run automatically via core-api entrypoint script (no manual step needed)" — verbatim, still the exact opposite of the ledger model. README:9 still "Waves 3–4 … remain"; README:222 still "all 17 containers … plus the 4-service observability stack"; `docs/PRD.md:1532,1893` still `--profile observability`; ADR-0003 status still "Proposed"; OPEN_ITEMS.md still "Last reconciled: 2026-06-30". |
| SA-7 web-next healthcheck probes `/dashboard` | Low | **STILL OPEN** | `docker-compose.yml:420-421` unchanged: `wget -qO- http://127.0.0.1:3001/dashboard` every 30 s. |
| SA-8 local-dev portability (external net + hard-coded inboxes) | Low | **STILL OPEN** | `docker-compose.yml:8-9` `observability: { external: true }` with no dev-setup doc; lines 484/519 still hard-code `/mnt/user/appdata/open-brain/{financial,utility}-inbox`. |
| SA-9 workers coverage gate dormant on the orchestration spine | Medium | **STILL OPEN — CHANGED (slightly worse)** | `packages/workers/package.json:17` `test` script still omits `--coverage` (core-api's has it). Vitest 2→3 (PR #234, `^3.2.6`) re-baselined coverage measurement: core-api got dead-code removal + test backfill for unmasked files (`8d3b426`, `b828fb5`); **workers got no equivalent backfill** — live baseline now 73.72% vs the 78 floor (was 74.02% at v4). The gap between constitution and enforcement widened. |
| SA-10 runAgent lacks accumulated-context cap (#204) | Medium | **STILL OPEN** | `packages/shared/src/services/run-agent.ts` has `maxIterations` (default 10) and per-turn token *accounting* (`AgentTokenUsage` accumulator) but no accumulated-context *ceiling*; issue #204 open. |
| SA-11 `NEXT_PUBLIC_API_URL` comment/value contradiction | Low | **STILL OPEN** | `docker-compose.yml:412-414` verbatim: comment "intentionally empty in Docker" above `NEXT_PUBLIC_API_URL: http://core-api:3000`. |
| SA-12 PRD claims a circuit breaker that doesn't exist | Low | **STILL OPEN** | `docs/PRD.md:1531` verbatim: "Circuit breaker on external API calls (Anthropic, OpenAI)". Actual mechanisms unchanged (budget hard-stop + fallback chains + `maxRetries: 0`). |
| SA-13 scheduled offsite/rehearsal runs never verified | Medium (RI) | **STILL OPEN** | No repo evidence of verification since v4 (only Dependabot commits landed); live host out of scope. Remains Requires Investigation. |

**Adjudication summary: 13/13 v4 findings STILL OPEN; 0 FIXED; 1 CHANGED (SA-9, marginally worse).** The Dependabot remediation was real and valuable (119→20 alerts, 0 critical) but touched none of the architectural findings. Notably, the four v4 Go-conditions (PLT-C1, DA-1, SEC-A1, RC-10 — owned by other domains) are also all still open, and DA-1's fix deadline (Sunday 2026-07-12 02:00) **passed unmet this morning** — see net-new SA-14 for the structural angle this review owns.

---

## Architecture Summary

Open Brain is a single-user, self-hosted knowledge system built as a **pnpm monorepo with coarse-grained service decomposition by runtime concern**: one Hono API (`core-api`, embedding the MCP endpoint), one BullMQ worker container (jobs + skills + scheduler), and thin edge adapters (slack-bot, voice-capture, voice-pipecat, file-ingestion, Python sidecars, Cloudflare email worker), all sharing one Postgres 16 + pgvector store and one Redis queue, deployed as 13 Compose containers on a single Unraid host, with observability delegated to an external shared stack (ADR-0004). The architecture is unchanged since v4; the only movement is dependency currency (Dependabot waves + automation config).

## Requirements Fidelity Matrix

Unchanged from v4 — no functional or NFR-relevant code merged since. Re-affirmed rows with open gaps:

| Requirement | Architectural Coverage | Gap? |
|-------------|----------------------|------|
| F01–F23, F28, F36–F47 (capture/pipeline/search/skills/entities/web/MCP) | As v4 — verified landed, no regression | No |
| F09–F10, F47 voice | Two parallel stacks still both in production; decision #57 still blocked on soak #54 | Partial (SA-4) |
| F24 URL/bookmark capture | None — still "Planned" | Yes (acknowledged) |
| PRD §7 performance targets | SLO recording rules' runtime home still unverified post-ADR-0004 | Partial (SA-2) |
| PRD §7 "Circuit breaker on external API calls" | Budget hard-stop + fallback chains only; no trip-state breaker | Partial (SA-12) |
| PRD §7 backup/DR | Designed, still not demonstrated via verified scheduled run | Partial (SA-13) |
| PRD §7 security posture | voice-pipecat 8765/8766 still outside ADR-0002 exposure model | Partial (SA-4) |
| CLAUDE.md retention requirement (RC-4) | `data-retention-prune` exists but is **actively failing** — FK block + no fault isolation | **Yes** (SA-14 / DA-1) |

## Design Decision Log

The nine v4 decision assessments stand unchanged (coarse decomposition: Sound; pgvector single-store: Sound; queue-name decoupling: Sound; cost-tiered routing: Sound-with-SA-5-edge; init-schema ledger machine: Sound; ADR-0004: Sound-in-topology/incomplete-in-ownership; ADR-0002+D131: settled acceptance with Problematic implementation (SA-1); frontend type-mirror decoupling: Sound; D31 out-of-band Ollama/Gitea: Questionable). One net-new decision to log:

### Decision: Dependabot grouped weekly updates + automated security fixes (`cd14c1f`, 2026-07-11)
- **What it solves:** Recurrence of the 119-alert backlog class; isolates majors for individual review while batching minor/patch noise into single weekly PRs across root npm + both Cloudflare worker dirs.
- **What was chosen:** `version: 2` config, weekly Monday cadence, `groups:` minor/patch, per-ecosystem commit prefixes.
- **Likely rejected alternatives:** Daily cadence (noise vs. strict `--frozen-lockfile` CI); no automation (proven to decay — 119 alerts).
- **Assessment:** Sound
- **Rationale:** Correct cadence/grouping trade-off for a solo maintainer with two required CI checks. Watch item: 9 Dependabot PRs (#235–#243) were already open at review time — the automation only pays off if the weekly merge discipline is sustained; an unmerged Dependabot queue is the same decay in a new costume.

## NFR Coverage Scorecard

| NFR | Score (1–5) | Evidence | Gap |
|-----|-------------|----------|-----|
| Availability | 3 | Unchanged from v4 (restart policies, healthchecks, ordered deps, patient retries) | Single host by design; web-next healthcheck conflation (SA-7); SLO rule runtime home unverified (SA-2) |
| Scalability | 4 | Unchanged (HNSW push-down, stored tsvector, Qdrant pre-gated at ≥50K) | Agent-loop context still uncapped (SA-10/#204) |
| Maintainability | 4 | v4 evidence **plus** Dependabot automation (`cd14c1f`) and alert burn-down 119→20/0-critical — dependency currency is now a process, not an event | Workers coverage gate still dormant, baseline slid to 73.72% post-vitest-3 (SA-9); doc-drift cluster untouched including the dangerous TDD §16 sentence (SA-6); 9 Dependabot PRs queued |
| Observability | 3 | Unchanged (histograms, SLO.md, Loki driver, Pushover, ai_audit_log) | Rule/dashboard ownership seam (SA-2); pipecat spend visibility unconfirmed (SA-4); **retention-job failure mode is silent-by-abort** (SA-14) |
| Portability | 3 | Unchanged (containerized, YAML config, BWS secrets, GHCR) | External-network + hard-coded inbox paths (SA-8); Ollama/Gitea out-of-band (SA-3) |
| Recoverability | 4 | Unchanged (exact-count manifests, offsite crypt copy-not-sync, rehearsal script) | Scheduled runs still unverified (SA-13); rollback runbook actively re-arms the volume landmine (PLT-C1, platform domain) |

## Architecture Pattern Assessment

- **Pattern identified:** Modular monorepo deployed as coarse-grained cooperating services ("distributed monolith done on purpose") — unchanged.
- **Fit score:** 5
- **Rationale:** As v4 — the pattern has empirically absorbed two years of feature classes without a rewrite; failure domains that matter are isolated; everything wasteful to distribute is shared.
- **Specific concerns:** (1) The *out-of-band coupling* class (SA-1/SA-2/SA-3 + platform's PLT-C1) is now the dominant open-risk theme for the second consecutive review — zero of its instances moved between v4 and v5. (2) A second theme is emerging: **"designed-but-not-demonstrated / configured-but-not-enforced"** — coverage gate dormant (SA-9), retention job failing its charter (SA-14), DR unverified (SA-13), doc-sync observe-only (SA-6 root cause). The architecture's control surfaces exist; several are not armed.

## Structural Risk Register

Carried-forward items retain their v4 IDs; full evidence is in the adjudication table above. Recommendations restated only where they changed.

| ID | Finding | Severity | Component | Recommendation |
|----|---------|----------|-----------|----------------|
| SA-1 | Repo compose contradicts accepted ADR-0002 amendment (dual-bind vs. production `0.0.0.0:3002` via sed); now compounded by the rollback runbook deleting the production override (PLT-C1 interlock). Failure modes unchanged: boot-race bind failure from repo-as-written; missed sed silently breaks OpenClaw MCP. | Medium | docker-compose.yml:120-124, docs/runbooks/deploy.md | Parameterize: `"${CORE_API_BIND_IP:-127.0.0.1}:3002:3000"`, homeserver `.env` sets `0.0.0.0`; delete the sed step; fix the rollback procedure jointly with PLT-C1 (append-to-override, never overwrite/delete). |
| SA-2 | Alert rules (7 files incl. `slo.yml`) + 3 Grafana dashboards remain repo-resident with no in-compose consumer and no ADR-0004 ownership/sync definition. Failure mode: SLO alerting silently drifts or goes dark. | Medium — **Requires Investigation** | config/prometheus/alerts/, config/grafana/dashboards/, ADR-0004 | Unchanged: verify which copy is live in the observability project; assign exactly one owner. |
| SA-3 | Ollama (`t0_local`) and Gitea (wiki git remote) re-joined by `post-compose-up.sh` after every `up`; skipping it silently degrades the t0 tier (masked by fallback) and breaks wiki git ops. Header still cites the retired observability profile. | Medium | scripts/post-compose-up.sh, docker-compose.yml | Unchanged: apply the ADR-0004 external-network pattern declaratively; at minimum add a resolve-check to the config-diff gate and fix the stale header. |
| SA-4 | Dual voice stacks in production indefinitely; voice-pipecat publishes `0.0.0.0:8765/8766` with no auth found, holds Deepgram+Anthropic keys, absent from ADR-0002/SECURITY.md; #57 blocked on #54 since ~April. Security domain now carries this as Go-condition SEC-A1/A136 (High). Failure mode: any LAN host can burn paid Deepgram/Anthropic spend, possibly outside `ai_audit_log` budget visibility; ~12.5 GB reserved memory + duplicated ingest path. | Medium — **Requires Investigation** (session gating; budget visibility of pipecat spend) | voice-pipecat compose ports 259-260, ADR-0002, issues #54/#57 | Unchanged: extend the exposure model to 8765/8766 (loopback/Tailscale bind or Bearer mirroring D132); time-box #54 and retire the losing stack. |
| SA-5 | `t1_spark.fallback: t1_fast` silently crosses free→paid and openai_compat→anthropic for JSON-mode extraction tasks; `validateTaskRouting()` non-fatal and reload-only. Failure mode: Spark outage during bulk ingest converts a free JSON-mode path into paid Anthropic without the JSON contract — the $100-incident class. | Medium | config/ai-routing.yaml:119, packages/shared/src/config/loader.ts:60,115 | Unchanged: machine-check constraint classes (tier capability tags; fallback hop skips incompatible tiers); run validation in `load()`; consider `fallback: null` for JSON-mode extraction (queue-and-retry, matching the embeddings stance). |
| SA-6 | Doc-drift cluster with one actively dangerous item: TDD:4035 still instructs auto-migration (opposite of the ledger model — an operator following it deploys against a stale schema). README 17-containers/Waves-remain, PRD `--profile`, ADR-0003 "Proposed", OPEN_ITEMS stale — all unmoved since v4. Root cause unchanged: doc-sync CI observe-only. | Medium | docs/TDD.md:4035, README.md:9,222, docs/PRD.md:1532,1893, docs/adr/ADR-0003, OPEN_ITEMS.md | Fix TDD:4035 immediately (safety). Second consecutive review flagging the identical lines — promote doc-sync to enforcing for container-count/version/migration-model assertions; flip ADR-0003 to Accepted. |
| SA-7 | web-next healthcheck probes full-SSR `/dashboard` every 30 s — conflates liveness with core-api health; degraded upstream can restart-loop a healthy web-next. | Low | docker-compose.yml:420-421 | Unchanged: probe a static asset or trivial `/api/healthz`. |
| SA-8 | Bare `docker compose up` fails without the external `observability` network (undocumented for dev); financial/utility inbox host paths hard-coded to Unraid layout. | Low | docker-compose.yml:8-9,484,519, README | Unchanged: document `docker network create observability`; parameterize the two inbox paths. |
| SA-9 | Workers coverage gate configured (78/81) but `test` script omits `--coverage`; orchestration spine (`skill-execution.ts`, `scheduler.ts`, `ingest-process.ts`) at 0%. **v5 delta:** vitest 3 re-baselined measurement to 73.72% and core-api received an unmasked-file backfill while workers did not — the enforcement gap widened. | Medium (primary owner: QA domain) | packages/workers/package.json:17, vitest.config.ts | Execute the test catch-up sized against the *vitest-3* baseline (the ~447-line estimate is now stale), then arm `--coverage` atomically. Never lower the threshold. |
| SA-10 | `runAgent` bounds iterations and *accounts* tokens but never *caps* accumulated context — the #204 6.5M-token blowup class is inherited by every agent skill. | Medium | packages/shared/src/services/run-agent.ts, #204 | Add a running token-estimate ceiling to the loop (fail or summarize-and-continue) — the accumulator already exists (`AgentTokenUsage`), so the ceiling is a small delta on present code. |
| SA-11 | `NEXT_PUBLIC_API_URL: http://core-api:3000` under a comment saying "intentionally empty in Docker"; browser-prefixed var carrying an internal Docker hostname is a future-client-component footgun. | Low | docker-compose.yml:412-414 | Unchanged: delete the var (server code prefers `API_URL`) or rename non-public; fix the comment. |
| SA-12 | PRD:1531 claims a circuit breaker on external API calls that does not exist as a mechanism. | Low | docs/PRD.md:1531 | Unchanged: reword to name actual mechanisms, or implement a trip-after-N-failures guard. |
| SA-13 | Recoverability designed but not demonstrated: first scheduled offsite + rehearsal runs still unverified; Unraid cron persistence is exactly the silent-failure class the design warns about. | Medium — **Requires Investigation** | scripts/offsite-backup.sh, scripts/restore-rehearsal.sh, Unraid cron | Unchanged: one-time verification of cron/Pushover receipts; add a "rehearsal ran within 8 days" freshness check so silence itself alerts. |
| SA-14 | **NET NEW.** `pruneRetentionData()` (`packages/workers/src/jobs/data-retention-prune.ts:74-120`) executes the 5-table `RETENTION_POLICY` in a single sequential loop with **no per-entry error isolation** — any table's failure aborts every subsequent entry and fails the whole job. Combined with the `briefs.source_skill_log_id → skills_log` FK (init-schema.sql:1816, no `ON DELETE`), the `skills_log` DELETE throws every Sunday; the DA-1 fix deadline (2026-07-12 02:00) **passed unmet this morning**, so the job has now failed at least twice and no migration 0036 exists (latest is 0035). Today the blocked table is last in the policy (lines 29-35), so the first four tables do prune — but that is ordering luck, not design: any FK/lock error on an earlier entry would silently skip all downstream retention, surfacing only as a BullMQ failed job with no `retention_audit` row for skipped tables. This is a fault-isolation design gap in a destructive scheduled job, distinct from (and outlasting) the specific FK fix DA-1 owns. **Failure mode:** partial or total retention stops silently; event tables (`pipeline_events`, `ai_audit_log`, …) grow unbounded until noticed via disk/DB bloat. | Medium (the operational FK failure itself is DA-1, High, data domain) | packages/workers/src/jobs/data-retention-prune.ts:80-120 | Wrap each policy entry in try/catch: record per-table success/failure in `retention_audit`, continue to the next entry, and fail the job at the end only if any entry failed (preserving alerting). Land alongside the DA-1 FK migration (0036) — the FK fix alone leaves the pattern fragile. |

## Evolution Assessment

The two-year runway assessment stands — the pattern itself is not the constraint. What changed between v4 and v5 is *velocity signal*: the only work merged was dependency hygiene (well-executed), while all 13 architectural findings, all 4 cross-domain Go-conditions, and one hard deadline (DA-1, this morning) sat untouched. The constraint ordering from v4 holds, with one amendment:

1. **Out-of-band coupling class (SA-1/SA-2/SA-3 + PLT-C1)** — still first; now a two-review-old fragility tax. The rollback-runbook interaction (PLT-C1) makes SA-1's fix genuinely urgent rather than merely cheap.
2. **The "configured-but-not-armed" control-surface class (SA-9, SA-13, SA-14, doc-sync)** — newly promoted to second place: the system's governance machinery (coverage gates, retention, DR verification, doc-sync) is increasingly *present but disengaged*, and SA-14 is the first instance where a disengaged control is actively failing its charter in production.
3. **Dual voice stack (SA-4)** — subtraction candidate; each month adds divergence and ~12.5 GB reserved memory.
4. **Four-surface enum lockstep / `@open-brain/shared` cohesion / workers-as-inner-monolith** — unchanged from v4, longer-horizon.

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 10 |
| Low | 4 |

Total 14 (13 carried forward STILL OPEN + 1 net-new SA-14). Three findings (SA-2, SA-4, SA-13) are additionally marked **Requires Investigation** — they depend on live-host or shared-stack state outside this read-only review's reach.
