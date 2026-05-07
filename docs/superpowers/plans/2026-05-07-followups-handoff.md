# Session Handoff — Post-Remediation Follow-ups (2026-05-07)

> **Purpose:** Self-contained briefing prompt for a fresh Claude Code session that picks up where 2026-05-07 left off. Paste the body of this file into the new session as the opening message.

---

We're tackling the post-remediation follow-ups together. The post-remediation plan
itself is fully shipped (`IMPLEMENTATION_PLAN-POST-REMEDIATION.md` — closed via PRs
#180/#181/#182/#183 on 2026-05-06 → 2026-05-07; lab notebook Entries 131–135).
What remains is the long tail of operational items + one escalation from that arc.
Working tree should be clean on `main` at or after `9f95ff1`.

Read first: `OPEN_ITEMS.md` (the canonical index), then this prompt's recommended
sequence below. Follow CLAUDE.md operational rules — especially the LAB_NOTEBOOK
blocking precondition (an entry MUST be created BEFORE any commit that touches
application code).

## Recommended sequence (smallest → largest)

Each block is independent. Land them as separate PRs unless the issues group
cleanly. CI: branch protection requires only `Integration tests (core-api + real DB)`;
admin escape hatch is open but use the PR pattern by default.

1. **A125 closure** (~30 min, S, low risk). `init-schema.sql` is missing the
   `capture_associations` table from migration 0011. Patch
   `scripts/init-schema.sql` so it includes the contents of
   `packages/shared/drizzle/0011_capture_associations.sql`. Then delete the
   A125 supplement block in `packages/workers/src/__tests__/integration/setup.ts`
   (it has an inline removal comment marking the spot). Verify: workers
   integration tests still pass against `docker-compose.test.yml`.
   Audit pass: while you're in `init-schema.sql`, grep for any other migration
   tables that didn't make it in (run `ls packages/shared/drizzle/0*.sql` and
   spot-check). Treat anything else found as separate findings.

2. **A71** (~1 hr, S, low risk). `memory-consolidation` skill currently routes
   via `task_routing.search_synthesis` because there's no `memory_consolidation`
   key in `config/ai-routing.yaml`. Add the key, point it at the right tier
   (likely `t1_spark` matching other synthesis tasks), update the skill to use
   it. Per CLAUDE.md, ai-routing.yaml schema requires cost fields on paid tiers.

3. **A107** (~30 min, S). `strictLimiter` is double-registered on `/captures`
   in `packages/core-api/src/middleware/rate-limit.ts` (or the route file —
   grep for `strictLimiter` in core-api). Halves the effective rate-limit
   budget. Remove the duplicate registration. Add or extend a unit test in
   `src/__tests__/rate-limit.test.ts` asserting only one registration.

4. **A129** (~30 min, S). Root `pnpm test:integration` script is not
   Windows-safe — pnpm parses `test:integration;` as a script name. Fix the
   root `package.json` script so the explicit compose-up → package-test →
   compose-down sequence works on both bash and PowerShell. Verify on this
   ubuntu-vm; cross-platform verification can be deferred to manual Windows
   testing.

5. **A110 + A111 bundle** (~1 hr, S–M). Settings hardening on
   `packages/core-api/src/routes/settings.ts`:
   - A110: `GET /api/v1/settings/:key` for a non-whitelisted key currently
     returns 404; should be 400 with a "key not in whitelist" message.
     Whitelist lives in `VALID_SETTINGS_KEYS` Set.
   - A111: `email_allowlist` setting has no array validator in
     `SETTINGS_VALIDATORS`. Add a validator that asserts `Array<string>`
     of valid email-format entries.
   Bundle into one PR since both touch the same routes file and same Set.

6. **A113 + A114 bundle** (~45 min, S). Validation hardening:
   - A113: Add UUID validation on `/api/v1/briefs/:id` and
     `/api/v1/sessions/:id` path params. Currently malformed UUIDs reach the
     DB and return opaque 500s. Use the existing zod UUID schema if there is
     one; otherwise add it.
   - A114: `/api/v1/sessions` `status_filter` query param is silently dropped
     instead of returning 400 when given an invalid value. Validate against
     `VALID_STATUSES` array (already declared in the route file).
   Both touch validation patterns; keep in one PR.

7. **A130 — ESLint 9 + flat-config migration** (M–L, separate plan). Largest
   piece of accumulated debt. Recommended: invoke `/ultra-plan` or
   `/create-plan` to author a dedicated implementation plan first. Scope:
   bump `eslint` 8 → 9 in `packages/web-next` (and any other package using
   v8); migrate `.eslintrc.json` → `eslint.config.{js,mjs}` flat-config
   format; bump `eslint-config-next` ^15 → ^16 (matches `next: ^16.2.4`);
   audit all eslint plugins for v9 compat; fix any new lint errors surfaced
   by the v16 ruleset; ensure `pnpm --filter @open-brain/web-next lint`
   exits 0 with zero errors. Per CLAUDE.md, until this lands,
   `eslint-config-next` MUST stay at `^15.0.0`.

   The crash that blocked Phase 3.3:
   `TypeError: Converting circular structure to JSON`
   from `@eslint/eslintrc@2.1.4` when ESLint 8 + `.eslintrc.json` tries to
   load eslint-config-next v16's flat schema. The migration is the only fix.

8. **A128 — TanStack Query hooks extraction** (M, design work). Phase 8a
   follow-up. Per OPEN_ITEMS, this needs a separate plan with design work
   first. Defer until A130 lands (flat-config rules may surface lint errors
   the restructure should respect — see cross-plan note in OPEN_ITEMS.md).

## Out of scope for this session

- **Pre-existing baselines** (A106, A116, A117, A120) — leave alone unless
  one specifically blocks the work above.
- **Master plan tail items** — P23 is data-gated until ~2026-05-17; P24/P25
  manual; P33 scale-gated; P34 hardware. Don't pull these forward.
- **`IMPLEMENTATION_PLAN.md` (LLM model consolidation)** — listed under
  Active plans in `OPEN_ITEMS.md` as "verification residue." Could be
  closed by ticking checkboxes if `pnpm -r test` passes (it does as of
  2026-05-07). 30-min close-out window if you want; otherwise leave.

## Project gotchas (read CLAUDE.md for the full set)

- **LAB_NOTEBOOK Entry BEFORE first commit** — blocking precondition.
  Numbering picks up from Entry 135.
- **`CI=1 pnpm -r test`** — required on this VM (one package's test command
  is watch-mode-sensitive outside CI). Per Entry 132.
- **`@open-brain/shared` rebuild before tsc** — per MEMORY.md. After any
  `pnpm install`, run `pnpm --filter @open-brain/shared build` before
  cross-package `tsc --noEmit`.
- **Workers coverage gate is active** — `lines: 78, functions: 81` pinned
  to floor in `packages/workers/vitest.config.ts`. Don't lower; raise
  toward 80% in follow-ups.
- **Workers integration tests run in CI** — part of the existing required
  `Integration tests (core-api + real DB)` job.
- **`@types/node` pinned to `^22.0.0`** across all TS packages.
- **`eslint-config-next` MUST stay `^15.0.0`** until A130 lands.
- **Branch protection** allows admin direct-push for housekeeping (solo
  user); use PRs for code changes.
- **`pnpm-lock.yaml` MUST be committed with any `package.json` change** —
  CI uses `--frozen-lockfile`.
- **PATH on this VM:** `export PATH="/home/davistroy/.nvm/versions/node/v22.16.0/bin:$PATH"`
  then `corepack enable` to access pnpm.

## How to start

Read `OPEN_ITEMS.md` and `CLAUDE.md`. Then pick item #1 (A125 closure) as
the warmup — it's the smallest, most surgical, and removes a workaround
installed yesterday. Or skip straight to A130 if you want to attack the
biggest piece. Use `/plan-next` if you'd like the next-action analysis
fresh-eyed.
