/**
 * ingest-router — YAML-driven routing for uploaded files (CS3.11).
 *
 * TypeScript mirror of `scripts/lib/ingest_router.py` (CS3.12). Both sides
 * consume the same `config/ingest-routes.yaml` so the upload endpoint
 * (CS3.4) and the Python sidecar never drift on which filename maps to
 * which pipeline + parser.
 *
 * Matching semantics follow Python's `fnmatch` (case-insensitive):
 *   `*` — any characters
 *   `?` — single character
 *   `[abc]` — character class
 *   everything else literal
 *
 * Also handles dispatch: given a `source_type`, build the compose-network
 * URL for the matching sidecar (`http://{source}-ingest:8080`) and POST
 * a `/process` request with the bearer-secret header. The response is
 * validated against `SidecarProcessResponseSchema` from `@open-brain/shared`.
 *
 * Moved from `packages/core-api/src/services/ingest-router.ts` to shared
 * (CS3.5) so both core-api routes and workers jobs can import a single
 * implementation and cannot drift.
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import yaml from 'js-yaml'
import { HttpError } from '../utils/fetch-helpers.js'
import { createLogger } from '../lib/logger.js'
import {
  SidecarProcessResponseSchema,
  type SidecarProcessResponse,
} from '../schema/ingest.js'

const logger = createLogger('ingest-router')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single routing rule as it appears in the YAML (flattened with the
 * parent source_type + derived pipeline filename for convenience).
 */
export interface IngestRoute {
  source_type: string
  /** Conventional Python pipeline filename (`{source}-pipeline.py`). */
  pipeline: string
  parser: string
  pattern: string
  header_sniff: string | null
}

interface RawRule {
  pattern?: unknown
  parser?: unknown
  header_sniff?: unknown
}

interface RawRoutesYaml {
  routes?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// YAML load + cache
// ---------------------------------------------------------------------------

let _cache: IngestRoute[] | null = null
let _cacheSource: string | null = null

const DEFAULT_CONTAINER_PATH = '/app/config/ingest-routes.yaml'

function resolveRoutesPath(explicit?: string): string {
  if (explicit) return explicit
  const envPath = process.env.INGEST_ROUTES_PATH
  if (envPath) return envPath
  // Prefer container default when present; fall back to repo-relative path.
  try {
    readFileSync(DEFAULT_CONTAINER_PATH, 'utf-8')
    return DEFAULT_CONTAINER_PATH
  } catch {
    return join(process.cwd(), 'config', 'ingest-routes.yaml')
  }
}

/**
 * Load (and memoize) the routes from `config/ingest-routes.yaml`.
 *
 * Returns a flat list of `IngestRoute` — each rule carries its parent
 * `source_type` and derived `pipeline` filename. Source-type order and
 * within-source rule order match the YAML declaration order; callers that
 * match by filename should iterate in order (first match wins), matching
 * the Python side.
 *
 * @param explicitPath Optional override — primarily for tests.
 */
export function loadRoutes(explicitPath?: string): IngestRoute[] {
  const path = resolveRoutesPath(explicitPath)

  if (_cache !== null && _cacheSource === path) {
    return _cache
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    logger.error({ path, err: err instanceof Error ? err.message : String(err) }, 'Failed to read ingest-routes.yaml')
    throw new Error(`ingest-routes.yaml not found at ${path}`)
  }

  const parsed = yaml.load(raw) as RawRoutesYaml | null | undefined
  const routes: IngestRoute[] = []

  if (!parsed || typeof parsed !== 'object') {
    logger.warn({ path }, 'ingest-routes.yaml is empty or not a mapping — using empty route set')
    _cache = routes
    _cacheSource = path
    return routes
  }

  const rawRoutes = parsed.routes
  if (rawRoutes && typeof rawRoutes === 'object') {
    // Preserve declaration order from the YAML (js-yaml returns insertion-ordered objects).
    for (const [sourceType, rules] of Object.entries(rawRoutes)) {
      if (!Array.isArray(rules)) continue
      for (const rule of rules as RawRule[]) {
        if (!rule || typeof rule !== 'object') continue
        const pattern = typeof rule.pattern === 'string' ? rule.pattern : null
        const parser = typeof rule.parser === 'string' ? rule.parser : null
        if (!pattern || !parser) continue
        const headerSniff = typeof rule.header_sniff === 'string' ? rule.header_sniff : null
        routes.push({
          source_type: sourceType,
          pipeline: `${sourceType}-pipeline.py`,
          parser,
          pattern,
          header_sniff: headerSniff,
        })
      }
    }
  }

  _cache = routes
  _cacheSource = path
  logger.debug({ path, routeCount: routes.length }, 'Loaded ingest routes')
  return routes
}

/** Reset the module cache — exported for tests. */
export function _clearIngestRoutesCache(): void {
  _cache = null
  _cacheSource = null
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Return all routes for a given source_type (in declaration order), or
 * `null` if the source_type is unknown.
 */
export function routeForSourceType(sourceType: string, explicitPath?: string): IngestRoute | null {
  if (!sourceType) return null
  const routes = loadRoutes(explicitPath)
  const match = routes.find((r) => r.source_type === sourceType)
  return match ?? null
}

/**
 * Return the first route whose pattern matches `filename`, or `null`.
 * Matching is case-insensitive and uses fnmatch-style globs (see module
 * header). Matches the Python `route_for_filename` behaviour so both
 * sides agree on dispatch for every filename.
 */
export function routeForFilename(filename: string, explicitPath?: string): IngestRoute | null {
  if (!filename) return null
  const base = basename(filename).toLowerCase()
  const routes = loadRoutes(explicitPath)
  for (const route of routes) {
    if (fnmatchCaseInsensitive(base, route.pattern)) {
      return route
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// fnmatch-compatible glob matcher
// ---------------------------------------------------------------------------

/**
 * Translate an fnmatch-style glob into a regex source string. Mirrors
 * CPython's `fnmatch.translate` closely enough for the patterns used in
 * `ingest-routes.yaml` (which are simple `*` / `?` / literal globs with
 * no character classes in the seeded file, but we support `[...]` too
 * for forward compatibility).
 */
function translateGlob(pattern: string): string {
  let i = 0
  const n = pattern.length
  let out = ''
  while (i < n) {
    const c = pattern[i]
    i++
    if (c === '*') {
      out += '.*'
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      // Find the closing bracket.
      let j = i
      if (j < n && pattern[j] === '!') j++
      if (j < n && pattern[j] === ']') j++
      while (j < n && pattern[j] !== ']') j++
      if (j >= n) {
        // No closing bracket — treat '[' as literal.
        out += '\\['
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, '\\\\')
        if (stuff.startsWith('!')) stuff = '^' + stuff.slice(1)
        out += `[${stuff}]`
        i = j + 1
      }
    } else {
      // Escape regex metacharacters.
      out += c.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    }
  }
  return `^${out}$`
}

function fnmatchCaseInsensitive(filename: string, pattern: string): boolean {
  const re = new RegExp(translateGlob(pattern.toLowerCase()))
  return re.test(filename.toLowerCase())
}

// ---------------------------------------------------------------------------
// Sidecar dispatch
// ---------------------------------------------------------------------------

/**
 * Return the compose-network URL for the sidecar that handles a given
 * source_type. Defaults to `http://{source}-ingest:8080` (matches the
 * compose service names `financial-ingest` / `utility-ingest`). Can be
 * overridden per source_type via env `INGEST_SIDECAR_URL_<SOURCE_UPPER>`
 * — primarily for local debugging.
 */
export function sidecarUrlForSourceType(sourceType: string): string {
  const envKey = `INGEST_SIDECAR_URL_${sourceType.toUpperCase()}`
  const override = process.env[envKey]
  if (override && override.length > 0) return override.replace(/\/+$/, '')
  return `http://${sourceType}-ingest:8080`
}

export interface DispatchToSidecarInput {
  sourceType: string
  fileId: string
  filePath: string
  /** Shared secret; callers should read from `process.env.INGEST_TRIGGER_SECRET`. */
  secret: string
  /** Default 300_000 ms (5 min) to match the sidecar subprocess timeout. */
  timeoutMs?: number
}

/**
 * POST `/process` to the sidecar container for the given source_type and
 * parse the response via `SidecarProcessResponseSchema`.
 *
 * Throws `HttpError` (from `@open-brain/shared`) with status + body on
 * non-2xx responses, or a plain `Error` on timeout / network failure.
 * Callers (e.g. the CS3.5 BullMQ worker) are responsible for retry
 * policy; this function does a single attempt.
 */
export async function dispatchToSidecar(input: DispatchToSidecarInput): Promise<SidecarProcessResponse> {
  const { sourceType, fileId, filePath, secret } = input
  const timeoutMs = input.timeoutMs ?? 300_000

  const url = `${sidecarUrlForSourceType(sourceType)}/process`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'ingest',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ file_path: filePath, file_id: fileId }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HttpError(res.status, body, `sidecar ${sourceType} /process`)
    }

    const json = (await res.json()) as unknown
    return SidecarProcessResponseSchema.parse(json)
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`sidecar ${sourceType} /process timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
