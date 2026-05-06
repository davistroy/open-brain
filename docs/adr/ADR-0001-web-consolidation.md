# ADR-0001: Consolidate Web UI on `packages/web-next` (Next.js 16); Sunset `packages/web` (Vite)

**Status:** Accepted
**Accepted:** 2026-05-05
**Date:** 2026-05-05
**Deciders:** Troy Davis (single-user system owner)
**Driven by:** `/ultra-plan` architecture review remediation, items R3 + R12

---

## Context

The Open Brain monorepo currently ships two production-built web UIs:

| Package | Stack | Status |
|---|---|---|
| `packages/web` | Vite + React 18 + Radix UI + react-router-dom | Active build; container running but **not** the public ingress |
| `packages/web-next` | Next.js 16 + React 19 + Cloudscape + TanStack Query | Active build; **public ingress** per `config/cloudflare/tunnel.yaml:18` |

`config/cloudflare/tunnel.yaml` routes `brain.troy-davis.com` to `web-next:3001` with a documented one-line rollback comment (`# ROLLBACK: change to http://web:80`). This means the production user experience has been served by `web-next` since at least the M1 Cloudscape milestone (~2026-04-21), even though `packages/web` has continued to build and run.

CLAUDE.md still declares "Web: Vite + React + Tailwind + shadcn/ui (NOT Next.js)" as a project convention. This statement was written before the Cloudscape M1-M3 milestones and **no longer matches reality**. The architecture review surfaced this as Finding F6 (parallel web stacks).

Investigation during ultra-plan Phase 2 found:

- **Feature parity is high.** Most pages exist in both packages: Dashboard, Email, Wiki, Ingest, Board, Investments, Entities, Captures, Briefs, Settings, Intelligence, Financial, Search.
- **Two pages are uncertain:** Voice and System routes were not definitively confirmed in web-next during recon.
- **`packages/web-next` has no local API client.** It relies on shared types from `@open-brain/shared` and uses TanStack Query for data fetching. `packages/web/src/lib/api.ts` (1,232 LOC, 21 domains) does not have a counterpart in web-next.
- **Cloudscape M1–M4 implementation plans are explicitly building out `web-next`**, not `web`. The investment direction is clear; the codebase state lags the decision documentation.

The status quo costs are real:

1. **Maintenance overhead.** Two UI builds per release. Two test suites. Two sets of UI dependencies (Radix UI in `web`, Radix subset + Cloudscape in `web-next`). React 18 vs React 19 type drift surfaces during shared-package builds (already noted in `memory/web-next-learnings.md`).
2. **Conceptual confusion.** New contributor reads CLAUDE.md, sees "NOT Next.js", then opens `packages/web-next/` and finds Next.js. Trust in CLAUDE.md degrades.
3. **No documented sunset path.** The two stacks have coexisted for ~2 weeks at planning time; without a decision, drift compounds.

For a **single-user self-hosted system**, parallel UI investment is hard to justify on any axis (no A/B testing value, no incremental rollout requirement, no multi-team ownership).

---

## Decision

**Adopt `packages/web-next` as the canonical Open Brain web UI. Sunset `packages/web` per the schedule in IMPLEMENTATION_PLAN-ARCH-REVIEW.md Phases 7–8b.**

Specifically:

1. **Phase 7.1** updates CLAUDE.md and `docs/TDD.md` to reflect web-next as the production stack. The "NOT Next.js" wording in CLAUDE.md is corrected.
2. **Phase 7.2 / 7.3** completes any parity gaps in web-next (Voice, System, anything else surfaced by audit).
3. **Phase 7.4** migrates web-only utilities (sseClient, custom hooks) into either `@open-brain/shared` or `packages/web-next/src/lib/`.
4. **Phase 8a** builds a typed, split-by-domain API client in `packages/web-next/src/lib/api/` (~21 modules of ~100–200 LOC each). This is also the resolution to the original R9 god-module concern about `packages/web/src/lib/api.ts` — instead of refactoring a file we're deleting, we build the replacement with the right shape from day one.
5. **Phase 8b** splits the remaining god pages in web-next (Wiki, Email, Dashboard, Ingest, Board, Investments) by tab/section into child components. R11 originally targeted `packages/web` pages; that work shifts to web-next.
6. **Phase 8b.5–8b.6** tags the last "web alive" commit (`pre-web-sunset-2026-05`), removes `packages/web/` from the tree, removes the `web` service from `docker-compose.yml`, drops the rollback comment from `tunnel.yaml`, and updates CI to stop building/testing web.

The `pre-web-sunset-2026-05` git tag preserves the rollback option indefinitely. The runbook in `docs/runbooks/web-rollback.md` documents the exact recovery steps if a fault is discovered post-sunset.

---

## Alternatives Considered

### A. Keep both stacks (status quo)

**Rejected.** Maintenance cost compounds without offsetting benefit. Single-user systems don't gain from UI A/B options, and the type-drift cost is already showing up in MEMORY entries.

### B. Roll back to `packages/web` and abandon web-next

**Rejected.** Cloudscape M1-M4 plans (and the work already merged through M3 with 17/17 pages PASS) represent significant investment. Web-next has Next 16's server-component capabilities, modern React 19 features, and Cloudscape's enterprise-grade design tokens. Rolling back loses all of that and forces another stack migration in the future when the same triggers (modern React, server rendering, design system) re-emerge.

### C. Split functionality: web for some pages, web-next for others

**Rejected.** Functional scope splits in single-user systems become coordination overhead with no payoff. There's no team boundary, no separate release cadence, no domain-driven seam to justify the split.

### D. Migrate `web` Vite app into a web-next-compatible Vite-built path-segment hosted alongside Next routes

**Rejected.** Adds Vite build complexity inside Next.js, conflicts with Next 16's bundler ownership, and requires bespoke Cloudflare Tunnel routing logic. Engineering cost is higher than option B with worse outcomes.

---

## Consequences

### Positive

- **One UI codebase** instead of two: faster iteration, simpler mental model, consistent patterns.
- **CLAUDE.md becomes accurate** — restores trust in project memory as a source of truth.
- **API client built right from day one** (Phase 8a) avoids re-importing `packages/web/src/lib/api.ts`'s 1,232-LOC monolithic shape into web-next.
- **Tab-split discipline** (Phase 8b) lands in web-next directly, where it'll persist.
- **Production rollback path preserved** via `pre-web-sunset-2026-05` git tag and the tunnel.yaml rollback comment (until 8b.6 removes it after smoke confirms).

### Negative / Costs

- **Up-front effort**: Phases 7 + 8a + 8b are L+L+L (the heaviest in the plan).
- **Parity audit risk**: if a page genuinely missing from web-next is discovered late, it becomes blocking work in 7.3.
- **TanStack Query migration**: pages currently using inline `fetch` in web-next's pages need to migrate to hooks (Phase 8a.5). Behavior regression risk is real but bounded by snapshot tests (8a.6) and manual smoke (8b.4).

### Neutral / Acknowledged

- **Mobile app and other clients are unaffected.** They talk to core-api directly, not to either web UI.
- **The `web-next-public` caller header** introduced in IMPLEMENTATION_PLAN-ARCH-REVIEW.md Phase 2.2 stays — it identifies the public web ingress regardless of which UI is behind it.
- **`packages/mobile`** remains a third UI surface. This ADR explicitly does not consolidate mobile + web (different platforms, different purposes).

---

## Verification

The decision is considered correctly executed when:

- `git ls-tree HEAD -- packages/web` returns empty.
- `docker compose ps` shows no `open-brain-web` container.
- `cat config/cloudflare/tunnel.yaml | grep -c 'service:'` shows only `web-next:3001` and the catch-all 404.
- `pnpm -r build` builds successfully without `packages/web`.
- `https://brain.troy-davis.com` serves a Next.js-rendered page (response headers / `x-powered-by` or build artifact signature).

---

## References

- IMPLEMENTATION_PLAN-ARCH-REVIEW.md (this ADR is generated alongside)
- Architecture review session, 2026-05-05 (Finding F6, Items R3 + R12)
- `memory/web-next-learnings.md` — recorded type-drift incidents and build/routing learnings
- `IMPLEMENTATION_PLAN-CLOUDSCAPE-M{1,2,3,4}.md` — the active milestone plans driving web-next
- `config/cloudflare/tunnel.yaml:18` — current rollback comment (removed in Phase 8b.6)
- CLAUDE.md "Vite + React + Tailwind + shadcn/ui (NOT Next.js)" — corrected in Phase 7.1
