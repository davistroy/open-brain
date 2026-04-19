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
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WEB_API_PATH = resolve(__dirname, '../../../web/src/lib/api.ts')
const WEB_TYPES_PATH = resolve(__dirname, '../../../web/src/lib/types.ts')
const SEARCH_FILTERS_PATH = resolve(__dirname, '../../../web/src/components/SearchFilters.tsx')
const TIMELINE_PATH = resolve(__dirname, '../../../web/src/pages/Timeline.tsx')
const STATS_CARDS_PATH = resolve(__dirname, '../../../web/src/components/StatsCards.tsx')
const SHARED_SCHEMA_PATH = 'packages/shared/src/schema/ingest.ts'
const WEB_API_REL = 'packages/web/src/lib/api.ts'
const WEB_TYPES_REL = 'packages/web/src/lib/types.ts'
const SEARCH_FILTERS_REL = 'packages/web/src/components/SearchFilters.tsx'
const TIMELINE_REL = 'packages/web/src/pages/Timeline.tsx'
const STATS_CARDS_REL = 'packages/web/src/components/StatsCards.tsx'

/**
 * Extract the string-literal members of a `export type Name = 'a' | 'b' | ...`
 * declaration from a source file. Tolerates line breaks, trailing `|`, and
 * arbitrary whitespace between members. Returns the literals in source order.
 * Throws with an actionable message if the declaration is missing or malformed.
 */
function extractUnionLiterals(source: string, typeName: string): string[] {
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
      `Drift-guard could not locate \`export type ${typeName} = ...\` in ${WEB_API_REL}. ` +
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
      `Drift-guard matched \`${typeName}\` in ${WEB_API_REL} but extracted zero ` +
        `literal members. Regex body was:\n${body}\n\n` +
        `Update the extractUnionLiterals() regex in this test.`,
    )
  }
  return literals
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
  ] as const)('StatsCards %s Record covers all canonical CaptureType keys', (constName) => {
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
