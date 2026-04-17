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
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WEB_API_PATH = resolve(__dirname, '../../../web/src/lib/api.ts')
const SHARED_SCHEMA_PATH = 'packages/shared/src/schema/ingest.ts'
const WEB_API_REL = 'packages/web/src/lib/api.ts'

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
