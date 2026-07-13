/**
 * Component test — SearchInput (debounced search box).
 *
 * Verifies the URL-driven search contract without a live Next.js router:
 *   - typing debounces then pushes `/search?q=<trimmed>`
 *   - the immediate submit path pushes without waiting for the debounce
 *   - the clear (X) button resets the value and pushes `/search`
 *
 * next/navigation (useRouter) is mocked via vi.hoisted so router.push is
 * observable. A short debounce keeps the debounce assertions fast + stable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchInput } from '../SearchInput'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

beforeEach(() => {
  mockPush.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('SearchInput', () => {
  it('debounces typing then pushes the trimmed query to /search', async () => {
    const user = userEvent.setup()
    render(<SearchInput debounceMs={20} />)

    const input = screen.getByRole('searchbox', { name: 'Search query' })
    await user.type(input, 'sailing')

    // The final debounced push carries the full query (intermediate pushes
    // may occur mid-typing; asserting the last call is race-proof).
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled()
      expect(mockPush).toHaveBeenLastCalledWith('/search?q=sailing')
    })
  })

  it('submits immediately on Enter without waiting for the debounce', async () => {
    const user = userEvent.setup()
    render(<SearchInput debounceMs={100_000} initialQuery="" />)

    const input = screen.getByRole('searchbox', { name: 'Search query' })
    await user.type(input, 'rrf{Enter}')

    // Enter fires synchronously; the 100s debounce would never fire in-test.
    await waitFor(() => expect(mockPush).toHaveBeenLastCalledWith('/search?q=rrf'))
  })

  it('clears the value and pushes /search when the clear button is clicked', async () => {
    const user = userEvent.setup()
    render(<SearchInput debounceMs={20} initialQuery="pgvector" />)

    const input = screen.getByRole('searchbox', { name: 'Search query' }) as HTMLInputElement
    expect(input.value).toBe('pgvector')

    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(input.value).toBe('')
    expect(mockPush).toHaveBeenLastCalledWith('/search')
  })
})
