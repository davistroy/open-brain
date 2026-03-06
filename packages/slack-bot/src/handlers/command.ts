/**
 * Command handler — processes Slack messages with `!` prefix.
 *
 * Supported commands:
 *   !stats                  — brain statistics
 *   !brief                  — trigger weekly brief generation
 *   !brief last             — show last brief summary
 *   !recent [N]             — recent captures (default 5, max 20)
 *   !entities               — list all entities
 *   !entity <name>          — entity detail by name
 *   !entity merge <name1> <name2> — merge two entities by name
 *   !entity split <name> <alias>  — split alias into new entity
 *   !board quick            — start quick board check governance session
 *   !board quarterly        — start quarterly review governance session
 *   !board resume <id>      — resume a paused session in a new thread
 *   !board status           — list active/paused sessions
 *   !bet list [status]      — list bets (optional: pending|correct|incorrect|ambiguous)
 *   !bet add <statement>    — create a new bet (prompts for confidence)
 *   !bet expiring [N]       — bets expiring in next N days (default 7)
 *   !bet resolve <id> <outcome> [evidence] — resolve a bet
 *   !pipeline status        — pipeline health from Bull Board data
 *   !retry <capture_id>     — retry failed capture
 *   !trigger add "text"     — create semantic trigger
 *   !trigger list           — list all triggers
 *   !trigger delete <name>  — deactivate trigger
 *   !trigger test "text"    — test trigger against existing captures
 *   !help                   — list all commands
 */

import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import type { Redis } from 'ioredis'
import type { CoreApiClient } from '../lib/core-api-client.js'
import {
  formatStats,
  formatRecentCaptures,
  formatEntityList,
  formatEntityDetail,
  formatEntityMerge,
  formatEntitySplit,
  formatPipelineStatus,
  formatTriggerList,
  formatTriggerTestResults,
  formatSessionList,
  formatSessionStart,
  formatSessionPause,
  formatSessionComplete,
  formatBetList,
  formatBetCreate,
  formatBetsExpiring,
  formatBetResolve,
  formatError,
} from '../lib/formatters.js'
import { setSessionThread } from './session.js'
import { logger } from '../lib/logger.js'

const HELP_TEXT = `*Open Brain — Available Commands*

*Captures & Stats*
  \`!stats\`              — brain statistics (counts, pipeline health)
  \`!recent [N]\`         — last N captures (default 5, max 20)
  \`!retry <id>\`         — retry a failed capture pipeline

*Briefs*
  \`!brief\`              — generate weekly brief now
  \`!brief last\`         — show last generated brief

*Entities*
  \`!entities\`                       — list all known entities
  \`!entity <name>\`                  — entity detail + linked captures
  \`!entity merge <name1> <name2>\`   — merge name1 into name2
  \`!entity split <name> <alias>\`    — split alias out of entity

*Semantic Triggers*
  \`!trigger add "text"\` — create a semantic trigger
  \`!trigger list\`       — list all triggers with status
  \`!trigger delete <n>\` — deactivate a trigger by name/id
  \`!trigger test "text"\`— test query against existing captures

*Pipeline*
  \`!pipeline status\`    — pipeline queue health

*Governance Sessions*
  \`!board quick\`           — start quick board check (reply in thread to continue)
  \`!board quarterly\`       — start quarterly review (reply in thread to continue)
  \`!board resume <id>\`     — resume a paused session
  \`!board status\`          — list active/paused sessions
  (In session thread) \`!board pause\`    — pause session
  (In session thread) \`!board done\`     — complete + generate summary
  (In session thread) \`!board abandon\`  — abandon session

*Bet Tracking*
  \`!bet list [status]\`              — list bets (pending/correct/incorrect/ambiguous)
  \`!bet add <conf> <statement>\`     — create bet (conf = 0.0–1.0)
  \`!bet expiring [N]\`              — bets expiring in next N days (default 7)
  \`!bet resolve <id> <outcome>\`    — resolve: correct | incorrect | ambiguous
  \`!bet resolve <id> <outcome> <evidence>\` — resolve with evidence

  \`!help\`               — this message`

/**
 * Parse the raw `!command args` text.
 * Returns { cmd, subCmd, subCmdRaw, args } where:
 *   cmd       — first token after `!` (lowercased)
 *   subCmd    — second token (lowercased), for dispatch
 *   subCmdRaw — second token (original casing), for display/lookup
 *   args      — remaining tokens joined (original casing)
 */
function parseCommand(text: string): { cmd: string; subCmd: string; subCmdRaw: string; args: string } {
  // Strip leading `!`
  const body = text.replace(/^!\s*/, '')
  const tokens = body.split(/\s+/)
  const cmd = (tokens[0] ?? '').toLowerCase()
  const subCmdRaw = tokens[1] ?? ''
  const subCmd = subCmdRaw.toLowerCase()
  const args = tokens.slice(2).join(' ')
  return { cmd, subCmd, subCmdRaw, args }
}

/**
 * Extract quoted or unquoted argument from a command body.
 * Handles: !trigger add "my trigger text" or !trigger add my trigger text
 */
function extractQuotedArg(subCmd: string, rest: string): string {
  // Full text after the first command token
  const combined = [subCmd, rest].filter(Boolean).join(' ')
  // Try to extract quoted string
  const quoted = combined.match(/^["'](.+?)["']$/) ?? combined.match(/["'](.+?)["']/)
  if (quoted) return quoted[1].trim()
  return combined.trim()
}

/**
 * Main command handler. Called by server.ts when IntentRouter returns intent = 'command'.
 *
 * @param message       - Slack GenericMessageEvent
 * @param say           - Bolt's say() function scoped to the current channel
 * @param coreApiClient - Initialized CoreApiClient
 * @param redis         - ioredis client (optional — required for !board session commands)
 */
export async function handleCommand(
  message: GenericMessageEvent,
  say: SayFn,
  coreApiClient: CoreApiClient,
  redis?: Redis,
): Promise<void> {
  if (!('text' in message) || !message.text) {
    logger.debug({ ts: message.ts }, 'handleCommand: empty text, skipping')
    return
  }

  const text = message.text.trim()
  const ts = message.ts

  if (!text.startsWith('!')) {
    logger.debug({ ts }, 'handleCommand: no ! prefix, skipping')
    return
  }

  const { cmd, subCmd, subCmdRaw, args } = parseCommand(text)

  logger.info({ cmd, subCmd, ts }, 'handleCommand: dispatching')

  switch (cmd) {
    // -------------------------------------------------------------------------
    case 'stats':
      await handleStats(ts, say, coreApiClient)
      break

    // -------------------------------------------------------------------------
    case 'brief':
      if (subCmd === 'last') {
        await handleBriefLast(ts, say, coreApiClient)
      } else {
        await handleBriefGenerate(ts, say, coreApiClient)
      }
      break

    // -------------------------------------------------------------------------
    case 'recent': {
      const n = subCmd ? parseInt(subCmd, 10) : 5
      const limit = isNaN(n) || n < 1 ? 5 : Math.min(n, 20)
      await handleRecent(ts, say, coreApiClient, limit)
      break
    }

    // -------------------------------------------------------------------------
    case 'entities':
      await handleEntities(ts, say, coreApiClient)
      break

    // -------------------------------------------------------------------------
    case 'entity': {
      if (subCmd === 'merge') {
        // !entity merge <name1> <name2>
        // args contains everything after "merge" (original casing)
        await handleEntityMerge(ts, say, coreApiClient, args)
      } else if (subCmd === 'split') {
        // !entity split <name> <alias>
        // args contains everything after "split" (original casing)
        await handleEntitySplit(ts, say, coreApiClient, args)
      } else {
        // !entity <name> — name is subCmdRaw + args (everything after "entity", original casing)
        const entityName = [subCmdRaw, args].filter(Boolean).join(' ').trim()
        if (!entityName) {
          await say({ text: ':warning: Usage: `!entity <name>` or `!entity merge <n1> <n2>` or `!entity split <name> <alias>`', thread_ts: ts })
        } else {
          await handleEntityDetail(ts, say, coreApiClient, entityName)
        }
      }
      break
    }

    // -------------------------------------------------------------------------
    case 'board':
      await handleBoardCommand(ts, say, coreApiClient, redis, subCmd, subCmdRaw, args)
      break

    // -------------------------------------------------------------------------
    case 'bet':
      await handleBetCommand(ts, say, coreApiClient, subCmd, subCmdRaw, args)
      break

    // -------------------------------------------------------------------------
    case 'pipeline':
      if (subCmd === 'status') {
        await handlePipelineStatus(ts, say, coreApiClient)
      } else {
        await say({ text: ':warning: Usage: `!pipeline status`', thread_ts: ts })
      }
      break

    // -------------------------------------------------------------------------
    case 'retry': {
      const captureId = subCmd
      if (!captureId) {
        await say({ text: ':warning: Usage: `!retry <capture_id>`', thread_ts: ts })
      } else {
        await handleRetry(ts, say, coreApiClient, captureId)
      }
      break
    }

    // -------------------------------------------------------------------------
    case 'trigger':
      await handleTriggerCommand(ts, say, coreApiClient, subCmd, args)
      break

    // -------------------------------------------------------------------------
    case 'help':
      await say({ text: HELP_TEXT, thread_ts: ts })
      break

    // -------------------------------------------------------------------------
    default:
      await say({
        text: `Unknown command \`!${cmd}\`. Type \`!help\` for available commands.`,
        thread_ts: ts,
      })
      break
  }
}

// =============================================================================
// Sub-handlers
// =============================================================================

async function handleStats(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const stats = await client.stats_get()
    await say({ text: formatStats(stats), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: stats_get failed')
    await say({ text: formatError('Stats unavailable', err), thread_ts: ts })
  }
}

async function handleBriefGenerate(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  // Acknowledge immediately — brief generation can take 30-60 seconds
  await say({ text: '_Generating weekly brief… this may take a minute._', thread_ts: ts })

  try {
    const result = await client.skills_trigger('weekly-brief')
    const status = result.queued
      ? 'Weekly brief queued for generation. You will be notified when it is ready.'
      : 'Weekly brief triggered.'
    await say({ text: status, thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: skills_trigger(weekly-brief) failed')
    await say({ text: formatError('Brief generation failed', err), thread_ts: ts })
  }
}

async function handleBriefLast(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const log = await client.skills_last_run('weekly-brief')
    if (!log) {
      await say({ text: '_No weekly brief has been generated yet._', thread_ts: ts })
      return
    }
    const lines = [
      `*Last Weekly Brief* — ${new Date(log.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      `Status: ${log.status}  |  Captures queried: ${log.captures_queried ?? 'n/a'}  |  Duration: ${log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : 'n/a'}`,
      log.result_summary ? `\n${log.result_summary}` : '',
    ].filter(Boolean).join('\n')
    await say({ text: lines, thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: skills_last_run failed')
    await say({ text: formatError('Could not retrieve last brief', err), thread_ts: ts })
  }
}

async function handleRecent(ts: string, say: SayFn, client: CoreApiClient, limit: number): Promise<void> {
  try {
    const result = await client.captures_list({ limit })
    await say({ text: formatRecentCaptures(result.captures, limit), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: captures_list failed')
    await say({ text: formatError('Could not retrieve recent captures', err), thread_ts: ts })
  }
}

async function handleEntities(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const result = await client.entities_list()
    await say({ text: formatEntityList(result.entities), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: entities_list failed')
    await say({ text: formatError('Could not retrieve entities', err), thread_ts: ts })
  }
}

async function handleEntityDetail(ts: string, say: SayFn, client: CoreApiClient, name: string): Promise<void> {
  try {
    const result = await client.entities_search(name)
    if (!result.entities || result.entities.length === 0) {
      await say({ text: `No entity found matching *${name}*.`, thread_ts: ts })
      return
    }
    await say({ text: formatEntityDetail(result.entities[0]), thread_ts: ts })
  } catch (err) {
    logger.error({ err, name }, 'handleCommand: entities_search failed')
    await say({ text: formatError('Could not retrieve entity', err), thread_ts: ts })
  }
}

/**
 * !entity merge <name1> <name2>
 * Looks up both entities by name, then merges source into target.
 * Uses the first search result for each name.
 */
async function handleEntityMerge(ts: string, say: SayFn, client: CoreApiClient, args: string): Promise<void> {
  // Split args into two names. Names may contain spaces; we split on double-space or quote boundary.
  // For simplicity, support: !entity merge "Name One" "Name Two"  or  !entity merge Name1 Name2
  // Strategy: try quoted extraction first, then split on comma, then split at midpoint token.
  const argsText = args.trim()

  let name1: string
  let name2: string

  // Try to extract two quoted strings
  const quoted = argsText.match(/^["'](.+?)["']\s+["'](.+?)["']$/)
  if (quoted) {
    name1 = quoted[1].trim()
    name2 = quoted[2].trim()
  } else {
    // Try comma-separated
    const commaSplit = argsText.split(',')
    if (commaSplit.length === 2) {
      name1 = commaSplit[0].trim()
      name2 = commaSplit[1].trim()
    } else {
      // Fall back to splitting tokens at midpoint
      const tokens = argsText.split(/\s+/)
      if (tokens.length < 2) {
        await say({ text: ':warning: Usage: `!entity merge <name1> <name2>`\nExample: `!entity merge "Tom Smith" "Tom S."` or `!entity merge Tom, Thomas`', thread_ts: ts })
        return
      }
      const mid = Math.ceil(tokens.length / 2)
      name1 = tokens.slice(0, mid).join(' ')
      name2 = tokens.slice(mid).join(' ')
    }
  }

  if (!name1 || !name2) {
    await say({ text: ':warning: Usage: `!entity merge <name1> <name2>`', thread_ts: ts })
    return
  }

  try {
    // Resolve names to IDs
    const source = await client.entities_search(name1)
    if (!source.entities || source.entities.length === 0) {
      await say({ text: `No entity found matching *${name1}*.`, thread_ts: ts })
      return
    }

    const target = await client.entities_search(name2)
    if (!target.entities || target.entities.length === 0) {
      await say({ text: `No entity found matching *${name2}*.`, thread_ts: ts })
      return
    }

    const sourceEntity = source.entities[0]
    const targetEntity = target.entities[0]

    if (sourceEntity.id === targetEntity.id) {
      await say({ text: ':warning: Both names resolve to the same entity — nothing to merge.', thread_ts: ts })
      return
    }

    logger.info({ sourceId: sourceEntity.id, targetId: targetEntity.id }, '[command] merging entities')

    const result = await client.entities_merge(sourceEntity.id, targetEntity.id)
    await say({ text: formatEntityMerge(result), thread_ts: ts })
  } catch (err) {
    logger.error({ err, name1, name2 }, 'handleCommand: entities_merge failed')
    await say({ text: formatError('Entity merge failed', err), thread_ts: ts })
  }
}

/**
 * !entity split <name> <alias>
 * Looks up the entity by name, then splits the given alias out into a new entity.
 */
async function handleEntitySplit(ts: string, say: SayFn, client: CoreApiClient, args: string): Promise<void> {
  const argsText = args.trim()

  if (!argsText) {
    await say({ text: ':warning: Usage: `!entity split <entity-name> <alias>`\nExample: `!entity split "Tom Smith" Tommy`', thread_ts: ts })
    return
  }

  // Try quoted extraction: !entity split "Name" "alias"  or  "Name" alias
  let entityName: string
  let alias: string

  const quoted = argsText.match(/^["'](.+?)["']\s+(.+)$/)
  if (quoted) {
    entityName = quoted[1].trim()
    alias = quoted[2].trim()
  } else {
    // Split at first comma: !entity split Tom Smith, Tommy
    const commaIdx = argsText.indexOf(',')
    if (commaIdx > 0) {
      entityName = argsText.slice(0, commaIdx).trim()
      alias = argsText.slice(commaIdx + 1).trim()
    } else {
      // Split tokens: last token is alias, rest is entity name
      const tokens = argsText.split(/\s+/)
      if (tokens.length < 2) {
        await say({ text: ':warning: Usage: `!entity split <entity-name> <alias>`', thread_ts: ts })
        return
      }
      entityName = tokens.slice(0, -1).join(' ')
      alias = tokens[tokens.length - 1]
    }
  }

  if (!entityName || !alias) {
    await say({ text: ':warning: Usage: `!entity split <entity-name> <alias>`', thread_ts: ts })
    return
  }

  try {
    const found = await client.entities_search(entityName)
    if (!found.entities || found.entities.length === 0) {
      await say({ text: `No entity found matching *${entityName}*.`, thread_ts: ts })
      return
    }

    const entity = found.entities[0]
    logger.info({ entityId: entity.id, alias }, '[command] splitting entity')

    const result = await client.entities_split(entity.id, alias)
    await say({ text: formatEntitySplit(result), thread_ts: ts })
  } catch (err) {
    logger.error({ err, entityName, alias }, 'handleCommand: entities_split failed')
    await say({ text: formatError('Entity split failed', err), thread_ts: ts })
  }
}

async function handlePipelineStatus(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const health = await client.pipeline_health()
    await say({ text: formatPipelineStatus(health), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: pipeline_health failed')
    await say({ text: formatError('Pipeline status unavailable', err), thread_ts: ts })
  }
}

async function handleRetry(ts: string, say: SayFn, client: CoreApiClient, captureId: string): Promise<void> {
  try {
    await client.captures_retry(captureId)
    await say({ text: `Capture \`${captureId}\` queued for retry.`, thread_ts: ts })
  } catch (err) {
    logger.error({ err, captureId }, 'handleCommand: captures_retry failed')
    await say({ text: formatError('Retry failed', err), thread_ts: ts })
  }
}

// =============================================================================
// Board (Governance Session) command handler
// =============================================================================

async function handleBoardCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  redis: Redis | undefined,
  subCmd: string,
  subCmdRaw: string,
  args: string,
): Promise<void> {
  switch (subCmd) {
    // -------------------------------------------------------------------------
    // !board quick — start a quick board check session
    // -------------------------------------------------------------------------
    case 'quick': {
      if (!redis) {
        await say({ text: ':warning: Redis unavailable — governance sessions require Redis.', thread_ts: ts })
        return
      }
      try {
        const result = await client.sessions_create('governance')
        // Map the current message ts → session id so thread replies are routed
        await setSessionThread(redis, ts, result.session.id)
        await say({
          text: formatSessionStart(result.session.id, 'quick board check', result.first_message),
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err }, 'handleCommand: sessions_create(governance) failed')
        await say({ text: formatError('Could not start governance session', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !board quarterly — start a quarterly review session
    // -------------------------------------------------------------------------
    case 'quarterly': {
      if (!redis) {
        await say({ text: ':warning: Redis unavailable — governance sessions require Redis.', thread_ts: ts })
        return
      }
      try {
        const result = await client.sessions_create('review')
        await setSessionThread(redis, ts, result.session.id)
        await say({
          text: formatSessionStart(result.session.id, 'quarterly review', result.first_message),
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err }, 'handleCommand: sessions_create(review) failed')
        await say({ text: formatError('Could not start quarterly review session', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !board resume <id> — resume a paused session
    // -------------------------------------------------------------------------
    case 'resume': {
      // After parseCommand: cmd='board', subCmd='resume', subCmdRaw='resume', args=<session-id...>
      // The session ID is the first token of args.
      const resolvedId = args.trim().split(/\s+/)[0] ?? ''
      if (!resolvedId) {
        await say({ text: ':warning: Usage: `!board resume <session-id>`', thread_ts: ts })
        return
      }
      if (!redis) {
        await say({ text: ':warning: Redis unavailable — governance sessions require Redis.', thread_ts: ts })
        return
      }
      try {
        const result = await client.sessions_resume(resolvedId)
        // Map the new thread (this message's ts) to the resumed session
        await setSessionThread(redis, ts, resolvedId)
        await say({
          text: [
            `:arrow_forward: *Session resumed* (\`${resolvedId.slice(0, 8)}\`)`,
            '',
            `*Board:* ${result.context_message}`,
          ].join('\n'),
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err, sessionId: resolvedId }, 'handleCommand: sessions_resume failed')
        await say({ text: formatError('Could not resume session', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !board status — list active/paused sessions
    // -------------------------------------------------------------------------
    case 'status': {
      try {
        // Fetch both active and paused sessions
        const [active, paused] = await Promise.all([
          client.sessions_list('active', 10),
          client.sessions_list('paused', 10),
        ])
        const combined = [...active.items, ...paused.items]
        await say({ text: formatSessionList(combined), thread_ts: ts })
      } catch (err) {
        logger.error({ err }, 'handleCommand: sessions_list failed')
        await say({ text: formatError('Could not retrieve sessions', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    default:
      await say({
        text: ':warning: Usage: `!board quick`, `!board quarterly`, `!board resume <id>`, `!board status`',
        thread_ts: ts,
      })
      break
  }
}

// =============================================================================
// Bet command handler
// =============================================================================

async function handleBetCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  subCmd: string,
  _subCmdRaw: string,
  args: string,
): Promise<void> {
  switch (subCmd) {
    // -------------------------------------------------------------------------
    // !bet list [status]
    // -------------------------------------------------------------------------
    case 'list': {
      const validStatuses = ['pending', 'correct', 'incorrect', 'ambiguous']
      const status = args.trim().split(/\s+/)[0] ?? ''
      const statusFilter = validStatuses.includes(status) ? status : undefined
      try {
        const result = await client.bets_list(statusFilter, 20)
        await say({ text: formatBetList(result.items, statusFilter), thread_ts: ts })
      } catch (err) {
        logger.error({ err }, 'handleCommand: bets_list failed')
        await say({ text: formatError('Could not list bets', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !bet add <confidence> <statement>
    // Example: !bet add 0.8 QSR deal closes by Q2
    // -------------------------------------------------------------------------
    case 'add': {
      const parts = args.trim().split(/\s+/)
      const confidenceRaw = parts[0] ?? ''
      const confidence = parseFloat(confidenceRaw)
      const statement = parts.slice(1).join(' ').trim()

      if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
        await say({
          text: ':warning: Usage: `!bet add <confidence 0.0-1.0> <statement>`\nExample: `!bet add 0.8 QSR deal closes by Q2 2026`',
          thread_ts: ts,
        })
        return
      }

      if (!statement) {
        await say({
          text: ':warning: A statement is required. Usage: `!bet add <confidence> <statement>`',
          thread_ts: ts,
        })
        return
      }

      try {
        const bet = await client.bets_create({ statement, confidence })
        await say({ text: formatBetCreate(bet), thread_ts: ts })
      } catch (err) {
        logger.error({ err, statement }, 'handleCommand: bets_create failed')
        await say({ text: formatError('Could not create bet', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !bet expiring [N]
    // -------------------------------------------------------------------------
    case 'expiring': {
      const daysRaw = args.trim().split(/\s+/)[0] ?? ''
      const days = daysRaw ? parseInt(daysRaw, 10) : 7
      const resolvedDays = Number.isNaN(days) || days < 1 ? 7 : days
      try {
        const result = await client.bets_expiring(resolvedDays)
        await say({ text: formatBetsExpiring(result.items, result.days_ahead), thread_ts: ts })
      } catch (err) {
        logger.error({ err, days: resolvedDays }, 'handleCommand: bets_expiring failed')
        await say({ text: formatError('Could not retrieve expiring bets', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !bet resolve <id> <outcome> [evidence...]
    // Example: !bet resolve abc12345 correct Revenue target confirmed in Q2 report
    // -------------------------------------------------------------------------
    case 'resolve': {
      const parts = args.trim().split(/\s+/)
      const betId = parts[0] ?? ''
      const outcome = (parts[1] ?? '').toLowerCase()
      const evidence = parts.slice(2).join(' ').trim()

      const validOutcomes = ['correct', 'incorrect', 'ambiguous']
      if (!betId) {
        await say({ text: ':warning: Usage: `!bet resolve <id> <correct|incorrect|ambiguous> [evidence]`', thread_ts: ts })
        return
      }
      if (!validOutcomes.includes(outcome)) {
        await say({
          text: `:warning: Invalid outcome \`${outcome}\`. Must be: correct, incorrect, or ambiguous`,
          thread_ts: ts,
        })
        return
      }

      try {
        const updated = await client.bets_resolve(betId, {
          resolution: outcome as 'correct' | 'incorrect' | 'ambiguous',
          evidence: evidence || undefined,
        })
        await say({ text: formatBetResolve(updated), thread_ts: ts })
      } catch (err) {
        logger.error({ err, betId, outcome }, 'handleCommand: bets_resolve failed')
        await say({ text: formatError('Could not resolve bet', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    default:
      await say({
        text: ':warning: Unknown bet subcommand. Use: `!bet list`, `!bet add`, `!bet expiring`, `!bet resolve`',
        thread_ts: ts,
      })
      break
  }
}

// =============================================================================
// Trigger command handler
// =============================================================================

async function handleTriggerCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  subCmd: string,
  args: string,
): Promise<void> {
  switch (subCmd) {
    case 'add': {
      // !trigger add "QSR timeline" — args contains everything after "add"
      const queryText = extractQuotedArg('', args).trim()
      if (!queryText) {
        await say({ text: ':warning: Usage: `!trigger add "trigger text"`', thread_ts: ts })
        return
      }
      try {
        const trigger = await client.triggers_create({ name: queryText, query_text: queryText })
        await say({
          text: `Trigger created: *${trigger.name}*\nThreshold: ${trigger.threshold}  |  Cooldown: ${trigger.cooldown_minutes}min`,
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err, queryText }, 'handleCommand: triggers_create failed')
        await say({ text: formatError('Could not create trigger', err), thread_ts: ts })
      }
      break
    }

    case 'list': {
      try {
        const result = await client.triggers_list()
        await say({ text: formatTriggerList(result.triggers), thread_ts: ts })
      } catch (err) {
        logger.error({ err }, 'handleCommand: triggers_list failed')
        await say({ text: formatError('Could not list triggers', err), thread_ts: ts })
      }
      break
    }

    case 'delete': {
      // !trigger delete <name or id>
      const nameOrId = args.trim() || ''
      if (!nameOrId) {
        await say({ text: ':warning: Usage: `!trigger delete <name>`', thread_ts: ts })
        return
      }
      try {
        await client.triggers_delete(nameOrId)
        await say({ text: `Trigger *${nameOrId}* deactivated.`, thread_ts: ts })
      } catch (err) {
        logger.error({ err, nameOrId }, 'handleCommand: triggers_delete failed')
        await say({ text: formatError('Could not delete trigger', err), thread_ts: ts })
      }
      break
    }

    case 'test': {
      const queryText = extractQuotedArg('', args).trim()
      if (!queryText) {
        await say({ text: ':warning: Usage: `!trigger test "query text"`', thread_ts: ts })
        return
      }
      try {
        const result = await client.triggers_test({ query_text: queryText, limit: 5 })
        await say({ text: formatTriggerTestResults(queryText, result.matches), thread_ts: ts })
      } catch (err) {
        logger.error({ err, queryText }, 'handleCommand: triggers_test failed')
        await say({ text: formatError('Trigger test failed', err), thread_ts: ts })
      }
      break
    }

    default:
      await say({
        text: ':warning: Unknown trigger subcommand. Use: `!trigger add`, `!trigger list`, `!trigger delete`, `!trigger test`',
        thread_ts: ts,
      })
      break
  }
}
