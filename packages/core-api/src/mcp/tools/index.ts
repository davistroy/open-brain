import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CaptureService } from '../../services/capture.js'
import type { SearchService } from '../../services/search.js'
import type { EntityService } from '../../services/entity.js'
import type { WikiService } from '../../services/wiki.js'
import type { EmailDraftService } from '../../services/email-draft.js'
import type { ConfigService } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { McpActivityLogger, McpToolResult } from '../middleware/activity-logger.js'

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
import {
  draftEmailSchema, draftEmailTool, type DraftEmailInput,
  sendEmailSchema, sendEmailTool, type SendEmailInput,
  searchEmailCapturesSchema, searchEmailCapturesTool, type SearchEmailCapturesInput,
} from './email-tools.js'

interface RegisterToolsDeps {
  server: McpServer
  captureService: CaptureService
  searchService: SearchService
  configService: ConfigService
  db: Database
  entityService?: EntityService
  wikiService?: WikiService
  emailDraftService?: EmailDraftService
  activityLogger?: McpActivityLogger
  clientId?: string
}

/**
 * Helper: wraps a tool handler with activity logging if a logger is provided.
 * If no logger, returns the handler unchanged.
 */
function withLogging(
  toolName: string,
  handler: (input: Record<string, unknown>) => Promise<McpToolResult>,
  activityLogger?: McpActivityLogger,
  clientId?: string,
): (input: Record<string, unknown>) => Promise<McpToolResult> {
  if (!activityLogger) return handler
  return activityLogger.wrapToolHandler(toolName, handler, clientId)
}

export function registerMcpTools(deps: RegisterToolsDeps): void {
  const { server, captureService, searchService, configService, db, entityService, wikiService, emailDraftService, activityLogger, clientId } = deps

  // Tool 1: search_brain — semantic + FTS hybrid search
  server.tool(
    'search_brain',
    'Search your captured knowledge using semantic and full-text search. Returns ranked results with match percentages.',
    searchBrainSchema.shape,
    withLogging('search_brain', async (input) => {
      const result = await searchBrainTool(input as SearchBrainInput, searchService)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 2: list_captures — browse captures with filters
  server.tool(
    'list_captures',
    'List recent captures with optional filters for type, source, and time range.',
    listCapturesSchema.shape,
    withLogging('list_captures', async (input) => {
      const result = await listCapturesTool(input as ListCapturesInput, captureService)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 3: brain_stats — statistics about captured knowledge
  server.tool(
    'brain_stats',
    'Get statistics about your captured knowledge: totals by source, type, brain view, and pipeline health.',
    brainStatsSchema.shape,
    withLogging('brain_stats', async (input) => {
      const result = await brainStatsTool(input as BrainStatsInput, captureService)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 4: capture_thought — create a new capture
  server.tool(
    'capture_thought',
    'Capture a thought, idea, decision, or note. The capture will be automatically embedded and processed through the pipeline.',
    captureThoughtSchema.shape,
    withLogging('capture_thought', async (input) => {
      const result = await captureThoughtTool(input as CaptureThoughtInput, captureService, configService)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 5: get_entity — look up a specific entity
  server.tool(
    'get_entity',
    'Look up a specific entity (person, organization, project) by name or ID and see recent related captures.',
    getEntitySchemaShape,
    withLogging('get_entity', async (input) => {
      const result = await getEntityTool(input as GetEntityInput, db, entityService)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 6: list_entities — browse entities
  server.tool(
    'list_entities',
    'List entities (people, organizations, projects) extracted from your captures, sorted by mention count or last seen date.',
    listEntitiesSchema.shape,
    withLogging('list_entities', async (input) => {
      const result = await listEntitiesTool(input as ListEntitiesInput, db, entityService)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 7: get_weekly_brief — retrieve generated weekly brief
  server.tool(
    'get_weekly_brief',
    'Retrieve the most recent weekly brain brief, or a brief from N weeks ago.',
    getWeeklyBriefSchema.shape,
    withLogging('get_weekly_brief', async (input) => {
      const result = await getWeeklyBriefTool(input as GetWeeklyBriefInput, db)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // Tool 8: get_capture — fetch full capture by ID
  server.tool(
    'get_capture',
    'Get the full content of a specific capture by ID. Use after search_brain or list_captures to read complete content instead of truncated previews.',
    getCaptureSchema.shape,
    withLogging('get_capture', async (input) => {
      const result = await getCaptureTool(input as GetCaptureInput, captureService, db)
      return { content: [{ type: 'text', text: result }] }
    }, activityLogger, clientId),
  )

  // ---- Wiki tools (only registered when WikiService is available) ----
  if (wikiService) {
    // Tool 9: search_wiki — full-text search across wiki pages
    server.tool(
      'search_wiki',
      'Search the knowledge wiki for pages matching a query. Returns page titles, paths, types, and content snippets.',
      searchWikiSchema.shape,
      withLogging('search_wiki', async (input) => {
        const result = await searchWikiTool(input as SearchWikiInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )

    // Tool 10: read_wiki_page — read a page by path
    server.tool(
      'read_wiki_page',
      'Read a wiki page by its path. Returns full content with frontmatter metadata (title, type, tags, dates).',
      readWikiPageSchema.shape,
      withLogging('read_wiki_page', async (input) => {
        const result = await readWikiPageTool(input as ReadWikiPageInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )

    // Tool 11: write_wiki_page — create or update a page (auto-commits)
    server.tool(
      'write_wiki_page',
      'Create or update a wiki page. Auto-commits and pushes to the wiki Git repository. Use for documenting knowledge, entities, concepts, or synthesis.',
      writeWikiPageSchema.shape,
      withLogging('write_wiki_page', async (input) => {
        const result = await writeWikiPageTool(input as WriteWikiPageInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )

    // Tool 12: list_wiki_pages — list pages with optional type filter
    server.tool(
      'list_wiki_pages',
      'List wiki pages with optional filtering by type (entity, concept, source, comparison, synthesis, overview) or tag.',
      listWikiPagesSchema.shape,
      withLogging('list_wiki_pages', async (input) => {
        const result = await listWikiPagesTool(input as ListWikiPagesInput, wikiService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )
  }

  // ---- Email tools (only registered when EmailDraftService is available) ----
  if (emailDraftService) {
    // Tool 13: draft_email — create an email draft
    server.tool(
      'draft_email',
      'Create an email draft for review. The draft must be approved before sending. Use send_email to approve and send.',
      draftEmailSchema.shape,
      withLogging('draft_email', async (input) => {
        const result = await draftEmailTool(input as DraftEmailInput, emailDraftService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )

    // Tool 14: send_email — approve and send a draft
    server.tool(
      'send_email',
      'Approve and send an email draft by its ID. The draft must exist and be in "draft" or "approved" status.',
      sendEmailSchema.shape,
      withLogging('send_email', async (input) => {
        const result = await sendEmailTool(input as SendEmailInput, emailDraftService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )

    // Tool 15: search_email_captures — search email-type captures
    server.tool(
      'search_email_captures',
      'Search captures that originated from email (inbound or outbound). Uses semantic and full-text search.',
      searchEmailCapturesSchema.shape,
      withLogging('search_email_captures', async (input) => {
        const result = await searchEmailCapturesTool(input as SearchEmailCapturesInput, searchService)
        return { content: [{ type: 'text', text: result }] }
      }, activityLogger, clientId),
    )
  }
}
