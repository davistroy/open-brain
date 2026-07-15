# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work. This file is a quick-reference summary only — close issues there, not here.

Last reconciled: 2026-07-15 (verified against `gh issue list` — 7 open).

---

## Architecture Review v3 remediation (plan A132 — FULLY DEPLOYED)

**Status: COMPLETE 2026-06-30 (Entry 179).** All 10 phases / 4 waves merged and deployed. Tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for reference.

---

## Architecture Review v5 remediation (plan A134–A137 — MERGED + largely DEPLOYED)

**Status: MERGED and deploying.** PR #244 (31/35 items, commits `d1729ee..c31d753`) merged to `main` as `cd287d8`; the `config/wiki/` cleanup (Entry 187) landed as `d0cde86`. All 8 phases (CS-A–CS-H) complete — see `LAB_NOTEBOOK.md` Entries 186–192.

The remaining work is **operator-gated** and tracked in **[`OPERATOR_ACTIONS.md`](OPERATOR_ACTIONS.md)** (the dated register). Deployed 2026-07-14: **OA-1** (migration 0036 → retention-prune unblocked + workers on the new image; closed #204/#217 on deploy), **OA-2** (repo → private then **reverted to public**; branch protection re-created with 4 required checks), **OA-8**/**OA-13** done, OA-17 obsolete. **OA-14 DONE 2026-07-14** (all 5 GHA-major Dependabot PRs merged one-at-a-time, each post-merge `build-images` green). **OA-9 (deploy portion) + OA-15 DONE 2026-07-14** (Entry 197 full-fleet deploy → non-root images live, named volumes chowned). **Decisions:** OA-4a **won't-do** (keep broad VM BWS token, D137); **Plaid dropped** (D138 — financial data re-sourcing TBD; "provision Plaid secrets" cancelled). Still open there: OA-6 (voice Bearer), OA-7 (mobile ingress / U3), OA-9 residual (b) `WorkersMetricsAbsent` alert test + (c) workers `/backup-latest` mount, OA-10 (postgres `shm_size`, needs a postgres recreate), OA-11 (vendor terms), OA-12 (Gmail OAuth), OA-16 (rehearsal Pushover).

---

## Open issues (7)

| # | Title | Gate / urgency |
|---|-------|---------------|
| [#278](https://github.com/davistroy/open-brain/issues/278) | secrets-map.sh BWS names don't exist (11/14 required) — `load-secrets.sh` would exit 2, **DR path broken** | **New (2026-07-15), HIGH.** Prod is UNAFFECTED (the map is only read on reconcile) — but the documented "rebuild `.env.secrets` after a homeserver rebuild" runbook would write nothing. Confirmed by the repo's own `verify-secrets.sh`: `DRIFT: 11 of 14`. Never caught because `test-secrets-roundtrip.sh` mocks `bws` with the map's OWN names (self-consistent → cannot detect name drift) and no CI job checks real BWS. Needs BWS-project disambiguation (broad token spans 3 projects, D137). Entry 202 / A142. |
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
