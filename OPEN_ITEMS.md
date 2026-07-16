# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work. This file is a quick-reference summary only — close issues there, not here.

Last reconciled: **2026-07-15 (late)** — verified against `gh issue list`: **15 open**. The previous "7 open" line was stale: it still listed **#278 as open** (closed 2026-07-15) and predated #281–#301.

---

## Architecture Review v3 remediation (plan A132 — FULLY DEPLOYED)

**Status: COMPLETE 2026-06-30 (Entry 179).** All 10 phases / 4 waves merged and deployed. Tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for reference.

---

## Architecture Review v5 remediation (plan A134–A137 — MERGED + largely DEPLOYED)

**Status: MERGED and deploying.** PR #244 (31/35 items, commits `d1729ee..c31d753`) merged to `main` as `cd287d8`; the `config/wiki/` cleanup (Entry 187) landed as `d0cde86`. All 8 phases (CS-A–CS-H) complete — see `LAB_NOTEBOOK.md` Entries 186–192.

The remaining work is **operator-gated** and tracked in **[`OPERATOR_ACTIONS.md`](OPERATOR_ACTIONS.md)** (the dated register). Deployed 2026-07-14: **OA-1** (migration 0036 → retention-prune unblocked + workers on the new image; closed #204/#217 on deploy), **OA-2** (repo → private then **reverted to public**; branch protection re-created with 4 required checks), **OA-8**/**OA-13** done, OA-17 obsolete. **OA-14 DONE 2026-07-14** (all 5 GHA-major Dependabot PRs merged one-at-a-time, each post-merge `build-images` green). **OA-9 (deploy portion) + OA-15 DONE 2026-07-14** (Entry 197 full-fleet deploy → non-root images live, named volumes chowned). **Decisions:** OA-4a **won't-do** (keep broad VM BWS token, D137); **Plaid dropped** (D138 — financial data re-sourcing TBD; "provision Plaid secrets" cancelled). Still open there: OA-6 (voice Bearer), OA-7 (mobile ingress / U3), OA-9 residual (b) `WorkersMetricsAbsent` alert test + (c) workers `/backup-latest` mount, OA-10 (postgres `shm_size`, needs a postgres recreate), OA-11 (vendor terms), OA-12 (Gmail OAuth), OA-16 (rehearsal Pushover).

---

## Open issues (15)

**Planned in [`IMPLEMENTATION_PLAN-2026-07-backlog.md`](IMPLEMENTATION_PLAN-2026-07-backlog.md)** (ultra-plan Phase 0–4, LAB_NOTEBOOK Entries 208–209). Phase order is by dependency + risk, not issue number.

| # | Title | Gate / urgency |
|---|-------|---------------|
| [#299](https://github.com/davistroy/open-brain/issues/299) | `backup.sh` omits **every `config/` subdirectory** from all backups — non-recursive glob, errors swallowed | **HIGH — LIVE GAP.** `prometheus/`, `grafana/`, `financial/`, `utility/`, `cloudflare/` are in **no** backup, local or offsite, while the log says "Backing up config files". Recovery-only, invisible until it matters. Plan Phase 4. A143 / Entry 208 |
| [#294](https://github.com/davistroy/open-brain/issues/294) | Backup dead-man's switch fully inert | **HIGH but CHEAP.** The `/backup-latest` mount is **already in compose** (`:195,202`) — workers was just never recreated. **Fix = a recreate, not code.** Plan Phase 2. Also needs the `BackupStale` **name collision** with Unraid's alert resolved (Phase 6) |
| [#300](https://github.com/davistroy/open-brain/issues/300) | `INGEST_TRIGGER_SECRET` skips the 3-step lockstep | MEDIUM, DR-only. **2-line fix** (map + template). DR starts both sidecars unauthenticated → 401s every HTTP trigger **while cron keeps working and looks healthy**. Plan Phase 5. A144 |
| [#281](https://github.com/davistroy/open-brain/issues/281) | `.env` not automated — a rebuilt host can't start the stack | **HIGH, DR-only.** ⚠️ Issue names the wrong var: **`POSTGRES_PASSWORD` trips first**, and `REDIS_PASSWORD` **is** mapped — it's a **file-target mismatch** (restored to `.env.secrets`, which interpolation can't read). Fix = **D145** (eliminate secret interpolation). **CI-verifiable today.** Plan Phase 5 |
| [#290](https://github.com/davistroy/open-brain/issues/290) | obvm is a hand-copied, 3-month-stale tree with no `.git` | **Decision-gated → resolved: D144 = DECOMMISSION.** Gates #282. Prove parity first (Plan Phase 3). Finishes G-B.2/G-B.5, open since 2026-04-17 |
| [#298](https://github.com/davistroy/open-brain/issues/298) | Remove `voice-pipecat` | **D143.** Zero clients repo-wide; superseded by the decided PWA voice architecture. Makes **D135 moot**. Plan Phase 7 |
| [#292](https://github.com/davistroy/open-brain/issues/292) | Alert rules in this repo are **not deployed** | MEDIUM. Entry 207: **parity gate FIRST**, migrate later. Refinement: the deployed dir is **755** → a read-only check **can** run as `claude`. Plan Phase 6 |
| [#295](https://github.com/davistroy/open-brain/issues/295) | All scheduled jobs run **UTC** — morning brief fires 02:30 ET | MEDIUM. ⚠️ Re-keys every job (4–5h shift) **and lands the BullMQ morning cluster on top of the host-cron ingest cluster**. Land deliberately. Plan Phase 8 |
| [#285](https://github.com/davistroy/open-brain/issues/285) | Cobb Water 401 — `water_readings` empty since day one | **Operator-gated (B2C OIDC + MFA).** ⚠️ Issue's premise is wrong: the *"confirmed via HAR analysis"* citation **predates the analysis by 8h**, and the API was **never anonymous**. 3 more independent blockers. **Probe risks account lockout.** Plan Phase 1 (honest status) + 9 |
| [#286](https://github.com/davistroy/open-brain/issues/286) | Cobb EMC never worked — Dockerfile pulls a 404 repo, `\|\| true` hides it | **Scoping decision needed — it's an unbuilt feature, not a bug.** Nothing invokes the binary; the CSV parser is unwritten; `data_dir` isn't a volume. Plan Phase 1 (Dockerfile + smoke test) + 9 |
| [#282](https://github.com/davistroy/open-brain/issues/282) | Gmail OAuth dead since 2026-04-21 | **Operator-gated (Google Console).** ⚠️ Premise wrong: `gmail_token_cache` is a **different** client. **Reduced by D144 to: publish the OAuth app** — required either way, since the TS client shares the OAuth client + 7-day clock. Plan Phase 3/10 |
| [#284](https://github.com/davistroy/open-brain/issues/284) | ~213 spurious 404s/run | **DROPPED by D144** — dies with obvm. ⚠️ Root cause was wrong (`detect_corrections`, not `cleanup_spam`) and it is **not cosmetic**: Hotmail correction detection **never worked**. Carry the lesson: does the **TS** path repeat the Graph move-id bug? |
| [#301](https://github.com/davistroy/open-brain/issues/301) | faster-whisper → speaches migration | **OUT of scope (D146)** — a migration, not a fix; own brainstorm. Urgency downgraded: **loopback-only**, not internet-facing. After #298 |
| [#71](https://github.com/davistroy/open-brain/issues/71)  | Cognitive memory tuning | Data-gated. ⚠️ Contains a real bug: **`temporal_weight` GET=0.0 vs POST=0.1**. Related-captures **backend is built and unused**. Plan Phase 9 |
| [#196](https://github.com/davistroy/open-brain/issues/196) | Mobile app deferred scope | When mobile becomes a priority. None of the 5 items exist; **EAS Build gates push**. OA-7 blocked on U3 |

---

## Recently closed

**2026-07 session (arch-review v5 deploy + Bucket-A):**

| # | Closed | Via |
|---|--------|-----|
| #54 | 2026-07-15 | Pipecat soak test — **obsolete**: a 2-week manual soak of a service with **zero clients** (`grep WebSocket(` → nothing repo-wide; port 8765 in one non-doc file), whose capability is superseded by the decided **PWA + Web Speech** architecture. Superseded by #298 / D143. Entry 209 |
| #57 | 2026-07-15 | Voice architecture decision — **already answered by default**: voice-capture + faster-whisper is the only live path. Superseded by #298 / D143. Entry 209 |
| #72 | 2026-07-15 | RTX PRO 2000 — **superseded by the DGX Spark**, which already serves Qwen3.6-35B as `t1_spark` (free). A $549 card for a 9B is moot; the one unmet claim (local embeddings) is contradicted by D42. Entry 209 |
| #73 | 2026-07-15 | Qdrant evaluation — **premise falsified**, not untriggered. Sized from "OneDrive 100K–1M+ embeddings"; reality is **11,296** — 9× below its own trigger, ~45× below the pgvector ceiling it names. Entry 209 |
| #278 | 2026-07-15 | secrets-map.sh invented BWS names — **verified fixed**: the map now carries the real names (`PUSHOVER_API_TOKEN`, `PUSHOVER_USER_KEY`, `GITEA_TOKEN`), `SLACK_USER_TOKEN` demoted to OPTIONAL, count comment reconciled to 12. **#281 is orthogonal** (file-target, not naming) and **#300 is a distinct process violation** — do not merge them. Entry 209 |
| #275 | 2026-07-15 | gas therms NULL — bill-PDF parser rewritten to anchor on the bill's arithmetic + PyMuPDF added to the sidecar image (PR #276). **Verified in prod: 4/4 bills, 153.6 therms.** Entry 200 |
| #265 | 2026-07-15 | Gas South login 405/404 — auth repointed at the portal's dedicated auth host + required `ClientId` header (PR #273). Solved from the JS bundle, **no HAR needed**. Verified with real credentials. Entries 198-199 |
| #200 | 2026-07-14 | Dashboard failure count — honest pipeline-status display, `derivePipelineStatus()` decouples health from stale failures (PR #271). Verified live |
| #204 | 2026-07-13 | monthly-reflection 6.5M-token blowup — `runAgent` context budget (PR #244), deployed via OA-1 |
| #217 | 2026-07-13 | BullMQ orphan repeat-jobs — startup reconciliation (PR #244), deployed via OA-1 |
| #226 | 2026-07-14 | spreading-activation `record→uuid[]` — `pgUuidArray()` (PR #230), closed with evidence |
| #207 | 2026-07-14 | 17 client-render `new Date()` hydration risks — `useClientNow` hook (PR #262) |

**2026-05-09 cohesive remediation (plan complete):** [IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md](docs/archived/IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md) — 11-issue remediation, 7 phases (A–G): #197/#198/#199/#205 (greeting/hydration/Slack/orphans), #191–#195 (CI/test fixes), #177 (TanStack Query), #190 (ESLint 9). All shipped.

---

## Maintenance

- **To report a bug or feedback:** file a GitHub issue at https://github.com/davistroy/open-brain/issues/new
- **When an issue ships:** close it on GitHub with `Closes #N` in the PR commit message
- **This file:** update the table above when issues open/close; keep it as a quick snapshot, not a detailed spec
