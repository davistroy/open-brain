FIX=true

---

## Error Check: 2026-04-01

### Summary
- Open bug issues: 0
- Failed CI checks (PRs): 0
- Failed CI checks (default branch): 4
- Dependabot/security alerts: 0
- Total errors found: 4

### Failed CI/CD Checks (Default Branch)
- 🔴 **CI on main: CI** — conclusion: failure
  - URL: https://github.com/davistroy/open-brain/actions/runs/23810731261
  - Run ID: 23810731261
  - Created: 2026-03-31
  - Failing step: **Test** (build-and-test job)
  - Error details:
    - `@open-brain/web@0.1.0 test` (`vitest run --passWithNoTests`) exited with status 1
    - `packages/web` tests are failing
    - `packages/core-api` tests pass (entity-resolution tests OK)
    - `packages/workers` tests pass (drift-monitor tests OK)
  - Suggested fix: Investigate test failures in `packages/web` — likely a component test or import issue. The core-api and workers packages are healthy.

- 🔴 **CI on main: CI** — conclusion: failure (×2 more from 2026-03-31)
  - URLs: runs 23807836943, 23807312835

- 🔴 **CI on main: CI** — conclusion: failure
  - URL: https://github.com/davistroy/open-brain/actions/runs/23794103676
  - Created: 2026-03-31

Note: Run 23806047916 (2026-03-31) **succeeded**, suggesting an intermittent issue or a regression introduced after that successful run.

### Status Legend
- 🔴 OPEN — Error is unresolved
- 🟢 FIXED — Error was auto-fixed this run
- ⚪ NO ERRORS — Repository is clean
