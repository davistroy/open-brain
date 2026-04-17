import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileDropZone } from '../FileDropZone'

/**
 * React-dropzone intercepts DOM drag-and-drop events. The cleanest way to
 * exercise it in jsdom is to fire a `change` event on the hidden file input
 * rendered by `getInputProps()`. That drives the same `onDrop` handler that
 * real drop events would.
 */
function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
  if (!input) throw new Error('file input not found')
  return input
}

function uploadFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', {
    value: files,
    configurable: true,
  })
  fireEvent.change(input)
}

describe('FileDropZone', () => {
  it('renders idle state with the default label', () => {
    render(<FileDropZone onFiles={vi.fn()} />)

    expect(screen.getByText('Drop files here or click to browse')).toBeInTheDocument()
    expect(screen.getByText(/Accepts CSV, HTML, PDF/i)).toBeInTheDocument()
  })

  it('calls onFiles with a valid CSV file when accept permits it', async () => {
    const onFiles = vi.fn()
    const { container } = render(
      <FileDropZone
        onFiles={onFiles}
        accept={{ 'text/csv': ['.csv'] }}
      />,
    )

    const file = new File(['col1,col2\n1,2\n'], 'data.csv', { type: 'text/csv' })
    uploadFiles(getFileInput(container), [file])

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
    const passed = onFiles.mock.calls[0][0] as File[]
    expect(passed).toHaveLength(1)
    expect(passed[0].name).toBe('data.csv')
  })

  it('filters out a file larger than maxSizeBytes and shows a rejection', async () => {
    const onFiles = vi.fn()
    const { container } = render(
      <FileDropZone
        onFiles={onFiles}
        maxSizeBytes={10}
        accept={{ 'text/csv': ['.csv'] }}
      />,
    )

    const tooBig = new File([new Uint8Array(50)], 'big.csv', { type: 'text/csv' })
    const okay = new File([new Uint8Array(5)], 'small.csv', { type: 'text/csv' })
    uploadFiles(getFileInput(container), [tooBig, okay])

    await waitFor(() => expect(onFiles).toHaveBeenCalled())
    const passed = onFiles.mock.calls[0][0] as File[]
    expect(passed.map((f) => f.name)).toEqual(['small.csv'])

    // Rejection surfaced
    const rejections = await screen.findByTestId('file-drop-zone-rejections')
    expect(rejections).toHaveTextContent('big.csv')
    expect(rejections).toHaveTextContent(/exceeds/i)
  })

  it('does not call onFiles when disabled', async () => {
    const onFiles = vi.fn()
    const { container } = render(<FileDropZone onFiles={onFiles} disabled />)

    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    uploadFiles(getFileInput(container), [file])

    // Give react-dropzone a tick to (not) call onDrop.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onFiles).not.toHaveBeenCalled()
  })
})
