import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  FileUploadStatusSchema,
  IngestSourceTypeSchema,
} from '../schema/ingest.js'

/**
 * CS-α drift-guard (item 2.5 of IMPLEMENT_TECH_DEBT_CLEANUP_2026-04-17.md, F2).
 *
 * The web package (`@open-brain/web`) is a standalone Vite bundle and
 * intentionally does NOT import types from `@open-brain/shared` at runtime
 * (see the note above `IngestSourceType` / `FileUploadStatus` in
 * `packages/web/src/lib/api.ts`). Instead, it redeclares the union literals
 * inline. That redeclaration must stay in lock-step with the canonical Zod
 * schemas in `packages/shared/src/schema/ingest.ts` — otherwise the web UI
 * and the core-api's validated HTTP surface silently diverge (see Wave A
 * fallout: the web type claimed `'completed'` but the DB + API emit
 * `'parsed'`).
 *
 * This test parses `packages/web/src/lib/api.ts` as text, extracts the
 * union members for `IngestSourceType` and `FileUploadStatus`, and asserts
 * they match the sorted `.options` tuples from the canonical Zod enums.
 *
 * If this test fails, the error message names both sides and the exact
 * files to reconcile; fix the WEB declaration to match SHARED, not the
 * other way around. SHARED is the source of truth.
 *
 * P01 extension (phase-P01/3.1): also guards CaptureSource parity across:
 *   - packages/shared/src/types/capture.ts (canonical TS union, 9 values)
 *   - packages/web/src/lib/types.ts (redeclared union, must stay in sync)
 *   - packages/web/src/components/SearchFilters.tsx (CAPTURE_SOURCES array,
 *     must list all values from the web type union)
 *
 * M2 extension (Cloudscape M2 item 1.5): also guards CaptureSource,
 * CaptureType, and PipelineStatus parity for the web-next package:
 *   - packages/web-next/lib/types.ts redeclares these locally per D109
 *     (no runtime @open-brain/shared import in the Next.js bundle).
 *   - D109 is the canonical decision; this test is the enforcement mechanism.
 *   - When drift is detected, fix the web-next declaration to match shared,
 *     never the other way around. SHARED is the source of truth.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WEB_API_PATH = resolve(__dirname, '../../../web/src/lib/api.ts')
const WEB_TYPES_PATH = resolve(__dirname, '../../../web/src/lib/types.ts')
const SEARCH_FILTERS_PATH = resolve(__dirname, '../../../web/src/components/SearchFilters.tsx')
const TIMELINE_PATH = resolve(__dirname, '../../../web/src/pages/Timeline.tsx')
const STATS_CARDS_PATH = resolve(__dirname, '../../../web/src/components/StatsCards.tsx')
const PIPELINE_EVENT_TYPES_PATH = resolve(__dirname, '../../src/types/pipeline-event.ts')
const SESSION_TYPES_PATH = resolve(__dirname, '../types/session.ts')
// M2 item 1.5: web-next declares types locally per D109 (no @open-brain/shared runtime import)
const WEB_NEXT_TYPES_PATH = resolve(__dirname, '../../../web-next/lib/types.ts')
const SHARED_SCHEMA_PATH = 'packages/shared/src/schema/ingest.ts'
const WEB_API_REL = 'packages/web/src/lib/api.ts'
const WEB_TYPES_REL = 'packages/web/src/lib/types.ts'
const SEARCH_FILTERS_REL = 'packages/web/src/components/SearchFilters.tsx'
const TIMELINE_REL = 'packages/web/src/pages/Timeline.tsx'
const STATS_CARDS_REL = 'packages/web/src/components/StatsCards.tsx'
const WEB_NEXT_TYPES_REL = 'packages/web-next/lib/types.ts'

/**
 * Extract the string-literal members of a `export type Name = 'a' | 'b' | ...`
 * declaration from a source file. Tolerates line breaks, trailing `|`, and
 * arbitrary whitespace between members. Returns the literals in source order.
 * Throws with an actionable message if the declaration is missing or malformed.
 *
 * @param source    Full file contents (text)
 * @param typeName  The exported type name to search for
 * @param fileLabel Relative file path used in error messages (defaults to WEB_API_REL
 *                  for backward compat with callers that don't pass it)
 */
function extractUnionLiterals(source: string, typeName: string, fileLabel: string = WEB_API_REL): string[] {
  // Normalize Windows CRLF to LF so the blank-line boundary is reliable
  // regardless of platform-specific git checkout config.
  const normalized = source.replace(/\r\n/g, '\n')
  // Capture everything after `export type Name =` up to the next top-level
  // `export` or blank-line boundary. The web file declares each union on its
  // own block separated by a blank line, so that boundary is reliable.
  // Note: no `m` flag — under multiline mode, `$` would match end-of-line
  // and the lazy body would terminate after the first literal. We want `$`
  // to mean end-of-string only, as a final fallback.
  const re = new RegExp(
    `export\\s+type\\s+${typeName}\\s*=\\s*([\\s\\S]*?)(?=\\n\\n|\\nexport\\s|$)`,
  )
  const match = normalized.match(re)
  if (!match) {
    throw new Error(
      `Drift-guard could not locate \`export type ${typeName} = ...\` in ${fileLabel}. ` +
        `The declaration may have been renamed or re-exported. Update this test's ` +
        `regex (packages/shared/src/__tests__/web-type-drift.test.ts) if the canonical ` +
        `web literal source has moved.`,
    )
  }
  const body = match[1] ?? ''
  // Pull every single-quoted literal out of the RHS.
  const literals = Array.from(body.matchAll(/'([^']+)'/g)).map((m) => m[1])
  if (literals.length === 0) {
    throw new Error(
      `Drift-guard matched \`${typeName}\` in ${fileLabel} but extracted zero ` +
        `literal members. Regex body was:\n${body}\n\n` +
        `Update the extractUnionLiterals() regex in this test.`,
    )
  }
  return literals
}

/**
 * Run a union-literal drift assertion for a given type across multiple source files.
 *
 * @param targets       Array of `{ path: absolute path, label: relative path for messages }`
 * @param typeName      The exported type name to extract and assert
 * @param canonical     The sorted canonical value set (source of truth: packages/shared)
 * @param sharedSource  Human-readable description of canonical source (for error messages)
 */
function assertUnionMatchesCanonical(
  targets: { path: string; label: string }[],
  typeName: string,
  canonical: readonly string[],
  sharedSource: string,
): void {
  const canonicalSorted = sorted(canonical)
  for (const { path, label } of targets) {
    const source = readFileSync(path, 'utf8')
    const literals = extractUnionLiterals(source, typeName, label)
    const literalsSorted = sorted(literals)
    expect(
      literalsSorted,
      `Drift detected in ${typeName} in ${label}:\n` +
        `  declared  (${label}): ${JSON.stringify(literalsSorted)}\n` +
        `  canonical (${sharedSource}): ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `SHARED is the source of truth (decision D109). Fix the \`export type ${typeName} = ...\` ` +
        `union in ${label} to match the canonical TS union in ${sharedSource}. ` +
        `Do NOT modify the canonical shared types to match a UI package. ` +
        `See Cloudscape M2 item 1.5 for context.`,
    ).toEqual(canonicalSorted)
  }
}

function sorted<T extends string>(xs: readonly T[]): T[] {
  return [...xs].sort()
}

/**
 * Extract the string-literal members of a `const NAME[: Type[]]* = ['a', 'b', ...]`
 * declaration from a source file. Handles both single-line and multi-line array
 * syntax, trailing commas, and arbitrary whitespace.
 *
 * Returns the literals in source order. Throws with an actionable message if
 * the declaration is missing or malformed.
 */
function extractArrayLiterals(source: string, constName: string): string[] {
  const normalized = source.replace(/\r\n/g, '\n')
  // Match: const NAME (optional type annotation) = [ ... ] (possibly multi-line)
  // The type annotation is optional and may contain generics, e.g. `: CaptureSource[]`
  // The array body ends at the first `]` that closes the opening `[`.
  const re = new RegExp(
    `const\\s+${constName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`,
  )
  const match = normalized.match(re)
  if (!match) {
    throw new Error(
      `Drift-guard could not locate \`const ${constName} = [...]\` in source. ` +
        `The declaration may have been renamed or restructured. ` +
        `Update extractArrayLiterals() in packages/shared/src/__tests__/web-type-drift.test.ts.`,
    )
  }
  const body = match[1] ?? ''
  const literals = Array.from(body.matchAll(/'([^']+)'/g)).map((m) => m[1])
  if (literals.length === 0) {
    throw new Error(
      `Drift-guard matched \`${constName}\` array but extracted zero literal members. ` +
        `Regex body was:\n${body}\n\n` +
        `Update the extractArrayLiterals() regex in this test.`,
    )
  }
  return literals
}

/**
 * Extract the keys of an object literal assigned to `const NAME: Record<...> = { ... }`
 * (or any `const NAME = { ... } as const` / `const NAME: T = { ... }`). Used to
 * inspect `Record<CaptureType, ...>` look-up maps in StatsCards.tsx and verify
 * they cover every canonical CaptureType.
 *
 * Returns the keys in source order. Throws with an actionable message if the
 * declaration is missing or no keys are extracted. Tolerates trailing commas,
 * single/double-quoted keys, and quoted multi-word keys (e.g. `'work-internal'`).
 */
function extractObjectKeys(source: string, constName: string): string[] {
  const normalized = source.replace(/\r\n/g, '\n')
  const re = new RegExp(
    `const\\s+${constName}\\s*(?::[^=]+)?=\\s*\\{([\\s\\S]*?)\\}`,
  )
  const match = normalized.match(re)
  if (!match) {
    throw new Error(
      `Drift-guard could not locate \`const ${constName} = { ... }\` in source. ` +
        `Update extractObjectKeys() in packages/shared/src/__tests__/web-type-drift.test.ts.`,
    )
  }
  const body = match[1] ?? ''
  // Match either: 'quoted-key': ... | "quoted-key": ... | bareIdent: ...
  // Restrict to top-level keys (lines whose first non-whitespace is the key).
  const keys: string[] = []
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*:/)
    if (m) keys.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  if (keys.length === 0) {
    throw new Error(
      `Drift-guard matched \`${constName}\` object but extracted zero keys. ` +
        `Body was:\n${body}\n\nUpdate extractObjectKeys() regex.`,
    )
  }
  return keys
}

// Canonical 9-value CaptureSource set (source of truth: packages/shared/src/types/capture.ts)
const CANONICAL_CAPTURE_SOURCES = [
  'api', 'consolidation', 'document', 'email', 'file', 'mcp', 'slack', 'system', 'voice',
] as const

// Canonical 8-value CaptureType set (source of truth: packages/shared/src/types/capture.ts)
// Ordering: alphabetical, for stable assertion output.
const CANONICAL_CAPTURE_TYPES = [
  'blocker', 'decision', 'idea', 'observation', 'question', 'reflection', 'task', 'win',
] as const

// Canonical 8-value PipelineStatus set (P09a / migration 0024 / issue #119).
// Source of truth: packages/shared/src/types/capture.ts.
//   - `extracted` — DB has 11 legacy rows; no current producer.
//   - `chunked`   — produced by document-pipeline.ts ternary on multi-chunk docs;
//                   missed by planner's keyed-property grep, caught by Gate 3 audit.
// See LAB_NOTEBOOK Entry 102 for the full reconciliation.
const CANONICAL_PIPELINE_STATUSES = [
  'chunked', 'complete', 'deleted', 'embedded', 'extracted', 'failed', 'pending', 'processing',
] as const

// Canonical 12-value PipelineEventStage set (P09b / migration 0025; extended M3 / migration 0031).
// Source of truth: packages/shared/src/types/pipeline-event.ts.
const CANONICAL_PIPELINE_EVENT_STAGES = [
  'check_triggers', 'classify', 'document-chunk', 'document-embed',
  'document-parse', 'embed', 'extract', 'extract_commitments', 'extract_entities',
  'link_entities', 'notify', 'received',
] as const

// Canonical 3-value PipelineEventStatus set (P09b / migration 0025 / issue #119).
// Source of truth: packages/shared/src/types/pipeline-event.ts.
const CANONICAL_PIPELINE_EVENT_STATUSES = [
  'failed', 'started', 'success',
] as const

// Canonical 3-value SessionType set (P09c / migration 0026 / issue #119).
// Source of truth: packages/shared/src/types/session.ts.
const CANONICAL_SESSION_TYPES = [
  'governance', 'planning', 'review',
] as const

// Canonical 4-value SessionStatus set (P09c / migration 0026 / issue #119).
// Source of truth: packages/shared/src/types/session.ts.
const CANONICAL_SESSION_STATUSES = [
  'abandoned', 'active', 'complete', 'paused',
] as const

describe('web <-> shared contract drift guard (CS-α / F2)', () => {
  const webSource = readFileSync(WEB_API_PATH, 'utf8')

  it('FileUploadStatus web literal set matches shared canonical set', () => {
    const webLiterals = extractUnionLiterals(webSource, 'FileUploadStatus')
    const sharedLiterals = FileUploadStatusSchema.options

    const webSorted = sorted(webLiterals)
    const sharedSorted = sorted(sharedLiterals)

    expect(
      webSorted,
      `Drift detected in FileUploadStatus:\n` +
        `  web    (${WEB_API_REL}):    ${JSON.stringify(webSorted)}\n` +
        `  shared (${SHARED_SCHEMA_PATH}): ${JSON.stringify(sharedSorted)}\n` +
        `\n` +
        `SHARED is the source of truth. Update the \`export type FileUploadStatus = ...\` ` +
        `union in ${WEB_API_REL} to match the \`FileUploadStatusSchema\` z.enum([...]) ` +
        `tuple in ${SHARED_SCHEMA_PATH}.`,
    ).toEqual(sharedSorted)
  })

  it('IngestSourceType web literal set matches shared canonical set', () => {
    const webLiterals = extractUnionLiterals(webSource, 'IngestSourceType')
    const sharedLiterals = IngestSourceTypeSchema.options

    const webSorted = sorted(webLiterals)
    const sharedSorted = sorted(sharedLiterals)

    expect(
      webSorted,
      `Drift detected in IngestSourceType:\n` +
        `  web    (${WEB_API_REL}):    ${JSON.stringify(webSorted)}\n` +
        `  shared (${SHARED_SCHEMA_PATH}): ${JSON.stringify(sharedSorted)}\n` +
        `\n` +
        `SHARED is the source of truth. Update the \`export type IngestSourceType = ...\` ` +
        `union in ${WEB_API_REL} to match the \`IngestSourceTypeSchema\` z.enum([...]) ` +
        `tuple in ${SHARED_SCHEMA_PATH}.`,
    ).toEqual(sharedSorted)
  })
})

describe('CaptureSource drift guard (phase-P01 / #110)', () => {
  const webTypesSource = readFileSync(WEB_TYPES_PATH, 'utf8')
  const searchFiltersSource = readFileSync(SEARCH_FILTERS_PATH, 'utf8')

  it('CaptureSource web literal set (types.ts) matches canonical 9-value list', () => {
    const webLiterals = extractUnionLiterals(webTypesSource, 'CaptureSource')
    const webSorted = sorted(webLiterals)
    const canonicalSorted = sorted(CANONICAL_CAPTURE_SOURCES)

    expect(
      webSorted,
      `Drift detected in CaptureSource:\n` +
        `  web    (${WEB_TYPES_REL}): ${JSON.stringify(webSorted)}\n` +
        `  canonical (packages/shared/src/types/capture.ts): ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type CaptureSource = ...\` union in ${WEB_TYPES_REL} ` +
        `to match the canonical TS union in packages/shared/src/types/capture.ts. ` +
        `Also update CANONICAL_CAPTURE_SOURCES in this test file and the Zod enum ` +
        `in packages/core-api/src/schemas/capture.ts.`,
    ).toEqual(canonicalSorted)
  })

  it('SearchFilters CAPTURE_SOURCES array matches web CaptureSource type', () => {
    const arrayLiterals = extractArrayLiterals(searchFiltersSource, 'CAPTURE_SOURCES')
    const webUnionLiterals = extractUnionLiterals(webTypesSource, 'CaptureSource')

    const arraySorted = sorted(arrayLiterals)
    const unionSorted = sorted(webUnionLiterals)

    expect(
      arraySorted,
      `Drift detected in SearchFilters.CAPTURE_SOURCES:\n` +
        `  array  (${SEARCH_FILTERS_REL}): ${JSON.stringify(arraySorted)}\n` +
        `  union  (${WEB_TYPES_REL}):      ${JSON.stringify(unionSorted)}\n` +
        `\n` +
        `CAPTURE_SOURCES must list every value in the CaptureSource union. ` +
        `Update the \`const CAPTURE_SOURCES\` array in ${SEARCH_FILTERS_REL}.`,
    ).toEqual(unionSorted)
  })
})

describe('CaptureType drift guard (phase-P09a / #119)', () => {
  const webTypesSource = readFileSync(WEB_TYPES_PATH, 'utf8')
  const searchFiltersSource = readFileSync(SEARCH_FILTERS_PATH, 'utf8')
  const timelineSource = readFileSync(TIMELINE_PATH, 'utf8')
  const statsCardsSource = readFileSync(STATS_CARDS_PATH, 'utf8')

  it('CaptureType web literal set (types.ts) matches canonical 8-value list', () => {
    const webLiterals = extractUnionLiterals(webTypesSource, 'CaptureType')
    const webSorted = sorted(webLiterals)
    const canonicalSorted = sorted(CANONICAL_CAPTURE_TYPES)

    expect(
      webSorted,
      `Drift detected in CaptureType:\n` +
        `  web    (${WEB_TYPES_REL}): ${JSON.stringify(webSorted)}\n` +
        `  canonical (packages/shared/src/types/capture.ts): ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type CaptureType = ...\` union in ${WEB_TYPES_REL} ` +
        `to match the canonical TS union in packages/shared/src/types/capture.ts. ` +
        `Also update CANONICAL_CAPTURE_TYPES in this test file and the Zod enum ` +
        `in packages/core-api/src/schemas/capture.ts.`,
    ).toEqual(canonicalSorted)
  })

  it('SearchFilters CAPTURE_TYPES array matches web CaptureType type', () => {
    const arrayLiterals = extractArrayLiterals(searchFiltersSource, 'CAPTURE_TYPES')
    const webUnionLiterals = extractUnionLiterals(webTypesSource, 'CaptureType')

    const arraySorted = sorted(arrayLiterals)
    const unionSorted = sorted(webUnionLiterals)

    expect(
      arraySorted,
      `Drift detected in SearchFilters.CAPTURE_TYPES:\n` +
        `  array  (${SEARCH_FILTERS_REL}): ${JSON.stringify(arraySorted)}\n` +
        `  union  (${WEB_TYPES_REL}):      ${JSON.stringify(unionSorted)}\n` +
        `\n` +
        `CAPTURE_TYPES must list every value in the CaptureType union. ` +
        `Update the \`const CAPTURE_TYPES\` array in ${SEARCH_FILTERS_REL}.`,
    ).toEqual(unionSorted)
  })

  it('Timeline CAPTURE_TYPES array matches web CaptureType type', () => {
    const arrayLiterals = extractArrayLiterals(timelineSource, 'CAPTURE_TYPES')
    const webUnionLiterals = extractUnionLiterals(webTypesSource, 'CaptureType')

    const arraySorted = sorted(arrayLiterals)
    const unionSorted = sorted(webUnionLiterals)

    expect(
      arraySorted,
      `Drift detected in Timeline.CAPTURE_TYPES:\n` +
        `  array  (${TIMELINE_REL}): ${JSON.stringify(arraySorted)}\n` +
        `  union  (${WEB_TYPES_REL}): ${JSON.stringify(unionSorted)}\n` +
        `\n` +
        `Timeline.tsx CAPTURE_TYPES must list every value in the CaptureType union.`,
    ).toEqual(unionSorted)
  })

  it.each([
    ['TYPE_LABELS', STATS_CARDS_REL],
    ['TYPE_COLORS', STATS_CARDS_REL],
  ] as const)('StatsCards %s Record covers all canonical CaptureType keys', (constName, _path) => {
    const keys = extractObjectKeys(statsCardsSource, constName)
    const keysSorted = sorted(keys)
    const canonicalSorted = sorted(CANONICAL_CAPTURE_TYPES)

    expect(
      keysSorted,
      `Drift detected in StatsCards.${constName}:\n` +
        `  keys      (${STATS_CARDS_REL}): ${JSON.stringify(keysSorted)}\n` +
        `  canonical (packages/shared/src/types/capture.ts): ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Record<CaptureType, ...> map must include every CaptureType key. ` +
        `Add missing keys to ${constName} in ${STATS_CARDS_REL}.`,
    ).toEqual(canonicalSorted)
  })
})

describe('PipelineStatus drift guard (phase-P09a / #119)', () => {
  const webTypesSource = readFileSync(WEB_TYPES_PATH, 'utf8')

  it('PipelineStatus web literal set (types.ts) matches canonical 8-value list', () => {
    const webLiterals = extractUnionLiterals(webTypesSource, 'PipelineStatus')
    const webSorted = sorted(webLiterals)
    const canonicalSorted = sorted(CANONICAL_PIPELINE_STATUSES)

    expect(
      webSorted,
      `Drift detected in PipelineStatus:\n` +
        `  web    (${WEB_TYPES_REL}): ${JSON.stringify(webSorted)}\n` +
        `  canonical (packages/shared/src/types/capture.ts): ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type PipelineStatus = ...\` union in ${WEB_TYPES_REL} ` +
        `to match the canonical TS union in packages/shared/src/types/capture.ts. ` +
        `Also update CANONICAL_PIPELINE_STATUSES in this test file, the Zod enum ` +
        `PIPELINE_STATUSES in packages/core-api/src/schemas/capture.ts, and the ` +
        `DB CHECK constraint in packages/shared/drizzle/0024_captures_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })
})

describe('PipelineEvent type drift guard (phase-P09b / #119)', () => {
  const pipelineEventSource = readFileSync(PIPELINE_EVENT_TYPES_PATH, 'utf8')

  it('PipelineEventStage TS union matches canonical 12-value list', () => {
    const unionLiterals = extractUnionLiterals(pipelineEventSource, 'PipelineEventStage')
    const unionSorted = sorted(unionLiterals)
    const canonicalSorted = sorted(CANONICAL_PIPELINE_EVENT_STAGES)

    expect(
      unionSorted,
      `Drift detected in PipelineEventStage:\n` +
        `  union     (packages/shared/src/types/pipeline-event.ts): ${JSON.stringify(unionSorted)}\n` +
        `  canonical (this test):                                   ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type PipelineEventStage = ...\` union in ` +
        `packages/shared/src/types/pipeline-event.ts to match CANONICAL_PIPELINE_EVENT_STAGES ` +
        `in this test file, AND update the DB CHECK constraint in ` +
        `packages/shared/drizzle/0025_pipeline_events_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })

  it('PipelineEventStatus TS union matches canonical 3-value list', () => {
    const unionLiterals = extractUnionLiterals(pipelineEventSource, 'PipelineEventStatus')
    const unionSorted = sorted(unionLiterals)
    const canonicalSorted = sorted(CANONICAL_PIPELINE_EVENT_STATUSES)

    expect(
      unionSorted,
      `Drift detected in PipelineEventStatus:\n` +
        `  union     (packages/shared/src/types/pipeline-event.ts): ${JSON.stringify(unionSorted)}\n` +
        `  canonical (this test):                                   ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type PipelineEventStatus = ...\` union in ` +
        `packages/shared/src/types/pipeline-event.ts to match CANONICAL_PIPELINE_EVENT_STATUSES ` +
        `in this test file, AND update the DB CHECK constraint in ` +
        `packages/shared/drizzle/0025_pipeline_events_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })
})

describe('Session type drift guard (phase-P09c / #119)', () => {
  const sessionTypesSource = readFileSync(SESSION_TYPES_PATH, 'utf8')

  it('SessionType TS union matches canonical 3-value list', () => {
    const unionLiterals = extractUnionLiterals(sessionTypesSource, 'SessionType', 'packages/shared/src/types/session.ts')
    const unionSorted = sorted(unionLiterals)
    const canonicalSorted = sorted(CANONICAL_SESSION_TYPES)

    expect(
      unionSorted,
      `Drift detected in SessionType:\n` +
        `  union     (packages/shared/src/types/session.ts): ${JSON.stringify(unionSorted)}\n` +
        `  canonical (this test):                            ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type SessionType = ...\` union in ` +
        `packages/shared/src/types/session.ts to match CANONICAL_SESSION_TYPES ` +
        `in this test file, AND update the DB CHECK constraint in ` +
        `packages/shared/drizzle/0026_sessions_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })

  it('SessionStatus TS union matches canonical 4-value list', () => {
    const unionLiterals = extractUnionLiterals(sessionTypesSource, 'SessionStatus', 'packages/shared/src/types/session.ts')
    const unionSorted = sorted(unionLiterals)
    const canonicalSorted = sorted(CANONICAL_SESSION_STATUSES)

    expect(
      unionSorted,
      `Drift detected in SessionStatus:\n` +
        `  union     (packages/shared/src/types/session.ts): ${JSON.stringify(unionSorted)}\n` +
        `  canonical (this test):                            ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type SessionStatus = ...\` union in ` +
        `packages/shared/src/types/session.ts to match CANONICAL_SESSION_STATUSES ` +
        `in this test file, AND update the DB CHECK constraint in ` +
        `packages/shared/drizzle/0026_sessions_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })
})

describe('web-next <-> shared type drift guard (Cloudscape M2 item 1.5 / D109)', () => {
  /**
   * web-next (`packages/web-next/`) is a Next.js 16 app that intentionally does NOT
   * import from `@open-brain/shared` at runtime (decision D109 — avoids pulling
   * pg/openai/drizzle-orm into the Next.js server bundle). It redeclares canonical
   * union types locally in `lib/types.ts`. This suite asserts those local redeclarations
   * stay in sync with the shared canonical types.
   *
   * The three types guarded here (CaptureSource, CaptureType, PipelineStatus) are the
   * ones web-next declares as of M1. When a new type is added to lib/types.ts that also
   * has a canonical shared counterpart, extend this test (and update item 1.5 in
   * IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md to reference the new type).
   *
   * D109 is the source of truth for the no-shared-import rule. This test is the
   * automated enforcement mechanism. If this test fails:
   *   1. Fix the `export type X = ...` union in packages/web-next/lib/types.ts.
   *   2. Do NOT change the canonical shared types to match.
   *   3. Do NOT add @open-brain/shared as a dependency of web-next.
   */

  // Both web and web-next must declare these types identically.
  const TYPES_TARGETS = [
    { path: WEB_TYPES_PATH, label: WEB_TYPES_REL },
    { path: WEB_NEXT_TYPES_PATH, label: WEB_NEXT_TYPES_REL },
  ]

  it('CaptureSource matches canonical 9-value list in both web and web-next', () => {
    assertUnionMatchesCanonical(
      TYPES_TARGETS,
      'CaptureSource',
      CANONICAL_CAPTURE_SOURCES,
      'packages/shared/src/types/capture.ts',
    )
  })

  it('CaptureType matches canonical 8-value list in both web and web-next', () => {
    assertUnionMatchesCanonical(
      TYPES_TARGETS,
      'CaptureType',
      CANONICAL_CAPTURE_TYPES,
      'packages/shared/src/types/capture.ts',
    )
  })

  it('PipelineStatus matches canonical 8-value list in both web and web-next', () => {
    assertUnionMatchesCanonical(
      TYPES_TARGETS,
      'PipelineStatus',
      CANONICAL_PIPELINE_STATUSES,
      'packages/shared/src/types/capture.ts',
    )
  })
})

// Canonical brief type sets — source of truth: packages/shared/src/types/brief.ts
// Locked against DB CHECK constraints in migration 0030 (briefs_kind_check,
// briefs_cover_check). When adding a value, update all four surfaces in lockstep:
//   1. packages/shared/src/types/brief.ts (TS union + Zod schema + BRIEF_* const)
//   2. packages/shared/drizzle/0030_briefs.sql (DB CHECK constraint)
//   3. packages/web-next/lib/types.ts (local redeclaration per D109)
//   4. CANONICAL_BRIEF_* constant in this test file
//
// See also: Cloudscape M2 items 4.2 (schema), 4.5 (this guard), 4.6 (web-next side).

/** 6-value BriefKind set (migration 0030 briefs_kind_check). */
const CANONICAL_BRIEF_KINDS = [
  'DAILY', 'DECISION', 'DOSSIER', 'MONTHLY', 'PROJECT', 'WEEKLY',
] as const

/** 6-value BriefCover set (migration 0030 briefs_cover_check). */
const CANONICAL_BRIEF_COVERS = [
  'canvas', 'evening', 'gold', 'parchment', 'slate', 'sunrise',
] as const

/** 4-value BriefSourceType set (packages/shared/src/types/brief.ts). */
const CANONICAL_BRIEF_SOURCE_TYPES = [
  'EMAIL', 'MEETING', 'NOTE', 'VOICE',
] as const

describe('brief type drift guard — web-next only (Cloudscape M2 item 4.5 / D109)', () => {
  /**
   * BriefKind, BriefCover, and BriefSourceType are new canonical types added in
   * Phase 4 (CS2 schema, migration 0030). They are brief-domain types that live
   * only in packages/shared/src/types/brief.ts and must be redeclared locally in
   * packages/web-next/lib/types.ts per decision D109 (no @open-brain/shared runtime
   * import in the Next.js bundle).
   *
   * These types are NOT declared in packages/web/src/lib/types.ts because the
   * existing `web` package has no briefs UI surface — only web-next does.
   *
   * IMPORTANT: This suite is written as part of item 4.5 and intentionally asserts
   * the final state that item 4.6 must produce. Until item 4.6 updates
   * packages/web-next/lib/types.ts to have the correct values, these tests will fail.
   * That is the expected behaviour: 4.5 (this guard) catches drift; 4.6 fixes web-next.
   *
   * If this test fails:
   *   1. Fix the `export type X = ...` union in packages/web-next/lib/types.ts.
   *   2. Canonical source of truth is packages/shared/src/types/brief.ts + migration 0030.
   *   3. Do NOT change the shared brief types to match a stale web-next declaration.
   */

  // Brief types live in web-next only (not in the legacy `web` package).
  const WEB_NEXT_ONLY_TARGET = [
    { path: WEB_NEXT_TYPES_PATH, label: WEB_NEXT_TYPES_REL },
  ]

  it('BriefKind matches canonical 6-value list in web-next', () => {
    assertUnionMatchesCanonical(
      WEB_NEXT_ONLY_TARGET,
      'BriefKind',
      CANONICAL_BRIEF_KINDS,
      'packages/shared/src/types/brief.ts',
    )
  })

  it('BriefCover matches canonical 6-value list in web-next', () => {
    assertUnionMatchesCanonical(
      WEB_NEXT_ONLY_TARGET,
      'BriefCover',
      CANONICAL_BRIEF_COVERS,
      'packages/shared/src/types/brief.ts',
    )
  })

  it('BriefSourceType matches canonical 4-value list in web-next', () => {
    assertUnionMatchesCanonical(
      WEB_NEXT_ONLY_TARGET,
      'BriefSourceType',
      CANONICAL_BRIEF_SOURCE_TYPES,
      'packages/shared/src/types/brief.ts',
    )
  })
})
