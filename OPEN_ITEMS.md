# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work. This file is a quick-reference summary only — close issues there, not here.

Last reconciled: 2026-07-15 (verified against `gh issue list` — 12 open).

---

## Architecture Review v3 remediation (plan A132 — FULLY DEPLOYED)

**Status: COMPLETE 2026-06-30 (Entry 179).** All 10 phases / 4 waves merged and deployed. Tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for reference.

---

## Architecture Review v5 remediation (plan A134–A137 — MERGED + largely DEPLOYED)

**Status: MERGED and deploying.** PR #244 (31/35 items, commits `d1729ee..c31d753`) merged to `main` as `cd287d8`; the `config/wiki/` cleanup (Entry 187) landed as `d0cde86`. All 8 phases (CS-A–CS-H) complete — see `LAB_NOTEBOOK.md` Entries 186–192.

The remaining work is **operator-gated** and tracked in **[`OPERATOR_ACTIONS.md`](OPERATOR_ACTIONS.md)** (the dated register). Deployed 2026-07-14: **OA-1** (migration 0036 → retention-prune unblocked + workers on the new image; closed #204/#217 on deploy), **OA-2** (repo → private then **reverted to public**; branch protection re-created with 4 required checks), **OA-8**/**OA-13** done, OA-17 obsolete. **OA-14 DONE 2026-07-14** (all 5 GHA-major Dependabot PRs merged one-at-a-time, each post-merge `build-images` green). **OA-9 (deploy portion) + OA-15 DONE 2026-07-14** (Entry 197 full-fleet deploy → non-root images live, named volumes chowned). **Decisions:** OA-4a **won't-do** (keep broad VM BWS token, D137); **Plaid dropped** (D138 — financial data re-sourcing TBD; "provision Plaid secrets" cancelled). Still open there: OA-6 (voice Bearer), OA-7 (mobile ingress / U3), OA-9 residual (b) `WorkersMetricsAbsent` alert test + (c) workers `/backup-latest` mount, OA-10 (postgres `shm_size`, needs a postgres recreate), OA-11 (vendor terms), OA-12 (Gmail OAuth), OA-16 (rehearsal Pushover).

---

## Open issues (12)

| # | Title | Gate / urgency |
|---|-------|---------------|
| [#283](https://github.com/davistroy/open-brain/issues/283) | Jetson T1 tier 401s on 100% of calls since ~2026-07-01 | **New (2026-07-15), HIGH — actively degrading.** `llm-gateway.ts:276` hardcodes `apiKey:'local'` ("local endpoints ignore the key" — no longer true); `email-pipeline.py` sends none. 461 × `401 Invalid API Key` in `ai_audit_log`; the 6 classification tasks silently degrade. **No cost leak** (cost_usd 0 — the paid fallback isn't firing). Key exists + verified: BWS `dev/jetson/llm-api-key`. |
| [#281](https://github.com/davistroy/open-brain/issues/281) | DR gap #2: `.env` is not automated — a rebuilt host cannot start the stack | **New (2026-07-15), HIGH.** `REDIS_PASSWORD` lives only in `.env`; Compose interpolates `${}` from `.env`, never `env_file:`, and `load-secrets.sh` writes only `.env.secrets`. Sibling of #278 (fixed): DR now writes *half* of what's needed. Recovery-only failure. |
| [#282](https://github.com/davistroy/open-brain/issues/282) | Gmail OAuth dead since 2026-04-21 — `invalid_grant` | **New (2026-07-15).** No Gmail classified/captured in ~3 months; Hotmail masks it so the run still reports success. Almost certainly the OAuth app stuck in "Testing" (7-day refresh expiry, exactly what A31 predicted). Fix = publish the app to "In production", or move Gmail to an App Password over IMAP. **Owner action** (interactive consent). Supersedes OA-12. |
| [#285](https://github.com/davistroy/open-brain/issues/285) | Cobb Water API returns 401 — auth never implemented | **New (2026-07-15).** `water_readings` has been **empty since day one**. The HAR-era "no authentication required" docstring is now false. Credentials are in BWS but nothing uses them. Fix = the #265 bundle playbook (no HAR needed). |
| [#286](https://github.com/davistroy/open-brain/issues/286) | Power/Cobb EMC never worked — Dockerfile pulls from a nonexistent repo | **New (2026-07-15).** **Credentials are fine** (SmartHub login → HTTP 200, token). Dockerfile downloads `typ0/electric-usage-downloader` (**404 — org doesn't exist**; config has always said `tedpearson/`), wrong version (0.5.0 vs v2.4.1), wrong asset format, and a trailing `\|\| true` hides the failed download → green build, no binary. `cmd_power_summary` is still a stub. **Decide whether power ingestion is still wanted before investing.** |
| [#284](https://github.com/davistroy/open-brain/issues/284) | ~213 spurious 404s per email run from Hotmail `cleanup_spam()` | **New (2026-07-15), LOW.** Benign (items already gone) but drowns real errors — the condition that let #275/#282 hide. MS auth itself is healthy. Fix = treat `404 ErrorItemNotFound` as success, like #275's `409`-is-terminal-success. |
| [#196](https://github.com/davistroy/open-brain/issues/196) | Mobile app deferred scope (PRs #172/#174) | When mobile becomes a priority |
| [#73](https://github.com/davistroy/open-brain/issues/73)  | P33: Qdrant vector-search evaluation | Scale-gated — fires at ≥50K embeddings |
| [#72](https://github.com/davistroy/open-brain/issues/72)  | P34: NVIDIA RTX PRO 2000 deployment | Hardware purchase decision |
| [#71](https://github.com/davistroy/open-brain/issues/71)  | P23: Cognitive memory tuning | Data-gated |
| [#57](https://github.com/davistroy/open-brain/issues/57)  | P25: Voice architecture decision | Blocked by #54 |
| [#54](https://github.com/davistroy/open-brain/issues/54)  | P24: Pipecat voice soak test | Manual — needs 10+ real conversations |

---

## Recently closed

**2026-07 session (arch-review v5 deploy + Bucket-A):**

| # | Closed | Via |
|---|--------|-----|
| #278 | 2026-07-15 | secrets-map BWS names corrected + 4 secrets created from live values (PR #280). DR reconcile 11/14-missing → 1/11. Remaining drift row is #281, a different bug. Entry 203 |
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
