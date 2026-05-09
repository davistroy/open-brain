# Open Items Registry

**Authoritative list:** https://github.com/davistroy/open-brain/issues

GitHub issues are the single source of truth for all pending work as of 2026-05-09. This file is a quick-reference summary only — close issues there, not here.

---

## Active master plan

**[IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md](IMPLEMENTATION_PLAN-2026-05-09-REMEDIATION.md)** — 11-issue cohesive remediation, 7 phases (A–G). **Status: COMPLETE (2026-05-09)**

| Phase | Closes | Brief |
|---|---|---|
| A — Stop the bleeding | #197 (greeting), #198 (CORS), #199 (Slack), #200 (744 failed jobs) | Model name fix in ai-routing.yaml, column typo, CF Access bypass, Slack admin toggle, failed-jobs cleanup |
| B — UI hydration unification | #197, #198 (RC1) | Time-aware greeting + `new Date()` audit |
| C — Settings hygiene | #200 RC4 | GET /settings/:key returns 200 with null instead of 404 |
| D — Observability profile | #200 RC3 | `docker compose --profile observability up -d` (P12 closeout) |
| ~~E — Small verifications~~ | ~~#191, #194, #193~~ | **CLOSED** — #191 closed Phase E.1, #194 closed Phase E.2 (pre-existing fix confirmed), #193 deferred |
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
| ~~[#190](https://github.com/davistroy/open-brain/issues/190)~~ | ~~A130: ESLint 9 + flat-config migration~~ | CLOSED — Phase G.2, PR #215 (2026-05-09) |
| ~~[#191](https://github.com/davistroy/open-brain/issues/191)~~ | ~~Close out IMPLEMENTATION_PLAN.md verification~~ | **CLOSED (Phase E.1 audit 2026-05-09)** |
| [#192](https://github.com/davistroy/open-brain/issues/192) | A116: Vitest 2.x bump | Low priority baseline |
| [#193](https://github.com/davistroy/open-brain/issues/193) | A117: SSE onAbort coverage | Low priority baseline |
| ~~[#194](https://github.com/davistroy/open-brain/issues/194)~~ | ~~A106: TS2502 entity-resolution.test.ts~~ | **CLOSED (already resolved by commit 6948a12 — Phase E.2 audit 2026-05-09)** |
| ~~[#195](https://github.com/davistroy/open-brain/issues/195)~~ | ~~A120: RTL migration MPill/TabBar tests~~ | CLOSED — Phase G.3, PR #216 (2026-05-09) |
| [#196](https://github.com/davistroy/open-brain/issues/196) | Mobile deferred scope | No gate — when mobile is a priority |
| [#204](https://github.com/davistroy/open-brain/issues/204) | monthly-reflection: 6.5M-token context blowup | Bug — discovered during Phase A.5 |
| [#205](https://github.com/davistroy/open-brain/issues/205) | Stale BullMQ repeat-job keys for removed skills | Bug — discovered during Phase A.5 |
| [#207](https://github.com/davistroy/open-brain/issues/207) | A83: 17 cosmetic hydration risks (new Date/Date.now) | Tech debt — deferred, low priority |

---

## Recently closed (2026-05-09 remediation session)

| # | Title | Closed by |
|---|-------|-----------|
| #191 | LLM model consolidation verification | Phase E.1 audit |
| #194 | TS2502 entity-resolution (A106) | Phase E.2 audit (pre-existing fix confirmed) |
| #197 | Greeting bug + hydration | PR #206 |
| #198 | React #418 hydration (CORS) | PR #206 |
| #199 | Slack DMs | Manual: Slack admin toggle |
| #200 | 744 failed jobs | PRs #201, #202, #203 |
| #192 | Vitest 2.x bump (A116) | PR #210 |
| #177 | TanStack Query hooks (A128) | PRs #211–#214 |
| #190 | ESLint 9 + flat-config (A130) | PR #215 |
| #195 | RTL migration MPill/TabBar (A120) | PR #216 |

---

## Maintenance

- **To report a bug or feedback:** file a GitHub issue at https://github.com/davistroy/open-brain/issues/new
- **When an issue ships:** close it on GitHub with `Closes #N` in the PR commit message (or manually)
- **This file:** update the table above when issues open/close; keep it as a quick snapshot, not a detailed spec
