import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CaptureService } from '../../services/capture.js'
import type { SearchService } from '../../services/search.js'
import type { EntityService } from '../../services/entity.js'
import type { WikiService } from '../../services/wiki.js'
import type { ConfigService } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'

import { searchBrainSchema, searchBrainTool, type SearchBrainInput } from './search-brain.js'
import { listCapturesSchema, listCapturesTool, type ListCapturesInput } from './list-captures.js'
import { brainStatsSchema, brainStatsTool, type BrainStatsInput } from './brain-stats.js'
import { captureThoughtSchema, captureThoughtTool, type CaptureThoughtInput } from './capture-thought.js'
import { getEntitySchema, getEntitySchemaShape, getEntityTool, type GetEntityInput } from './get-entity.js'
import { listEntitiesSchema, listEntitiesTool, type ListEntitiesInput } from './list-entities.js'
import { getWeeklyBriefSchema, getWeeklyBriefTool, type GetWeeklyBriefInput } from './get-weekly-brief.js'
import { getCaptureSchema, getCaptureTool, type GetCaptureInput } from './get-capture.js'
import {
  searchWikiSchema, searchWikiTool, type SearchWikiInput,
  readWikiPageSchema, readWikiPageTool, type ReadWikiPageInput,
  writeWikiPageSchema, writeWikiPageTool, type WriteWikiPageInput,
  listWikiPagesSchema, listWikiPagesTool, type ListWikiPagesInput,
} from './wiki-tools.js'

interface RegisterToolsDeps {
  server: McpServer
  captureService: CaptureService
  searchService: SearchService
  configService: ConfigService
  db: Database
  entityService?: EntityService
  wikiService?: WikiService
}

export function registerMcpTools(deps: RegisterToolsDeps): void {
  const { server, captureService, searchService, configService, db, entityService, wikiService } = deps

  // Tool 1: search_brain — semantic + FTS hybrid search
  server.tool(
    'search_brain',
    'Search your captured knowledge using semantic and full-text search. Returns ranked results with match percentages.',
    searchBrainSchema.shape,
    async (input) => {
      const result = await searchBrainTool(input as SearchBrainInput, searchService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 2: list_captures — browse captures with filters
  server.tool(
    'list_captures',
    'List recent captures with optional filters for type, source, and time range.',
    listCapturesSchema.shape,
    async (input) => {
      const result = await listCapturesTool(input as ListCapturesInput, captureService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 3: brain_stats — statistics about captured knowledge
  server.tool(
    'brain_stats',
    'Get statistics about your captured knowledge: totals by source, type, brain view, and pipeline health.',
    brainStatsSchema.shape,
    async (input) => {
      const result = await brainStatsTool(input as BrainStatsInput, captureService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 4: capture_thought — create a new capture
  server.tool(
    'capture_thought',
    'Capture a thought, idea, decision, or note. The capture will be automatically embedded and processed through the pipeline.',
    captureThoughtSchema.shape,
    async (input) => {
      const result = await captureThoughtTool(input as CaptureThoughtInput, captureService, configService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 5: get_entity — look up a specific entity
  server.tool(
    'get_entity',
    'Look up a specific entity (person, organization, project) by name or ID and see recent related captures.',
    getEntitySchemaShape,
    async (input) => {
      const result = await getEntityTool(input as GetEntityInput, db, entityService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 6: list_entities — browse entities
  server.tool(
    'list_entities',
    'List entities (people, organizations, projects) extracted from your captures, sorted by mention count or last seen date.',
    listEntitiesSchema.shape,
    async (input) => {
      const result = await listEntitiesTool(input as ListEntitiesInput, db, entityService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 7: get_weekly_brief — retrieve generated weekly brief
  server.tool(
    'get_weekly_brief',
    'Retrieve the most recent weekly brain brief, or a brief from N weeks ago.',
    getWeeklyBriefSchema.shape,
    async (input) => {
      const result = await getWeeklyBriefTool(input as GetWeeklyBriefInput, db)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 8: get_capture — fetch full capture by ID
  server.tool(
    'get_capture',
    'Get the full content of a specific capture by ID. Use after search_brain or list_captures to read complete content instead of truncated previews.',
    getCaptureSchema.shape,
    async (input) => {
      const result = await getCaptureTool(input as GetCaptureInput, captureService, db)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // ---- Wiki tools (only registered when WikiService is available) ----
  if (wikiService) {
    // Tool 9: search_wiki — full-text search across wiki pages
    server.tool(
      'search_wiki',
      'Search the knowledge wiki for pages matching a query. Returns page titles, paths, types, and content snippets.',
      searchWikiSchema.shape,
      async (input) => {
        const result = await searchWikiTool(input as SearchWikiInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      },
    )

    // Tool 10: read_wiki_page — read a page by path
    server.tool(
      'read_wiki_page',
      'Read a wiki page by its path. Returns full content with frontmatter metadata (title, type, tags, dates).',
      readWikiPageSchema.shape,
      async (input) => {
        const result = await readWikiPageTool(input as ReadWikiPageInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      },
    )

    // Tool 11: write_wiki_page — create or update a page (auto-commits)
    server.tool(
      'write_wiki_page',
      'Create or update a wiki page. Auto-commits and pushes to the wiki Git repository. Use for documenting knowledge, entities, concepts, or synthesis.',
      writeWikiPageSchema.shape,
      async (input) => {
        const result = await writeWikiPageTool(input as WriteWikiPageInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      },
    )

    // Tool 12: list_wiki_pages — list pages with optional type filter
    server.tool(
      'list_wiki_pages',
      'List wiki pages with optional filtering by type (entity, concept, source, comparison, synthesis, overview) or tag.',
      listWikiPagesSchema.shape,
      async (input) => {
        const result = await listWikiPagesTool(input as ListWikiPagesInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      },
    )
  }
}
