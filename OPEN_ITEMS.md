# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work. This file is a quick-reference summary only — close issues there, not here.

Last reconciled: 2026-07-13.

---

## Architecture Review v3 remediation (plan A132 — FULLY DEPLOYED)

**Status: COMPLETE 2026-06-30 (Entry 179).** All 10 phases / 4 waves merged and deployed. Tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for reference.

---

## Architecture Review v4 remediation (plan A134–A137 — implemented on branch, pending merge/deploy)

**Status: 31/35 items implemented on branch `feat/arch-review-v5-remediation` (PR #244, NOT yet merged or deployed).** All 8 phases (CS-A–CS-H) complete — see `LAB_NOTEBOOK.md` Entry 186. Tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for reference.

The remaining 4 work items are operator-gated deferrals (live-host deploys, external verifications, repo-settings changes) that code alone can't complete. **See [`OPERATOR_ACTIONS.md`](OPERATOR_ACTIONS.md) for the dated register** — highlights: OA-1 (deploy migration 0036 + verify), OA-7 (mobile ingress, blocked on U3 CF-Access verification), OA-8 (promote required branch-protection checks), OA-9 (live-host verification session).

---

## Open issues (11)

| # | Title | Gate / urgency |
|---|-------|---------------|
| [#54](https://github.com/davistroy/open-brain/issues/54)  | P24: Pipecat voice soak test | Manual — needs 10+ real conversations |
| [#57](https://github.com/davistroy/open-brain/issues/57)  | P25: Voice architecture decision | Blocked by #54 |
| [#71](https://github.com/davistroy/open-brain/issues/71)  | P23: Cognitive memory tuning | Data-gated — earliest ~2026-05-17 |
| [#72](https://github.com/davistroy/open-brain/issues/72)  | P34: NVIDIA RTX PRO 2000 deployment | Hardware purchase decision |
| [#73](https://github.com/davistroy/open-brain/issues/73)  | P33: Qdrant vector-search evaluation | Scale-gated — fires at ≥50K embeddings |
| [#196](https://github.com/davistroy/open-brain/issues/196) | Mobile app deferred scope (PRs #172/#174) | When mobile becomes a priority |
| [#200](https://github.com/davistroy/open-brain/issues/200) | Investigate large number of failures reported in the Dashboard | Awaiting user dashboard verification post-fixes |
| [#204](https://github.com/davistroy/open-brain/issues/204) | monthly-reflection skill: 6.5M-token context blowup | **Fixed on branch** `feat/arch-review-v5-remediation` (PR #244) — `runAgent` context budget (per-tool-result 12KB cap + 150K-token cumulative early-stop); pending merge/deploy |
| [#207](https://github.com/davistroy/open-brain/issues/207) | A83: 17 client-render `new Date()` hydration risks (cosmetic) | Cosmetic — TZ alignment neutralized blast radius |
| [#217](https://github.com/davistroy/open-brain/issues/217) | BullMQ scheduler: orphan repeat-jobs accumulate on cron schedule changes | **Fixed on branch** `feat/arch-review-v5-remediation` (PR #244) — startup reconciliation removes orphaned repeatable jobs; pending merge/deploy |
| [#226](https://github.com/davistroy/open-brain/issues/226) | core-api: daily spreading-activation query errors "cannot cast type record to uuid[]" | **Fixed already (PR #230 / `1710c54`, `pgUuidArray()`), open only pending closure** — evidence + `gh issue close` command prepared in `docs/pending-issue-closures.md` (operator action OA-3) |

---

## Recently closed (2026-05-09 cohesive remediation, plan complete)

[IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md](docs/archived/IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md) — 11-issue remediation, 7 phases (A–G). All shipped.

| # | Phase | Closed via |
|---|-------|-----------|
| #197 | A/B — greeting fix | PR #201 + #206 |
| #198 | A/B — dashboard hydration / CORS | PR #206 + CF Access bypass app (2026-05-09) |
| #199 | A — Slack DM toggle | Manual admin toggle (2026-05-09) |
| #205 | A.5 follow-up — stale BullMQ orphans | Direct Redis cleanup (2026-05-09) |
| #191 | E.1 — IMPLEMENTATION_PLAN.md verification |  Audit comment |
| #192 | F — Vitest 2.x bump | PR #210 |
| #193 | E.3 — SSE onAbort coverage | Closed (won't-fix) |
| #194 | E.2 — TS2502 in entity-resolution.test.ts | PR #209 |
| #195 | G.3 — RTL migration MPill/TabBar | PR #216 |
| #177 | G.1 — TanStack Query hooks (22 domains) | PRs #211–#214 |
| #190 | G.2 — ESLint 9 + flat-config migration | PR #215 |

---

## Maintenance

- **To report a bug or feedback:** file a GitHub issue at https://github.com/davistroy/open-brain/issues/new
- **When an issue ships:** close it on GitHub with `Closes #N` in the PR commit message
- **This file:** update the table above when issues open/close; keep it as a quick snapshot, not a detailed spec
