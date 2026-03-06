/**
 * Command handler — processes Slack messages with `!` prefix.
 * Dispatches to per-command-group handlers in ./commands/.
 *
 * For the full command reference see ./commands/help.ts (HELP_TEXT).
 */

import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import type { Redis } from 'ioredis'
import type { CoreApiClient } from '../lib/core-api-client.js'
import { logger } from '../lib/logger.js'
import {
  parseCommand,
  handleStats, handleRecent, handleRetry,
  handleBriefGenerate, handleBriefLast,
  handleEntities, handleEntityDetail, handleEntityMerge, handleEntitySplit,
  handleBoardCommand,
  handleBetCommand,
  handleTriggerCommand,
  handlePipelineStatus,
  handleHelp,
  HELP_TEXT,
} from './commands/index.js'

export { HELP_TEXT }

/**
 * Main command handler. Called by server.ts when IntentRouter returns intent = 'command'.
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
    case 'stats':
      await handleStats(ts, say, coreApiClient)
      break

    case 'brief':
      if (subCmd === 'last') {
        await handleBriefLast(ts, say, coreApiClient)
      } else {
        await handleBriefGenerate(ts, say, coreApiClient)
      }
      break

    case 'recent': {
      const n = subCmd ? parseInt(subCmd, 10) : 5
      const limit = isNaN(n) || n < 1 ? 5 : Math.min(n, 20)
      await handleRecent(ts, say, coreApiClient, limit)
      break
    }

    case 'entities':
      await handleEntities(ts, say, coreApiClient)
      break

    case 'entity': {
      if (subCmd === 'merge') {
        await handleEntityMerge(ts, say, coreApiClient, args)
      } else if (subCmd === 'split') {
        await handleEntitySplit(ts, say, coreApiClient, args)
      } else {
        const entityName = [subCmdRaw, args].filter(Boolean).join(' ').trim()
        if (!entityName) {
          await say({ text: ':warning: Usage: `!entity <name>` or `!entity merge <n1> <n2>` or `!entity split <name> <alias>`', thread_ts: ts })
        } else {
          await handleEntityDetail(ts, say, coreApiClient, entityName)
        }
      }
      break
    }

    case 'board':
      await handleBoardCommand(ts, say, coreApiClient, redis, subCmd, subCmdRaw, args)
      break

    case 'bet':
      await handleBetCommand(ts, say, coreApiClient, subCmd, subCmdRaw, args)
      break

    case 'pipeline':
      if (subCmd === 'status') {
        await handlePipelineStatus(ts, say, coreApiClient)
      } else {
        await say({ text: ':warning: Usage: `!pipeline status`', thread_ts: ts })
      }
      break

    case 'retry': {
      const captureId = subCmd
      if (!captureId) {
        await say({ text: ':warning: Usage: `!retry <capture_id>`', thread_ts: ts })
      } else {
        await handleRetry(ts, say, coreApiClient, captureId)
      }
      break
    }

    case 'trigger':
      await handleTriggerCommand(ts, say, coreApiClient, subCmd, args)
      break

    case 'help':
      await handleHelp(ts, say)
      break

    default:
      await say({
        text: `Unknown command \`!${cmd}\`. Type \`!help\` for available commands.`,
        thread_ts: ts,
      })
      break
  }
}
