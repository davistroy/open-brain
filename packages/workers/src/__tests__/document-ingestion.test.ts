import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isSupportedDocument, SUPPORTED_MIME_TYPES, SUPPORTED_EXTENSIONS } from '../ingestion/document-parser.js'

// ────────────────────────────────────────────────────────────────────────────
// isSupportedDocument — membership constants
// ────────────────────────────────────────────────────────────────────────────

describe('SUPPORTED_MIME_TYPES and SUPPORTED_EXTENSIONS constants', () => {
  it('includes application/pdf in supported MIME types', () => {
    expect(SUPPORTED_MIME_TYPES.has('application/pdf')).toBe(true)
  })

  it('includes docx MIME type in supported MIME types', () => {
    expect(
      SUPPORTED_MIME_TYPES.has(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true)
  })

  it('includes text/plain and text/markdown in supported MIME types', () => {
    expect(SUPPORTED_MIME_TYPES.has('text/plain')).toBe(true)
    expect(SUPPORTED_MIME_TYPES.has('text/markdown')).toBe(true)
  })

  it('includes .pdf, .docx, .txt, .md in supported extensions', () => {
    expect(SUPPORTED_EXTENSIONS.has('.pdf')).toBe(true)
    expect(SUPPORTED_EXTENSIONS.has('.docx')).toBe(true)
    expect(SUPPORTED_EXTENSIONS.has('.txt')).toBe(true)
    expect(SUPPORTED_EXTENSIONS.has('.md')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// isSupportedDocument — MIME-type matching
// ────────────────────────────────────────────────────────────────────────────

describe('isSupportedDocument — MIME type matching', () => {
  it('accepts PDF by MIME type regardless of file extension', () => {
    expect(isSupportedDocument('/tmp/file.xyz', 'application/pdf')).toBe(true)
  })

  it('accepts DOCX by MIME type regardless of file extension', () => {
    expect(
      isSupportedDocument(
        '/tmp/file.xyz',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true)
  })

  it('accepts legacy .doc MIME type (application/msword)', () => {
    expect(isSupportedDocument('/tmp/old.doc', 'application/msword')).toBe(true)
  })

  it('accepts text/plain MIME type', () => {
    expect(isSupportedDocument('/tmp/file.log', 'text/plain')).toBe(true)
  })

  it('accepts text/markdown MIME type', () => {
    expect(isSupportedDocument('/tmp/file.wiki', 'text/markdown')).toBe(true)
  })

  it('rejects image/jpeg MIME type', () => {
    expect(isSupportedDocument('/tmp/photo.jpg', 'image/jpeg')).toBe(false)
  })

  it('rejects video/mp4 MIME type', () => {
    expect(isSupportedDocument('/tmp/video.mp4', 'video/mp4')).toBe(false)
  })

  it('falls back to extension when MIME type is unrecognised (application/zip + .txt extension = supported)', () => {
    // application/zip is not in the supported MIME set, so the function falls
    // back to the file extension (.txt is supported).
    expect(isSupportedDocument('/tmp/archive.txt', 'application/zip')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// isSupportedDocument — extension fallback (no MIME type)
// ────────────────────────────────────────────────────────────────────────────

describe('isSupportedDocument — extension fallback', () => {
  it('accepts .pdf by extension when no MIME type given', () => {
    expect(isSupportedDocument('/docs/report.pdf')).toBe(true)
  })

  it('accepts .docx by extension', () => {
    expect(isSupportedDocument('/docs/letter.docx')).toBe(true)
  })

  it('accepts .doc by extension', () => {
    expect(isSupportedDocument('/docs/legacy.doc')).toBe(true)
  })

  it('accepts .txt by extension', () => {
    expect(isSupportedDocument('/notes/log.txt')).toBe(true)
  })

  it('accepts .md by extension', () => {
    expect(isSupportedDocument('/notes/readme.md')).toBe(true)
  })

  it('rejects .xlsx by extension', () => {
    expect(isSupportedDocument('/data/spreadsheet.xlsx')).toBe(false)
  })

  it('rejects .png by extension', () => {
    expect(isSupportedDocument('/images/photo.png')).toBe(false)
  })

  it('rejects .mp3 by extension', () => {
    expect(isSupportedDocument('/audio/recording.mp3')).toBe(false)
  })

  it('handles uppercase extensions case-insensitively', () => {
    expect(isSupportedDocument('/docs/REPORT.PDF')).toBe(true)
    expect(isSupportedDocument('/docs/Letter.DOCX')).toBe(true)
    expect(isSupportedDocument('/notes/README.MD')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// parseDocument — PDF (mocked pdf-parse)
// ────────────────────────────────────────────────────────────────────────────

describe('parseDocument — PDF', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('extracts text and page count from a valid PDF', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-pdf')),
    }))
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'Annual Report content here.',
        numpages: 5,
        info: {},
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/docs/annual-report.pdf', 'application/pdf')

    expect(result.text).toContain('Annual Report content here.')
    expect(result.pageCount).toBe(5)
  })

  it('infers PDF by file extension when no MIME type provided', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-pdf')),
    }))
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'PDF text extracted.',
        numpages: 2,
        info: {},
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/docs/report.pdf')

    expect(result.text).toContain('PDF text extracted.')
    expect(result.pageCount).toBe(2)
  })

  it('throws when PDF has no extractable text (image-only PDF)', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-scanned-pdf')),
    }))
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: '',
        numpages: 3,
        info: {},
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/docs/scanned.pdf')).rejects.toThrow(
      'PDF parsed but no text extracted',
    )
  })

  it('trims whitespace-only PDF text and throws', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-pdf')),
    }))
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: '   \n  ',
        numpages: 1,
        info: {},
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/docs/blank.pdf')).rejects.toThrow(
      'PDF parsed but no text extracted',
    )
  })
})

// ────────────────────────────────────────────────────────────────────────────
// parseDocument — DOCX (mocked mammoth)
// ────────────────────────────────────────────────────────────────────────────

describe('parseDocument — DOCX', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('extracts text from a valid DOCX file', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-docx')),
    }))
    vi.doMock('mammoth', () => ({
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Project proposal body text.',
        messages: [],
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument(
      '/docs/proposal.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )

    expect(result.text).toContain('Project proposal body text.')
    expect(result.pageCount).toBeUndefined()
  })

  it('infers DOCX by .docx extension when no MIME type', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-docx')),
    }))
    vi.doMock('mammoth', () => ({
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Extracted from docx extension.',
        messages: [],
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/docs/notes.docx')

    expect(result.text).toContain('Extracted from docx extension.')
  })

  it('accepts legacy .doc extension via application/msword MIME type', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-doc')),
    }))
    vi.doMock('mammoth', () => ({
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Legacy DOC text.',
        messages: [],
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/docs/old.doc', 'application/msword')

    expect(result.text).toContain('Legacy DOC text.')
  })

  it('throws when DOCX has no extractable text', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-docx')),
    }))
    vi.doMock('mammoth', () => ({
      extractRawText: vi.fn().mockResolvedValue({
        value: '',
        messages: [],
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/docs/empty.docx')).rejects.toThrow(
      'DOCX parsed but no text extracted',
    )
  })

  it('succeeds even when mammoth returns warnings in messages array', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from('fake-docx')),
    }))
    vi.doMock('mammoth', () => ({
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Content with warnings.',
        messages: [{ type: 'warning', message: 'Some unsupported feature' }],
      }),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/docs/complex.docx')

    expect(result.text).toContain('Content with warnings.')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// parseDocument — plain text and markdown (mocked fs)
// ────────────────────────────────────────────────────────────────────────────

describe('parseDocument — TXT and MD', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reads and returns text from a .txt file', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('Meeting notes content here.'),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/notes/meeting.txt', 'text/plain')

    expect(result.text).toBe('Meeting notes content here.')
    expect(result.pageCount).toBeUndefined()
  })

  it('reads and returns text from a .md file', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('# Title\n\nMarkdown body.'),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/notes/readme.md', 'text/markdown')

    expect(result.text).toContain('Markdown body.')
  })

  it('infers text format from .txt extension without MIME type', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('Plain text by extension.'),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/notes/log.txt')

    expect(result.text).toContain('Plain text by extension.')
  })

  it('infers markdown format from .md extension without MIME type', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('Markdown by extension.'),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/notes/guide.md')

    expect(result.text).toContain('Markdown by extension.')
  })

  it('trims leading/trailing whitespace from text file content', async () => {
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockResolvedValue('  \n  Trimmed content.\n  '),
    }))

    const { parseDocument } = await import('../ingestion/document-parser.js')
    const result = await parseDocument('/notes/padded.txt')

    expect(result.text).toBe('Trimmed content.')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// parseDocument — unsupported format
// ────────────────────────────────────────────────────────────────────────────

describe('parseDocument — unsupported format', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('throws for .xlsx extension', async () => {
    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/data/spreadsheet.xlsx')).rejects.toThrow(
      'Unsupported document format',
    )
  })

  it('throws for .csv extension', async () => {
    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/data/report.csv')).rejects.toThrow(
      'Unsupported document format',
    )
  })

  it('throws for .mp3 extension', async () => {
    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/audio/clip.mp3')).rejects.toThrow(
      'Unsupported document format',
    )
  })

  it('includes MIME type and extension in the error message', async () => {
    const { parseDocument } = await import('../ingestion/document-parser.js')

    await expect(parseDocument('/data/file.bin', 'application/octet-stream')).rejects.toThrow(
      'mimeType=application/octet-stream',
    )
  })
})
