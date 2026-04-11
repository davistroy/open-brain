/**
 * MCP tools for wiki operations.
 *
 * 4 tools:
 *   search_wiki      — full-text search across wiki pages
 *   read_wiki_page   — read a page by path
 *   write_wiki_page  — create/update page (auto-commits)
 *   list_wiki_pages  — list with optional type filter
 */

import { z } from 'zod'
import type { WikiService } from '../../services/wiki.js'

// ---------------------------------------------------------------------------
// search_wiki
// ---------------------------------------------------------------------------

export const searchWikiSchema = z.object({
  query: z.string().min(1).describe('Search query string to find in wiki pages'),
})

export type SearchWikiInput = z.infer<typeof searchWikiSchema>

export async function searchWikiTool(
  input: SearchWikiInput,
  wikiService: WikiService,
): Promise<string> {
  const results = await wikiService.search(input.query)

  if (results.length === 0) {
    return `No wiki pages found matching "${input.query}".`
  }

  const lines: string[] = [
    `Wiki search: "${input.query}"`,
    `Found ${results.length} page${results.length !== 1 ? 's' : ''}`,
    '',
  ]

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(`${i + 1}. ${r.frontmatter.title || r.path}`)
    lines.push(`   Path: ${r.path}`)
    lines.push(`   Type: ${r.frontmatter.type}`)
    if (r.frontmatter.tags?.length) {
      lines.push(`   Tags: ${r.frontmatter.tags.join(', ')}`)
    }
    lines.push(`   ${r.snippet}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// read_wiki_page
// ---------------------------------------------------------------------------

export const readWikiPageSchema = z.object({
  path: z.string().min(1).describe('Path to the wiki page relative to wiki root (e.g. "entities/kubernetes.md")'),
})

export type ReadWikiPageInput = z.infer<typeof readWikiPageSchema>

export async function readWikiPageTool(
  input: ReadWikiPageInput,
  wikiService: WikiService,
): Promise<string> {
  const page = await wikiService.getPage(input.path)
  if (!page) {
    return `Wiki page not found: ${input.path}`
  }

  const lines: string[] = [
    `# ${page.frontmatter.title || page.path}`,
    '',
    `**Type:** ${page.frontmatter.type}`,
    `**Created:** ${page.frontmatter.created}`,
    `**Updated:** ${page.frontmatter.updated}`,
  ]

  if (page.frontmatter.source_count !== undefined) {
    lines.push(`**Sources:** ${page.frontmatter.source_count}`)
  }
  if (page.frontmatter.tags?.length) {
    lines.push(`**Tags:** ${page.frontmatter.tags.join(', ')}`)
  }
  if (page.frontmatter.aliases?.length) {
    lines.push(`**Aliases:** ${page.frontmatter.aliases.join(', ')}`)
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(page.content)

  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// write_wiki_page
// ---------------------------------------------------------------------------

export const writeWikiPageSchema = z.object({
  path: z.string().min(1).describe('Path for the wiki page relative to wiki root (e.g. "entities/kubernetes.md")'),
  title: z.string().min(1).describe('Page title'),
  type: z.enum(['entity', 'concept', 'source', 'comparison', 'synthesis', 'overview']).describe('Page type'),
  content: z.string().min(1).describe('Markdown body content (without frontmatter)'),
  tags: z.array(z.string()).optional().describe('Optional tags for the page'),
  commit_message: z.string().optional().describe('Git commit message (auto-generated if omitted)'),
})

export type WriteWikiPageInput = z.infer<typeof writeWikiPageSchema>

export async function writeWikiPageTool(
  input: WriteWikiPageInput,
  wikiService: WikiService,
): Promise<string> {
  const now = new Date().toISOString().slice(0, 10)

  // Check if page already exists to preserve created date
  const existing = await wikiService.getPage(input.path)

  const frontmatter = {
    title: input.title,
    type: input.type,
    created: existing?.frontmatter.created || now,
    updated: now,
    ...(input.tags?.length ? { tags: input.tags } : {}),
  }

  const commitMsg = input.commit_message || `wiki: ${existing ? 'update' : 'create'} ${input.path}`

  await wikiService.writePage(input.path, input.content, frontmatter, commitMsg)

  return [
    `Wiki page ${existing ? 'updated' : 'created'} successfully.`,
    '',
    `Path:   ${input.path}`,
    `Title:  ${input.title}`,
    `Type:   ${input.type}`,
    `Commit: ${commitMsg}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// list_wiki_pages
// ---------------------------------------------------------------------------

export const listWikiPagesSchema = z.object({
  type: z.string().optional().describe('Filter by page type (entity, concept, source, comparison, synthesis, overview)'),
  tag: z.string().optional().describe('Filter by tag'),
})

export type ListWikiPagesInput = z.infer<typeof listWikiPagesSchema>

export async function listWikiPagesTool(
  input: ListWikiPagesInput,
  wikiService: WikiService,
): Promise<string> {
  const pages = await wikiService.listPages(input.type, input.tag)

  if (pages.length === 0) {
    const filters = [
      input.type ? `type=${input.type}` : '',
      input.tag ? `tag=${input.tag}` : '',
    ].filter(Boolean).join(', ')
    return `No wiki pages found${filters ? ` (filters: ${filters})` : ''}.`
  }

  const lines: string[] = [
    `Wiki pages: ${pages.length} found`,
    '',
  ]

  for (const p of pages) {
    const tags = p.frontmatter.tags?.length ? ` [${p.frontmatter.tags.join(', ')}]` : ''
    lines.push(`- ${p.frontmatter.title || p.path} (${p.frontmatter.type})${tags}`)
    lines.push(`  Path: ${p.path} | Updated: ${p.frontmatter.updated}`)
  }

  return lines.join('\n').trimEnd()
}
