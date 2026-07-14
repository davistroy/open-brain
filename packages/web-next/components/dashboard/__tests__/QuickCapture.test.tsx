/**
 * Component test — QuickCapture (dashboard quick-capture widget).
 *
 * Exercises the real component against MSW-mocked POST /api/v1/captures:
 *   - the Capture button is disabled until the textarea has content
 *   - submitting posts the capture, clears the textarea, and toasts success
 *   - a server error surfaces via toast.error and leaves the text intact
 *
 * next/navigation (useRouter) and sonner (toast) are mocked via vi.hoisted so
 * the assertions can observe the side effects without a live Next.js runtime.
 */

import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '../../../test/msw-server'
import { QuickCapture } from '../QuickCapture'

// ---------------------------------------------------------------------------
// Mocks — Next router + sonner toast (hoisted so the factories can close over
// them; vi.mock is hoisted above imports).
// ---------------------------------------------------------------------------

const { mockRefresh, mockPush, mockToast, mockToastError } = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() })
  return {
    mockRefresh: vi.fn(),
    mockPush: vi.fn(),
    mockToast: toast,
    mockToastError: toast.error,
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
}))

vi.mock('sonner', () => ({ toast: mockToast }))

// ---------------------------------------------------------------------------
// Render helper — wraps in a fresh TanStack QueryClient per test.
// ---------------------------------------------------------------------------

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  mockRefresh.mockClear()
  mockPush.mockClear()
  mockToast.mockClear()
  mockToastError.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('QuickCapture', () => {
  it('disables the Capture button until the textarea has content', () => {
    renderWithClient(<QuickCapture />)
    const button = screen.getByRole('button', { name: 'Capture' })
    expect(button).toBeDisabled()
  })

  it('posts the capture, clears the textarea, and toasts success', async () => {
    const user = userEvent.setup()

    let posted: { content?: string; source?: string } | null = null
    server.use(
      http.post('/api/v1/captures', async ({ request }) => {
        posted = (await request.json()) as { content?: string; source?: string }
        return HttpResponse.json(
          { id: 'cap-new-1', pipeline_status: 'pending', created_at: '2026-07-12T00:00:00.000Z' },
          { status: 201 },
        )
      }),
    )

    renderWithClient(<QuickCapture />)

    const textarea = screen.getByPlaceholderText("What's on your mind?")
    await user.type(textarea, 'Ship the full-stack e2e test')

    const button = screen.getByRole('button', { name: 'Capture' })
    expect(button).toBeEnabled()
    await user.click(button)

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Captured'))
    expect(posted).not.toBeNull()
    expect(posted!.content).toBe('Ship the full-stack e2e test')
    expect(posted!.source).toBe('api')
    // Textarea is cleared on success.
    expect((textarea as HTMLTextAreaElement).value).toBe('')
    // RSC refresh is triggered so StatStrip/RecentCaptures re-fetch.
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('surfaces a server error via toast.error and keeps the text', async () => {
    const user = userEvent.setup()

    server.use(
      http.post('/api/v1/captures', () =>
        HttpResponse.json({ error: 'boom', code: 'INTERNAL' }, { status: 500 }),
      ),
    )

    renderWithClient(<QuickCapture />)

    const textarea = screen.getByPlaceholderText("What's on your mind?")
    await user.type(textarea, 'This should fail')
    await user.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    // On error the text is preserved so the user can retry.
    expect((textarea as HTMLTextAreaElement).value).toBe('This should fail')
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})
