# Hardening Implementation Learnings

## Summary

- **29 work items across 8 phases** shipped in a single session, touching ~45 files and ~2,800 LOC of changes (fixes, refactors, tests, docs).
- **Type safety achieved**: eliminated all `db.execute<any>()` and `sql.raw()` calls from production code, replacing them with Drizzle query builder or typed row interfaces.
- **Security hardened**: admin endpoints now require Bearer auth (fail-closed), rate limiting added across all API tiers (100/20/5 req/min).
- **Search performance improved**: filters pushed into SQL functions (no more overfetch + JS filtering); migration 0009 adds parameterized WHERE clauses.
- **Code deduplication**: removed duplicate EmbeddingService, extracted shared prompt template utility, decomposed 820-line WeeklyBriefSkill into 3 focused modules.
- **Integration test infrastructure built**: docker-compose.test.yml with ephemeral Postgres+Redis, 12 pipeline smoke tests, API integration tests for captures/search/entities.
- **Full test suite**: 1,193 tests across 58 files in 6 packages, all passing. TypeScript strict mode, zero type errors.
- **Documentation aligned**: TDD updated to match as-built schema, SQL functions, and API contracts. Unplanned features documented. Deferred features explicitly marked.
- **Docker build safety**: removed `|| true` suppression from Dockerfile so TS compilation errors fail the build visibly.
- **Vitest `--pool forks` required** for the shared package to avoid V8 crash when CJS-preparsing ESM modules during teardown.

## Test Infrastructure
- **V8 crash in shared package tests**: Vitest `threads` pool crashes with `FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal` when CJS-preparsing ESM modules during teardown. Fix: use `--pool forks` in the shared package's test script. Prevention: always use `--pool forks` for ESM packages with CJS dependencies.
