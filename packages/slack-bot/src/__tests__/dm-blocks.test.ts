import { describe, it, expect } from 'vitest'
import {
  buildDraftDMBlocks,
  buildActionConfirmationBlocks,
  encodeActionMetadata,
  decodeActionMetadata,
  type DraftDMContext,
  type ActionMetadata,
} from '../services/dm-blocks.js'

const baseContext: DraftDMContext = {
  channel: 'C_TEST',
  threadTs: '1234.5678',
  userId: 'U_ASKER',
  draft: 'Based on captured context, the deploy uses Docker Compose.',
  summary: 'The deploy uses Docker Compose.',
  confidence: 0.82,
  sourceCount: 3,
  originalText: 'What is the deploy process?',
}

describe('buildDraftDMBlocks', () => {
  it('returns an array of blocks with header, question, draft, context, and actions', () => {
    const blocks = buildDraftDMBlocks(baseContext)

    // Should have at least: header, section (question), divider, section (draft), context, divider, actions
    expect(blocks.length).toBeGreaterThanOrEqual(7)

    // First block is header
    expect(blocks[0]).toMatchObject({ type: 'header' })

    // Actions block has 3 buttons
    const actionsBlock = blocks.find(b => 'block_id' in b && b.block_id === 'auto_response_actions')
    expect(actionsBlock).toBeDefined()
    const elements = (actionsBlock as { elements: unknown[] }).elements
    expect(elements).toHaveLength(3)
  })

  it('includes confidence percentage in header', () => {
    const blocks = buildDraftDMBlocks(baseContext)
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('82%')
  })

  it('includes original message link in question section', () => {
    const blocks = buildDraftDMBlocks(baseContext)
    const questionSection = blocks[1] as { accessory?: { url?: string } }
    expect(questionSection.accessory?.url).toBe('https://slack.com/archives/C_TEST/p12345678')
  })

  it('includes question text', () => {
    const blocks = buildDraftDMBlocks(baseContext)
    const questionSection = blocks[1] as { text: { text: string } }
    expect(questionSection.text.text).toContain('What is the deploy process?')
  })

  it('truncates long question text at 200 chars', () => {
    const longQuestion = 'A'.repeat(250)
    const ctx = { ...baseContext, originalText: longQuestion }
    const blocks = buildDraftDMBlocks(ctx)
    const questionSection = blocks[1] as { text: { text: string } }
    expect(questionSection.text.text).toContain('...')
    // Should not contain the full 250-char string
    expect(questionSection.text.text).not.toContain(longQuestion)
  })

  it('includes three action buttons with correct action_ids', () => {
    const blocks = buildDraftDMBlocks(baseContext)
    const actionsBlock = blocks.find(b => 'block_id' in b && b.block_id === 'auto_response_actions') as {
      elements: Array<{ action_id: string }>
    }
    const actionIds = actionsBlock.elements.map(e => e.action_id)
    expect(actionIds).toEqual(['post_reply', 'edit_post', 'dismiss'])
  })

  it('encodes action metadata in button values', () => {
    const blocks = buildDraftDMBlocks(baseContext)
    const actionsBlock = blocks.find(b => 'block_id' in b && b.block_id === 'auto_response_actions') as {
      elements: Array<{ value: string }>
    }

    // All three buttons should have valid JSON values
    for (const element of actionsBlock.elements) {
      const parsed = JSON.parse(element.value)
      expect(parsed.channel).toBe('C_TEST')
      expect(parsed.thread_ts).toBe('1234.5678')
      expect(parsed.user).toBe('U_ASKER')
      expect(parsed.draft).toBeDefined()
    }
  })

  it('sets primary style on Post Reply and danger style on Dismiss', () => {
    const blocks = buildDraftDMBlocks(baseContext)
    const actionsBlock = blocks.find(b => 'block_id' in b && b.block_id === 'auto_response_actions') as {
      elements: Array<{ action_id: string; style?: string }>
    }

    const postBtn = actionsBlock.elements.find(e => e.action_id === 'post_reply')
    expect(postBtn?.style).toBe('primary')

    const editBtn = actionsBlock.elements.find(e => e.action_id === 'edit_post')
    expect(editBtn?.style).toBeUndefined()

    const dismissBtn = actionsBlock.elements.find(e => e.action_id === 'dismiss')
    expect(dismissBtn?.style).toBe('danger')
  })
})

describe('buildActionConfirmationBlocks', () => {
  it('removes the actions block and adds a status context', () => {
    const original = buildDraftDMBlocks(baseContext)
    const updated = buildActionConfirmationBlocks(original, 'Posted')

    // No actions block
    const actionsBlock = updated.find(b => 'block_id' in b && b.block_id === 'auto_response_actions')
    expect(actionsBlock).toBeUndefined()

    // Has a context block with status
    const lastBlock = updated[updated.length - 1] as { type: string; elements?: Array<{ text: string }> }
    expect(lastBlock.type).toBe('context')
    expect(lastBlock.elements?.[0]?.text).toContain('Posted')
  })

  it('preserves other blocks', () => {
    const original = buildDraftDMBlocks(baseContext)
    const originalNonAction = original.filter(
      b => !('block_id' in b && b.block_id === 'auto_response_actions')
    ).length

    const updated = buildActionConfirmationBlocks(original, 'Dismissed')
    // Should have all original blocks minus actions, plus one new status block
    expect(updated.length).toBe(originalNonAction + 1)
  })

  it('displays correct status for each action type', () => {
    const original = buildDraftDMBlocks(baseContext)

    for (const status of ['Posted', 'Dismissed', 'Edited & Posted'] as const) {
      const updated = buildActionConfirmationBlocks(original, status)
      const lastBlock = updated[updated.length - 1] as { elements?: Array<{ text: string }> }
      expect(lastBlock.elements?.[0]?.text).toContain(status)
    }
  })
})

describe('encodeActionMetadata / decodeActionMetadata', () => {
  const meta: ActionMetadata = {
    channel: 'C_TEST',
    thread_ts: '1234.5678',
    user: 'U_ASKER',
    draft: 'Some draft text',
  }

  it('round-trips correctly', () => {
    const encoded = encodeActionMetadata(meta)
    const decoded = decodeActionMetadata(encoded)
    expect(decoded).toEqual(meta)
  })

  it('truncates very long drafts', () => {
    const longMeta = { ...meta, draft: 'X'.repeat(2000) }
    const encoded = encodeActionMetadata(longMeta)
    expect(encoded.length).toBeLessThan(2000)

    const decoded = decodeActionMetadata(encoded)
    expect(decoded?.draft).toContain('[Draft truncated')
  })

  it('returns null for invalid JSON', () => {
    expect(decodeActionMetadata('not json')).toBeNull()
  })

  it('returns null for JSON missing required fields', () => {
    expect(decodeActionMetadata('{"foo": "bar"}')).toBeNull()
  })
})
