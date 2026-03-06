import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import {
  formatBetList,
  formatBetCreate,
  formatBetsExpiring,
  formatBetResolve,
  formatError,
} from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

export async function handleBetCommand(
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
