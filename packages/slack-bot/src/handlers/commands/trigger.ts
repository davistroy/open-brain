import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatTriggerList, formatTriggerTestResults, formatError } from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

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

export async function handleTriggerCommand(
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
