# Hardening Implementation Learnings

## Test Infrastructure
- **V8 crash in shared package tests**: Vitest `threads` pool crashes with `FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal` when CJS-preparsing ESM modules during teardown. Fix: use `--pool forks` in the shared package's test script. Prevention: always use `--pool forks` for ESM packages with CJS dependencies.
