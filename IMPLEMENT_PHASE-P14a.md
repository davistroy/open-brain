# IMPLEMENT_PHASE-P14a — Prompt-builder module + threat-model doc

**Phase:** P14a
**Issue:** #116 (subset — foundational layer only)
**Severity:** High
**Dependencies:** None (self-contained new module)
**Effort estimate:** ~1–1.5 days
**Branch slug:** `feat/phase-P14a-prompt-builder`

---

## Scope Summary

P14a creates a `SafePromptBuilder` module in `packages/shared/src/lib/` that wraps
user-controlled content in XML-style fenced delimiters and strips known prompt-injection
patterns before any content reaches the LLM. It also creates `docs/SECURITY.md` as
the system-wide threat model for prompt injection.

**P14a does NOT migrate call sites.** That is P14b. This phase establishes the module and
validates it with unit tests so P14b can import it immediately.

---

## Scope Drift Check

### File references verified against current codebase

| Plan reference | Actual state | Drift? |
|---|---|---|
| `packages/shared/src/services/prompt-builder.ts` (new) | Does not exist — location is correct but note: existing shared lib pattern uses `packages/shared/src/lib/` for utilities (prompt-template.ts, logger.ts, autonomy.ts) and `packages/shared/src/services/` for service classes (llm-gateway.ts, etc.). A pure utility module fits `lib/`. | **Minor drift** — recommended path: `packages/shared/src/lib/prompt-builder.ts` to stay consistent with lib convention. If it holds injectable state, `services/` is also defensible. |
| `docs/SECURITY.md` (new) | `docs/` exists, no SECURITY.md present | No drift |
| `TemplateCache.render()` is the hot-path rendering API | Confirmed: `packages/shared/src/lib/prompt-template.ts` lines 91–93 | No drift |
| Injection patterns: `"Ignore previous instructions"`, role-change markers, `[INST]`, `<|im_start|>` | No existing stripping anywhere in codebase | No drift — these are genuine gaps |
| Session-random delimiter for uniqueness | Not implemented anywhere | No drift |

### Injection surfaces confirmed in codebase

All six surfaces exist exactly as expected. None have any sanitization today:

1. **`packages/core-api/src/routes/synthesize.ts` lines 53–68** — raw capture `.content` strings joined with newlines, then string-interpolated directly into the prompt at line 62–67. `query` (user-supplied) is also embedded at line 64 with no sanitization.

2. **`packages/workers/src/jobs/extract-entities.ts` line 120** — `templates.render('extract-entities.v1.txt', { content: capture.content })` — capture body substituted into `{{content}}` slot verbatim.

3. **`packages/workers/src/skills/daily-sweep-skill.ts` line 145–148** — `templates.render('daily_sweep_v1.txt', { captures: capturesText })` — multi-capture assembled text as raw string.

4. **`packages/workers/src/skills/weekly-brief.ts` lines 84–85** — `templates.render('weekly_brief_v1.txt', { captures: contextText })` — same pattern.

5. **`packages/workers/src/skills/memory-consolidation.ts` line 336–339** — `templates.render('memory_consolidation_v1.txt', { captures: capturesText })` — same pattern.

6. **`packages/workers/src/skills/daily-connections.ts` line 130–133** — `templates.render('daily_connections_v1.txt', { captures: contextText })` — same pattern.

**MCP tools** (`search-brain.ts`, `get-capture.ts`, `list-captures.ts`, `email-tools.ts`) return capture content to an external LLM client (Claude via MCP). These are secondary injection surfaces — a poisoned capture returned to the client-side LLM is a genuine threat. Noted in threat model; sanitization of MCP return values is P14b scope.

**Note:** `email-compose.ts` line 98 builds a summary string from search results before passing to LLM. This is also a P14b call site.

### Architecture placement decision

The card says `packages/shared/src/services/prompt-builder.ts`. The existing pattern:
- `lib/` = stateless utilities (prompt-template.ts, logger.ts, autonomy.ts)
- `services/` = injectable stateful services (llm-gateway.ts, embedding.ts)

`SafePromptBuilder` is stateless (pure functions + a configured `delimiter`). **Recommended: `packages/shared/src/lib/prompt-builder.ts`** — matches the pattern. The class can be exported from `packages/shared/src/lib/index.ts`.

This is a minor drift from the card. No operator pause required — the card is loose on path.

---

## Deliverables

1. `packages/shared/src/lib/prompt-builder.ts` — `SafePromptBuilder` class
2. `packages/shared/src/lib/__tests__/prompt-builder.test.ts` — unit tests
3. `packages/shared/src/lib/index.ts` — export added
4. `docs/SECURITY.md` — threat model document

---

## Work Items

### WI 1 — `SafePromptBuilder` class (`packages/shared/src/lib/prompt-builder.ts`)

**Purpose:** Wrap user-controlled content in unique XML-style delimiters and strip known injection patterns before the string reaches an LLM call site.

**Design:**

```typescript
export class SafePromptBuilder {
  /**
   * Session-random delimiter prefix — generated once per SafePromptBuilder instance.
   * e.g. "cap7f3a2b" — unique enough to defeat exact-match evasion
   * ("end of cap7f3a2b, ignore previous instructions" would require guessing the nonce).
   */
  private readonly delimiterPrefix: string

  constructor(opts?: { delimiterPrefix?: string }) {
    // Allow injection in tests; generate randomly in production
    this.delimiterPrefix = opts?.delimiterPrefix ?? `cap${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Wraps a single user-controlled string in fenced delimiters and strips
   * known injection patterns. Returns the sanitized, delimited block.
   *
   * @param content  Raw user content (capture body, email body, etc.)
   * @param id       Optional capture ID for attribution (included in tag)
   */
  wrapContent(content: string, id?: string): string

  /**
   * Strips known prompt-injection patterns from a string WITHOUT wrapping.
   * Used for field values that appear inline in system instructions
   * (e.g. query strings, entity names).
   */
  sanitizeInline(text: string): string

  /**
   * Convenience: wraps an array of capture-like objects into a numbered,
   * delimited block suitable for insertion into a {{captures}} template slot.
   */
  wrapCaptures(captures: Array<{ id?: string; content: string }>): string
}
```

**Injection patterns to strip (in `sanitizeInline` and inside `wrapContent`):**

| Pattern | Notes |
|---|---|
| `ignore previous instructions` (case-insensitive) | Classic adversarial prefix |
| `ignore all instructions` (case-insensitive) | Variant |
| `[INST]` / `[/INST]` | Llama 2 chat format markers |
| `<\|im_start\|>` / `<\|im_end\|>` | ChatML / Mistral format markers |
| `<<SYS>>` / `<</SYS>>` | Llama 2 system block markers |
| `<system>` … `</system>` (tag only, not content) | Attempt to inject system role |
| `assistant:` / `user:` / `system:` at start of a line | Role-change injection |
| `\n###` at start of a line | Markdown heading injection common in adversarial prompts |

Strip approach: replace the literal pattern with `[REDACTED]` (not silent drop) so:
- The LLM still sees a signal that something was removed
- Logs can detect sanitization events
- Content is not silently corrupted (length change is visible)

**Delimiter format:**

```
<{delimiterPrefix}-{id}>
{sanitized content}
</{delimiterPrefix}-{id}>
```

Example (with `delimiterPrefix = "cap7f3a2b"`, `id = "abc-123"`):
```
<cap7f3a2b-abc-123>
User content here. [REDACTED] normal text continues.
</cap7f3a2b-abc-123>
```

When no ID is provided, use `<cap7f3a2b-0>`, `<cap7f3a2b-1>` etc. (index from `wrapCaptures`).

**Sanitization event logging:** `sanitizeInline` and `wrapContent` should call `logger.debug()` when at least one pattern is stripped, logging: which pattern was stripped, the content ID/context, and a truncated preview. No `logger.warn()` — noisy on legitimate content that happens to contain examples.

**Exports:** Export `SafePromptBuilder` as a named export from `packages/shared/src/lib/prompt-builder.ts`. Add to `packages/shared/src/lib/index.ts`.

**File:** `packages/shared/src/lib/prompt-builder.ts`
**New file — no prior content to read.**

---

### WI 2 — Unit tests (`packages/shared/src/lib/__tests__/prompt-builder.test.ts`)

**Test groups:**

**Group A — Injection stripping (8 cases minimum):**
- `wrapContent` with classic "Ignore previous instructions" → output contains `[REDACTED]`
- `wrapContent` with `[INST]` marker → stripped
- `wrapContent` with `<|im_start|>` marker → stripped
- `wrapContent` with `<<SYS>>` → stripped
- `wrapContent` with `assistant:` at line start → stripped
- `wrapContent` with `\n### Injected Header` → stripped
- `sanitizeInline` strips inline patterns without wrapping
- Clean content passes through unchanged (no false positives)

**Group B — Delimiter uniqueness:**
- Two `SafePromptBuilder` instances created without `delimiterPrefix` opt → `delimiterPrefix` values are different
- `delimiterPrefix` opt overrides random generation (for deterministic tests)
- Output of `wrapContent` contains the delimiter prefix in opening and closing tags

**Group C — `wrapCaptures`:**
- Array of 3 captures → output contains 3 delimited blocks in order
- Each block includes the capture's `id` in the tag when provided
- Uses index when no `id`

**Group D — Edge cases:**
- Empty string input → wraps empty content (does not throw)
- Very long content (10K chars) → processes without error
- Content containing valid XML → does not corrupt it (only strip injection-keyword patterns, not arbitrary tags)
- Multiple patterns in one capture → all stripped, single log call (or per-pattern — implementer's choice, document it)

**File:** `packages/shared/src/lib/__tests__/prompt-builder.test.ts`
**Prior file at path:** `packages/shared/src/lib/__tests__/prompt-template.test.ts` — read that first for test style reference.

---

### WI 3 — Export from `packages/shared/src/lib/index.ts`

**Current content of `packages/shared/src/lib/index.ts`:**
```typescript
export * from './prompt-template.js'
export * from './logger.js'
export * from './autonomy.js'
```

**Add:**
```typescript
export * from './prompt-builder.js'
```

Also verify `packages/shared/src/index.ts` re-exports from `lib/` — if it uses `export * from './lib/index.js'` the new export flows automatically; if individual named re-exports, add `SafePromptBuilder` manually.

**File:** `packages/shared/src/lib/index.ts`

---

### WI 4 — `docs/SECURITY.md` threat model

**Content outline** (implementer writes full prose):

```
# Open Brain — Security Threat Model

## Scope
Single-user, self-hosted system. No authentication between internal services.
This document covers prompt injection specifically. General network/auth
threats are out of scope here.

## 1. Threat: Prompt Injection via Captured Content

### 1.1 Attack surface
[List all 6 injection surfaces from § Injection surfaces confirmed above.
For each: file path, line range, which template slot, what user control exists.]

### 1.2 Attack scenarios
- Adversarial Slack message designed to exfiltrate memory-consolidation output
- Poisoned email body causing email-compose to send to unintended recipient
- Crafted capture that redirects weekly-brief output format

### 1.3 Current mitigations (as of P14a)
- SafePromptBuilder wraps content in session-random delimiters
- Known injection pattern stripping (list patterns)
- No exfiltration channel from worker jobs (workers cannot send email autonomously
  below `advise` autonomy level; rate limiter on capture POST)

### 1.4 Residual risks
- LLM prompt injection is not fully solvable by input sanitization alone
- New pattern variants not yet in strip list
- MCP return values (sanitized in P14b) can influence client-side LLM
- Delimiter approach relies on LLM respecting XML-like structure (not guaranteed)

### 1.5 Detection
- `logger.debug` on each sanitization event → visible in Loki
- `[REDACTED]` in AI output indicates sanitization happened → Grafana alert TBD

## 2. Process: Responding to a Confirmed Injection

### 2.1 Indicators
### 2.2 Immediate containment
### 2.3 Analysis
### 2.4 Remediation
### 2.5 Post-mortem template

## 3. Future Work
- P14b: route all call sites through SafePromptBuilder
- Evaluate output-layer defenses (response validation)
- Consider LLM-level system prompt hardening ("you are operating in a sandboxed context")
```

**File:** `docs/SECURITY.md`

---

## Acceptance Criteria

- [ ] `pnpm --filter @open-brain/shared exec vitest run` — all existing tests pass + new prompt-builder tests pass
- [ ] `pnpm --filter @open-brain/shared exec tsc --noEmit` — zero TS errors
- [ ] `SafePromptBuilder` exported from `@open-brain/shared` (verify via `grep -r "SafePromptBuilder" packages/shared/src/index.ts` or the chain)
- [ ] At least 8 injection-strip test cases passing (Group A)
- [ ] Delimiter uniqueness test: two instances without opts produce different `delimiterPrefix` values
- [ ] `docs/SECURITY.md` exists and covers all 6 injection surfaces with file paths + line ranges
- [ ] No production call sites are modified (P14b scope)
- [ ] `pnpm --filter @open-brain/workers exec tsc --noEmit` — zero errors (import chain validation)

---

## Rollback Plan

- Module not yet used by any call site — deletion is the full rollback.
- `git revert` the commits for WI 1–3; remove `docs/SECURITY.md`.
- No schema change, no config change, no homeserver deploy required.

---

## Commit Format

```
feat(phase-P14a)/1.1: SafePromptBuilder class + exports
feat(phase-P14a)/1.2: unit tests for SafePromptBuilder (injection strip + delimiter uniqueness)
docs(phase-P14a)/1.3: SECURITY.md threat model (prompt injection)
```

---

## LAB_NOTEBOOK Pre-action Entry (Gate 3 must write before first commit)

Before implementing WI 1, write a LAB_NOTEBOOK entry:

**Objective:** Create `SafePromptBuilder` module in `packages/shared/src/lib/` with injection stripping + XML fencing.

**Hypothesis:** Unit tests confirm known patterns stripped and delimiters are session-unique; `tsc --noEmit` on shared + workers passes; no existing tests broken.

**Rollback:** Remove new files + export line; `git revert` 1–2 commits; no running system affected.

---

## Implementation Notes for Gate 3

1. Read `packages/shared/src/lib/prompt-template.ts` before writing `prompt-builder.ts` — match the JSDoc style exactly.
2. Read `packages/shared/src/lib/__tests__/prompt-template.test.ts` before writing tests — match describe/it structure and import pattern.
3. The strip list above is a minimum. Implementer may add patterns but must add a test case for each addition.
4. Do NOT import `SafePromptBuilder` in any existing production file during this phase. Gate 3 terminates after the 4 WIs above. P14b handles call-site migration.
5. After WI 3 (export), run `pnpm --filter @open-brain/workers exec tsc --noEmit` to confirm the new export does not break the import chain (even though workers don't use it yet, type-checking the shared package is a common source of CI regressions).
6. For `docs/SECURITY.md`: include actual file paths and line ranges from the injection surface table above — do not write generic placeholders. Lines may shift slightly during P14b, that is acceptable.
