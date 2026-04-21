/**
 * brief-renderer.ts — Unified-stack Markdown → HTML renderer for briefs.
 *
 * Single pipeline pass:
 *   remark-parse → remark-rehype → rehype-slug → rehype-autolink-headings
 *   → extract TOC (custom plugin) → rehype-stringify → xss sanitize
 *
 * Public surface:
 *   renderBriefHtml(markdown)          → { html, toc }
 *   mapCaptureSourceToBriefType(source) → BriefSourceType
 *
 * Deps declared in packages/workers/package.json (unified ESM ecosystem).
 * The shared package is also ESM ("type": "module") so top-level imports work.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeStringify from 'rehype-stringify'
import { filterXSS, type IFilterXSSOptions, type IWhiteList } from 'xss'

import type { TocItem, BriefSourceType } from '../types/brief.js'
import { BRIEF_SOURCE_TYPE_MAP } from '../types/brief.js'
import type { CaptureSource } from '../types/capture.js'

// ---------------------------------------------------------------------------
// Internal HAST types — minimal shapes; avoids a hard dep on the `hast`
// types-only package. Compatible with what rehype-slug + rehype-stringify use.
// ---------------------------------------------------------------------------

interface HastText {
  type: 'text'
  value: string
}

interface HastElement {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

interface HastRoot {
  type: 'root'
  children: HastNode[]
}

type HastNode = HastText | HastElement | HastRoot | { type: string; children?: HastNode[] }

// ---------------------------------------------------------------------------
// TOC extraction helpers
// ---------------------------------------------------------------------------

/** Heading tag names we include in the TOC (h1–h3). */
const TOC_HEADING_TAGS = new Set(['h1', 'h2', 'h3'])

/**
 * Extracts plain-text content from a HAST node tree (recursive).
 * Concatenates all Text nodes, strips everything else.
 */
function extractText(node: HastNode): string {
  if (node.type === 'text') {
    return (node as HastText).value
  }
  const children = (node as { children?: HastNode[] }).children
  if (!children) return ''
  return children.map(extractText).join('')
}

/**
 * Walks a HAST root and collects h1/h2/h3 elements that have an `id`
 * property (injected by rehype-slug). Returns them in document order.
 *
 * Called from the custom rehype plugin *after* rehype-slug runs.
 */
export function extractToc(root: HastRoot): TocItem[] {
  const items: TocItem[] = []

  function walk(nodes: HastNode[]): void {
    for (const node of nodes) {
      if (node.type === 'element') {
        const el = node as HastElement
        if (TOC_HEADING_TAGS.has(el.tagName)) {
          const id = el.properties?.id
          if (typeof id === 'string' && id.length > 0) {
            const level = parseInt(el.tagName.slice(1), 10)
            const text = extractText(el).trim()
            if (text) {
              items.push({ id, text, level })
            }
          }
        }
        // Recurse into children (headings won't nest but wrapper divs might)
        if (el.children?.length) {
          walk(el.children)
        }
      } else {
        const withChildren = node as { children?: HastNode[] }
        if (withChildren.children?.length) {
          walk(withChildren.children)
        }
      }
    }
  }

  walk(root.children)
  return items
}

// ---------------------------------------------------------------------------
// XSS allowlist — permit common formatting and heading tags; strip scripts,
// event handlers, and any other potentially dangerous markup.
// ---------------------------------------------------------------------------
const XSS_ALLOWLIST: IWhiteList = {
  h1: ['id'],
  h2: ['id'],
  h3: ['id'],
  h4: ['id'],
  h5: ['id'],
  h6: ['id'],
  p: [],
  a: ['href', 'title', 'target', 'rel'],
  strong: [],
  b: [],
  em: [],
  i: [],
  code: [],
  pre: ['class'],
  blockquote: [],
  ul: [],
  ol: [],
  li: [],
  br: [],
  hr: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['align'],
  td: ['align'],
  del: [],
  s: [],
  sup: [],
  sub: [],
  // span emitted by rehype-autolink-headings
  span: ['class', 'aria-hidden'],
  // aria attributes on autolink anchors
}

const xssOptions: IFilterXSSOptions = {
  whiteList: XSS_ALLOWLIST,
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Renders a markdown string to sanitized HTML plus a table of contents.
 *
 * Pipeline (single AST pass):
 *   1. remark-parse    — Markdown → MDAST
 *   2. remark-rehype   — MDAST → HAST
 *   3. rehype-slug     — adds `id` attrs to headings
 *   4. rehype-autolink-headings — wraps heading text in anchor links
 *   5. Custom plugin   — extracts TOC from HAST (runs here, before stringify)
 *   6. rehype-stringify — HAST → HTML string
 *   7. xss sanitize    — strips disallowed tags/attrs
 *
 * @param markdown - Raw markdown string (may be empty)
 * @returns Object with sanitized `html` string and `toc` array
 */
export function renderBriefHtml(markdown: string): { html: string; toc: TocItem[] } {
  if (!markdown || markdown.trim().length === 0) {
    return { html: '', toc: [] }
  }

  let extractedToc: TocItem[] = []

  /**
   * Custom rehype plugin — runs *after* rehype-slug (headings have ids)
   * but *before* rehype-stringify. Extracts the TOC into the closure
   * variable so it's available after `.processSync()` returns.
   */
  function rehypeTocExtract() {
    return (tree: unknown) => {
      extractedToc = extractToc(tree as HastRoot)
    }
  }

  const file = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: 'wrap' })
    .use(rehypeTocExtract)
    .use(rehypeStringify)
    .processSync(markdown)

  const rawHtml = String(file)
  const sanitizedHtml = filterXSS(rawHtml, xssOptions)

  return {
    html: sanitizedHtml,
    toc: extractedToc,
  }
}

// ---------------------------------------------------------------------------
// Source mapping
// ---------------------------------------------------------------------------

/**
 * Maps a captures.source string to a BriefSourceType.
 *
 * Canonical mapping (mirrors BRIEF_SOURCE_TYPE_MAP in types/brief.ts):
 *   voice    → VOICE
 *   email    → EMAIL
 *   calendar → MEETING (reserved for morning-brief calendar events)
 *   all else → NOTE   (api, mcp, slack, document, file, consolidation, system)
 *
 * Unknown sources default to NOTE for forward-compatibility.
 *
 * @param source - A CaptureSource value
 * @returns The corresponding BriefSourceType
 */
export function mapCaptureSourceToBriefType(source: CaptureSource): BriefSourceType {
  return BRIEF_SOURCE_TYPE_MAP[source] ?? 'NOTE'
}
