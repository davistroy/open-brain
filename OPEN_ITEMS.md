# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work as of 2026-05-09. This file is a quick-reference summary only — close issues there, not here.

---

## Active master plan

**[IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md](IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md)** — 11-issue cohesive remediation, 7 phases (A–G), ~14–18 h effort, sequenced by interaction dependencies.

| Phase | Closes | Brief |
|---|---|---|
| A — Stop the bleeding | #197 (greeting), #198 (CORS), #199 (Slack), #200 (744 failed jobs) | Model name fix in ai-routing.yaml, column typo, CF Access bypass, Slack admin toggle, failed-jobs cleanup |
| B — UI hydration unification | #197, #198 (RC1) | Time-aware greeting + `new Date()` audit |
| C — Settings hygiene | #200 RC4 | GET /settings/:key returns 200 with null instead of 404 |
| D — Observability profile | #200 RC3 | `docker compose --profile observability up -d` (P12 closeout) |
| E — Small verifications | #191, #194, #193 | Plan close-out audit, TS2502 fix, defer SSE coverage |
| F — Vitest 2.x bump | #192 | A116 closeout |
| G — Hooks → ESLint 9 → RTL | #177, #190, #195 | A128 → A130 → A120 sequenced refactor |

---

## Open issues by priority

| # | Title | Gate |
|---|-------|------|
| [#54](https://github.com/davistroy/open-brain/issues/54) | P24: Pipecat voice soak test | Manual — 10+ conversations needed |
| [#57](https://github.com/davistroy/open-brain/issues/57) | P25: Voice architecture decision | Blocked by #54 |
| [#71](https://github.com/davistroy/open-brain/issues/71) | P23: Cognitive memory tuning | Data-gated — earliest ~2026-05-17 |
| [#72](https://github.com/davistroy/open-brain/issues/72) | P34: RTX PRO 2000 deployment | Hardware purchase decision |
| [#73](https://github.com/davistroy/open-brain/issues/73) | P33: Qdrant evaluation | Scale-gated — fires at ≥50K embeddings |
| ~~[#177](https://github.com/davistroy/open-brain/issues/177)~~ | ~~A128: TanStack Query hooks extraction~~ | CLOSED — PRs #211 #212 #213 #214 (2026-05-09) |
| [#190](https://github.com/davistroy/open-brain/issues/190) | A130: ESLint 9 + flat-config migration | Ready — sequence after #177 |
| [#191](https://github.com/davistroy/open-brain/issues/191) | Close out IMPLEMENTATION_PLAN.md verification | Ready — ~30 min |
| [#192](https://github.com/davistroy/open-brain/issues/192) | A116: Vitest 2.x bump | Low priority baseline |
| [#193](https://github.com/davistroy/open-brain/issues/193) | A117: SSE onAbort coverage | Low priority baseline |
| [#194](https://github.com/davistroy/open-brain/issues/194) | A106: TS2502 entity-resolution.test.ts | Low priority baseline |
| [#195](https://github.com/davistroy/open-brain/issues/195) | A120: TS2345 MPill/TabBar tests | Low priority baseline — after #190 |
| [#196](https://github.com/davistroy/open-brain/issues/196) | Mobile deferred scope | No gate — when mobile is a priority |
| [#204](https://github.com/davistroy/open-brain/issues/204) | monthly-reflection: 6.5M-token context blowup | Bug — discovered during Phase A.5 |
| [#205](https://github.com/davistroy/open-brain/issues/205) | Stale BullMQ repeat-job keys for removed skills | Bug — discovered during Phase A.5 |
| [#207](https://github.com/davistroy/open-brain/issues/207) | A83: 17 cosmetic hydration risks (new Date/Date.now) | Tech debt — deferred, low priority |

---

## Maintenance

- **To report a bug or feedback:** file a GitHub issue at https://github.com/davistroy/open-brain/issues/new
- **When an issue ships:** close it on GitHub with `Closes #N` in the PR commit message (or manually)
- **This file:** update the table above when issues open/close; keep it as a quick snapshot, not a detailed spec
