# Pending Issue Closures

Operator: Run the following `gh issue close` commands with the respective comments when ready.

---

## Issue #226

**Command:**
```bash
gh issue close 226
```

**Comment:**
```
Fixed in PR #230 / commit 1710c54.

**Root cause:** Daily-connections-query (and memory-consolidation-query) used Drizzle's bare JS array binding for UUID arrays, which interpolates as a ROW type `($1,$2,…)`. When cast to `uuid[]`, Postgres fails: "cannot cast type record to uuid[]" (silent query breakage, no runtime error — queries returned empty for weeks undetected).

**Fix:** `pgUuidArray()` helper (`workers/src/lib/pg-uuid-array.ts`) builds a proper `ARRAY[$1,$2,…]::uuid[]` parameterized query. Applied at daily-connections-query.ts + memory-consolidation.ts (Entry 180, proven live).

**Attribution note:** The issue description titled this a core-api bug, but the silent failure lived in the workers daily-connections skill + memory-consolidation logic — both read from the same malformed query surface. The fix is in the workers package, same query/error class, same timeline as the issue discovery.
```
