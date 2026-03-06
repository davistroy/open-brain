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
 *   !board quick            — start quick board check (Phase 13 stub)
 *   !board quarterly        — start quarterly review (Phase 13 stub)
 *   !pipeline status        — pipeline health from Bull Board data
 *   !retry <capture_id>     — retry failed capture
 *   !trigger add "text"     — create semantic trigger
 *   !trigger list           — list all triggers
 *   !trigger delete <name>  — deactivate trigger
 *   !trigger test "text"    — test trigger against existing captures
 *   !help                   — list all commands
 */

import type { GenericMessageEvent, SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../lib/core-api-client.js'
import {
  formatStats,
  formatRecentCaptures,
  formatEntityList,
  formatEntityDetail,
  formatPipelineStatus,
  formatTriggerList,
  formatTriggerTestResults,
  formatError,
} from '../lib/formatters.js'
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
  \`!entities\`           — list all known entities
  \`!entity <name>\`      — entity detail + linked captures

*Semantic Triggers*
  \`!trigger add "text"\` — create a semantic trigger
  \`!trigger list\`       — list all triggers with status
  \`!trigger delete <n>\` — deactivate a trigger by name/id
  \`!trigger test "text"\`— test query against existing captures

*Pipeline*
  \`!pipeline status\`    — pipeline queue health

*Governance* (Phase 13)
  \`!board quick\`        — start quick board check
  \`!board quarterly\`    — start quarterly review

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
 */
export async function handleCommand(
  message: GenericMessageEvent,
  say: SayFn,
  coreApiClient: CoreApiClient,
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
      // name is subCmdRaw + args (everything after "entity", original casing)
      const entityName = [subCmdRaw, args].filter(Boolean).join(' ').trim()
      if (!entityName) {
        await say({ text: ':warning: Usage: `!entity <name>`', thread_ts: ts })
      } else {
        await handleEntityDetail(ts, say, coreApiClient, entityName)
      }
      break
    }

    // -------------------------------------------------------------------------
    case 'board':
      if (subCmd === 'quick' || subCmd === 'quarterly') {
        await say({
          text: `_Board ${subCmd} review is coming in Phase 13 (Governance Sessions)._`,
          thread_ts: ts,
        })
      } else {
        await say({
          text: ':warning: Usage: `!board quick` or `!board quarterly`',
          thread_ts: ts,
        })
      }
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
