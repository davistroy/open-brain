# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work. This file is a quick-reference summary only — close issues there, not here.

Last reconciled: 2026-06-30.

---

## Architecture Review v3 remediation (plan A132 — not in GitHub issues)

Tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md), not GitHub issues. **Waves 1–2 COMPLETE** (Phases 1–7 merged to `main`); **Waves 3–4 + a batched production-deploy window remain.**

| Remaining | Where |
|-----------|-------|
| Phase 8 (ingest edges + voice Bearer auth) | IMPLEMENTATION_PLAN.md Wave 3 |
| Phase 9 (convention→CI + governance/doc sweep, incl. PRD/TDD content) | Wave 3 |
| Phase 10 (residual lows + RI closeouts) | Wave 4 |
| **Deploy & Ops Backlog** (deploy Phases 6+7 + migration 0034; observability loopback via `systemctl restart docker`; upstream compose deviations) | IMPLEMENTATION_PLAN.md "Deployment & Ops Backlog" |
| Deferred: workers coverage Part B (74%<78), QA-M3 INGEST_E2E, INT-M2-voice | same |

---

## Open issues (10)

| # | Title | Gate / urgency |
|---|-------|---------------|
| [#54](https://github.com/davistroy/open-brain/issues/54)  | P24: Pipecat voice soak test | Manual — needs 10+ real conversations |
| [#57](https://github.com/davistroy/open-brain/issues/57)  | P25: Voice architecture decision | Blocked by #54 |
| [#71](https://github.com/davistroy/open-brain/issues/71)  | P23: Cognitive memory tuning | Data-gated — earliest ~2026-05-17 |
| [#72](https://github.com/davistroy/open-brain/issues/72)  | P34: NVIDIA RTX PRO 2000 deployment | Hardware purchase decision |
| [#73](https://github.com/davistroy/open-brain/issues/73)  | P33: Qdrant vector-search evaluation | Scale-gated — fires at ≥50K embeddings |
| [#196](https://github.com/davistroy/open-brain/issues/196) | Mobile app deferred scope (PRs #172/#174) | When mobile becomes a priority |
| [#200](https://github.com/davistroy/open-brain/issues/200) | Investigate large number of failures reported in the Dashboard | Awaiting user dashboard verification post-fixes |
| [#204](https://github.com/davistroy/open-brain/issues/204) | monthly-reflection skill: 6.5M-token context blowup | Low — fires monthly, fails fast |
| [#207](https://github.com/davistroy/open-brain/issues/207) | A83: 17 client-render `new Date()` hydration risks (cosmetic) | Cosmetic — TZ alignment neutralized blast radius |
| [#217](https://github.com/davistroy/open-brain/issues/217) | BullMQ scheduler: orphan repeat-jobs accumulate on cron schedule changes | Low — manual cleanup performed 2026-05-09; structural fix proposed |

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
