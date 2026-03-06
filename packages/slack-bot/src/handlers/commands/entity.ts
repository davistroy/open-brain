import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import {
  formatEntityList,
  formatEntityDetail,
  formatEntityMerge,
  formatEntitySplit,
  formatError,
} from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

export async function handleEntities(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const result = await client.entities_list()
    await say({ text: formatEntityList(result.entities), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: entities_list failed')
    await say({ text: formatError('Could not retrieve entities', err), thread_ts: ts })
  }
}

export async function handleEntityDetail(ts: string, say: SayFn, client: CoreApiClient, name: string): Promise<void> {
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
export async function handleEntityMerge(ts: string, say: SayFn, client: CoreApiClient, args: string): Promise<void> {
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
export async function handleEntitySplit(ts: string, say: SayFn, client: CoreApiClient, args: string): Promise<void> {
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
