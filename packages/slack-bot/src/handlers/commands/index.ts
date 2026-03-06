/**
 * commands/index.ts — Unified dispatch map for all !command handlers.
 *
 * Each command group is implemented in its own file. This module
 * re-exports all handler functions and provides the shared parseCommand
 * utility used by the top-level command.ts dispatcher.
 */

export { handleStats, handleRecent, handleRetry } from './capture.js'
export { handleBriefGenerate, handleBriefLast } from './brief.js'
export { handleEntities, handleEntityDetail, handleEntityMerge, handleEntitySplit } from './entity.js'
export { handleBoardCommand } from './board.js'
export { handleBetCommand } from './bet.js'
export { handleTriggerCommand } from './trigger.js'
export { handlePipelineStatus } from './pipeline.js'
export { handleHelp, HELP_TEXT } from './help.js'

/**
 * Parse the raw `!command args` text.
 * Returns { cmd, subCmd, subCmdRaw, args } where:
 *   cmd       — first token after `!` (lowercased)
 *   subCmd    — second token (lowercased), for dispatch
 *   subCmdRaw — second token (original casing), for display/lookup
 *   args      — remaining tokens joined (original casing)
 */
export function parseCommand(text: string): { cmd: string; subCmd: string; subCmdRaw: string; args: string } {
  // Strip leading `!`
  const body = text.replace(/^!\s*/, '')
  const tokens = body.split(/\s+/)
  const cmd = (tokens[0] ?? '').toLowerCase()
  const subCmdRaw = tokens[1] ?? ''
  const subCmd = subCmdRaw.toLowerCase()
  const args = tokens.slice(2).join(' ')
  return { cmd, subCmd, subCmdRaw, args }
}
