import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerActionHandlers, EDIT_POST_MODAL_CALLBACK, DRAFT_INPUT_BLOCK_ID, DRAFT_INPUT_ACTION_ID } from '../handlers/action-handlers.js'
import { encodeActionMetadata, type ActionMetadata } from '../services/dm-blocks.js'

/** Helper to create a mock Bolt app that captures registered handlers */
function createMockApp() {
  const actionHandlers = new Map<string, Function>()
  const viewHandlers = new Map<string, Function>()

  return {
    app: {
      action: vi.fn((actionId: string, handler: Function) => {
        actionHandlers.set(actionId, handler)
      }),
      view: vi.fn((callbackId: string, handler: Function) => {
        viewHandlers.set(callbackId, handler)
      }),
    } as any,
    actionHandlers,
    viewHandlers,
  }
}

const baseMeta: ActionMetadata = {
  channel: 'C_ORIGINAL',
  thread_ts: '1111.2222',
  user: 'U_ASKER',
  draft: 'Based on captured context, here is the answer.',
}

describe('registerActionHandlers', () => {
  it('registers post_reply, edit_post, dismiss, and view_original_message actions', () => {
    const { app, actionHandlers } = createMockApp()
    registerActionHandlers(app)

    expect(actionHandlers.has('post_reply')).toBe(true)
    expect(actionHandlers.has('edit_post')).toBe(true)
    expect(actionHandlers.has('dismiss')).toBe(true)
    expect(actionHandlers.has('view_original_message')).toBe(true)
  })

  it('registers view handler for edit modal submission', () => {
    const { app, viewHandlers } = createMockApp()
    registerActionHandlers(app)

    expect(viewHandlers.has(EDIT_POST_MODAL_CALLBACK)).toBe(true)
  })
})

describe('post_reply action', () => {
  let handler: Function
  let mockClient: ReturnType<typeof createMockClient>

  function createMockClient() {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      views: { open: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    }
  }

  beforeEach(() => {
    const { app, actionHandlers } = createMockApp()
    registerActionHandlers(app)
    handler = actionHandlers.get('post_reply')!
    mockClient = createMockClient()
  })

  it('posts draft as threaded reply in original channel', async () => {
    const metaValue = encodeActionMetadata(baseMeta)

    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: 'D_DM' },
        message: { ts: '9999.0000', blocks: [] },
      },
      client: mockClient,
      action: { value: metaValue },
    })

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_ORIGINAL',
        thread_ts: '1111.2222',
        text: baseMeta.draft,
      }),
    )
  })

  it('updates DM message to show Posted status', async () => {
    const metaValue = encodeActionMetadata(baseMeta)

    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: 'D_DM' },
        message: { ts: '9999.0000', blocks: [] },
      },
      client: mockClient,
      action: { value: metaValue },
    })

    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D_DM',
        ts: '9999.0000',
        text: 'Auto-response draft -- Posted',
      }),
    )
  })

  it('does not crash with invalid action metadata', async () => {
    await handler({
      ack: vi.fn(),
      body: {},
      client: mockClient,
      action: { value: 'not-json' },
    })

    expect(mockClient.chat.postMessage).not.toHaveBeenCalled()
  })
})

describe('edit_post action', () => {
  let handler: Function
  let mockClient: ReturnType<typeof createMockClient>

  function createMockClient() {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      views: { open: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    }
  }

  beforeEach(() => {
    const { app, actionHandlers } = createMockApp()
    registerActionHandlers(app)
    handler = actionHandlers.get('edit_post')!
    mockClient = createMockClient()
  })

  it('opens a modal with the draft text pre-filled', async () => {
    const metaValue = encodeActionMetadata(baseMeta)

    await handler({
      ack: vi.fn(),
      body: {
        trigger_id: 'T_TRIGGER',
        channel: { id: 'D_DM' },
        message: { ts: '9999.0000' },
      },
      client: mockClient,
      action: { value: metaValue },
    })

    expect(mockClient.views.open).toHaveBeenCalledTimes(1)
    const viewCall = mockClient.views.open.mock.calls[0][0]
    expect(viewCall.trigger_id).toBe('T_TRIGGER')
    expect(viewCall.view.callback_id).toBe(EDIT_POST_MODAL_CALLBACK)

    // Modal should contain the draft text as initial value
    const inputBlock = viewCall.view.blocks.find(
      (b: { block_id?: string }) => b.block_id === DRAFT_INPUT_BLOCK_ID,
    )
    expect(inputBlock).toBeDefined()
    expect(inputBlock.element.initial_value).toBe(baseMeta.draft)
  })

  it('stores DM channel and ts in private_metadata', async () => {
    const metaValue = encodeActionMetadata(baseMeta)

    await handler({
      ack: vi.fn(),
      body: {
        trigger_id: 'T_TRIGGER',
        channel: { id: 'D_DM_CHANNEL' },
        message: { ts: '8888.0000' },
      },
      client: mockClient,
      action: { value: metaValue },
    })

    const viewCall = mockClient.views.open.mock.calls[0][0]
    const privateMeta = JSON.parse(viewCall.view.private_metadata)
    expect(privateMeta.dm_channel).toBe('D_DM_CHANNEL')
    expect(privateMeta.dm_ts).toBe('8888.0000')
    expect(privateMeta.channel).toBe('C_ORIGINAL')
    expect(privateMeta.thread_ts).toBe('1111.2222')
  })
})

describe('dismiss action', () => {
  let handler: Function
  let mockClient: ReturnType<typeof createMockClient>

  function createMockClient() {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      views: { open: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    }
  }

  beforeEach(() => {
    const { app, actionHandlers } = createMockApp()
    registerActionHandlers(app)
    handler = actionHandlers.get('dismiss')!
    mockClient = createMockClient()
  })

  it('updates DM message to show Dismissed status', async () => {
    const metaValue = encodeActionMetadata(baseMeta)

    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: 'D_DM' },
        message: { ts: '9999.0000', blocks: [] },
      },
      client: mockClient,
      action: { value: metaValue },
    })

    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D_DM',
        ts: '9999.0000',
        text: 'Auto-response draft -- Dismissed',
      }),
    )
  })

  it('does not post any reply to the original channel', async () => {
    const metaValue = encodeActionMetadata(baseMeta)

    await handler({
      ack: vi.fn(),
      body: {
        channel: { id: 'D_DM' },
        message: { ts: '9999.0000', blocks: [] },
      },
      client: mockClient,
      action: { value: metaValue },
    })

    expect(mockClient.chat.postMessage).not.toHaveBeenCalled()
  })
})

describe('edit modal view submission', () => {
  let viewHandler: Function
  let mockClient: ReturnType<typeof createMockClient>

  function createMockClient() {
    return {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      views: { open: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [{ blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Test' } }] }],
        }),
      },
    }
  }

  beforeEach(() => {
    const { app, viewHandlers } = createMockApp()
    registerActionHandlers(app)
    viewHandler = viewHandlers.get(EDIT_POST_MODAL_CALLBACK)!
    mockClient = createMockClient()
  })

  it('posts edited draft as threaded reply', async () => {
    const privateMeta = JSON.stringify({
      channel: 'C_ORIGINAL',
      thread_ts: '1111.2222',
      user: 'U_ASKER',
      dm_channel: 'D_DM',
      dm_ts: '9999.0000',
    })

    await viewHandler({
      ack: vi.fn(),
      view: {
        private_metadata: privateMeta,
        state: {
          values: {
            [DRAFT_INPUT_BLOCK_ID]: {
              [DRAFT_INPUT_ACTION_ID]: { value: 'My edited response text' },
            },
          },
        },
      },
      client: mockClient,
    })

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_ORIGINAL',
        thread_ts: '1111.2222',
        text: 'My edited response text',
      }),
    )
  })

  it('updates DM message to show Edited & Posted status', async () => {
    const privateMeta = JSON.stringify({
      channel: 'C_ORIGINAL',
      thread_ts: '1111.2222',
      user: 'U_ASKER',
      dm_channel: 'D_DM',
      dm_ts: '9999.0000',
    })

    await viewHandler({
      ack: vi.fn(),
      view: {
        private_metadata: privateMeta,
        state: {
          values: {
            [DRAFT_INPUT_BLOCK_ID]: {
              [DRAFT_INPUT_ACTION_ID]: { value: 'Edited text' },
            },
          },
        },
      },
      client: mockClient,
    })

    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D_DM',
        ts: '9999.0000',
        text: 'Auto-response draft -- Edited & Posted',
      }),
    )
  })

  it('does not crash when dm_channel or dm_ts are missing', async () => {
    const privateMeta = JSON.stringify({
      channel: 'C_ORIGINAL',
      thread_ts: '1111.2222',
      user: 'U_ASKER',
      // no dm_channel or dm_ts
    })

    await viewHandler({
      ack: vi.fn(),
      view: {
        private_metadata: privateMeta,
        state: {
          values: {
            [DRAFT_INPUT_BLOCK_ID]: {
              [DRAFT_INPUT_ACTION_ID]: { value: 'Edited text' },
            },
          },
        },
      },
      client: mockClient,
    })

    // Should still post the reply
    expect(mockClient.chat.postMessage).toHaveBeenCalled()
    // But should NOT try to update DM
    expect(mockClient.chat.update).not.toHaveBeenCalled()
  })
})

describe('view_original_message action', () => {
  it('just acknowledges (no-op for URL buttons)', async () => {
    const { app, actionHandlers } = createMockApp()
    registerActionHandlers(app)

    const handler = actionHandlers.get('view_original_message')!
    const ack = vi.fn()
    await handler({ ack })
    expect(ack).toHaveBeenCalledTimes(1)
  })
})
