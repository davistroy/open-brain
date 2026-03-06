import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CaptureService } from '../../services/capture.js'
import type { SearchService } from '../../services/search.js'
import type { ConfigService } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'

import { searchBrainSchema, searchBrainTool } from './search-brain.js'
import { listCapturesSchema, listCapturesTool } from './list-captures.js'
import { brainStatsSchema, brainStatsTool } from './brain-stats.js'
import { captureThoughtSchema, captureThoughtTool } from './capture-thought.js'
import { getEntitySchema, getEntityTool } from './get-entity.js'
import { listEntitiesSchema, listEntitiesTool } from './list-entities.js'
import { getWeeklyBriefSchema, getWeeklyBriefTool } from './get-weekly-brief.js'

interface RegisterToolsDeps {
  server: McpServer
  captureService: CaptureService
  searchService: SearchService
  configService: ConfigService
  db: Database
}

export function registerMcpTools(deps: RegisterToolsDeps): void {
  const { server, captureService, searchService, configService, db } = deps

  // Tool 1: search_brain — semantic + FTS hybrid search
  server.tool(
    'search_brain',
    'Search your captured knowledge using semantic and full-text search. Returns ranked results with match percentages.',
    searchBrainSchema.shape,
    async (input) => {
      const result = await searchBrainTool(input as any, searchService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 2: list_captures — browse captures with filters
  server.tool(
    'list_captures',
    'List recent captures with optional filters for type, source, and time range.',
    listCapturesSchema.shape,
    async (input) => {
      const result = await listCapturesTool(input as any, captureService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 3: brain_stats — statistics about captured knowledge
  server.tool(
    'brain_stats',
    'Get statistics about your captured knowledge: totals by source, type, brain view, and pipeline health.',
    brainStatsSchema.shape,
    async (input) => {
      const result = await brainStatsTool(input as any, captureService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 4: capture_thought — create a new capture
  server.tool(
    'capture_thought',
    'Capture a thought, idea, decision, or note. The capture will be automatically embedded and processed through the pipeline.',
    captureThoughtSchema.shape,
    async (input) => {
      const result = await captureThoughtTool(input as any, captureService, configService)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 5: get_entity — look up a specific entity
  server.tool(
    'get_entity',
    'Look up a specific entity (person, organization, project) by name or ID and see recent related captures.',
    getEntitySchema.shape,
    async (input) => {
      const result = await getEntityTool(input as any, db)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 6: list_entities — browse entities
  server.tool(
    'list_entities',
    'List entities (people, organizations, projects) extracted from your captures, sorted by mention count or last seen date.',
    listEntitiesSchema.shape,
    async (input) => {
      const result = await listEntitiesTool(input as any, db)
      return { content: [{ type: 'text', text: result }] }
    },
  )

  // Tool 7: get_weekly_brief — retrieve generated weekly brief
  server.tool(
    'get_weekly_brief',
    'Retrieve the most recent weekly brain brief, or a brief from N weeks ago.',
    getWeeklyBriefSchema.shape,
    async (input) => {
      const result = await getWeeklyBriefTool(input as any, db)
      return { content: [{ type: 'text', text: result }] }
    },
  )
}
