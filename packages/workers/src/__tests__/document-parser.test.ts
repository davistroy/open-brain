import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DocumentParserService,
  detectFormat,
  type ParsedDocument,
  type SupportedFormat,
} from '../services/document-parser.js'

// ────────────────────────────────────────────────────────────────────────────
// detectFormat
// ────────────────────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects .pdf', () => {
    expect(detectFormat('/docs/report.pdf')).toBe('pdf')
  })

  it('detects .docx', () => {
    expect(detectFormat('/docs/letter.docx')).toBe('docx')
  })

  it('detects .md', () => {
    expect(detectFormat('/notes/README.md')).toBe('md')
  })

  it('detects .markdown', () => {
    expect(detectFormat('/notes/guide.markdown')).toBe('md')
  })

  it('detects .txt', () => {
    expect(detectFormat('/notes/log.txt')).toBe('txt')
  })

  it('detects .html', () => {
    expect(detectFormat('/export/page.html')).toBe('html')
  })

  it('detects .htm', () => {
    expect(detectFormat('/export/page.htm')).toBe('html')
  })

  it('is case-insensitive for extensions', () => {
    expect(detectFormat('/docs/REPORT.PDF')).toBe('pdf')
    expect(detectFormat('/docs/Letter.DOCX')).toBe('docx')
  })

  it('throws for unsupported extensions', () => {
    expect(() => detectFormat('/docs/spreadsheet.xlsx')).toThrow('Unsupported file extension')
    expect(() => detectFormat('/docs/image.png')).toThrow('Unsupported file extension')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Markdown parsing (synchronous parseContent)
// ────────────────────────────────────────────────────────────────────────────

describe('DocumentParserService — Markdown', () => {
  const parser = new DocumentParserService()

  it('extracts text and title from first H1', () => {
    const md = `# My Document\n\nSome content here.`
    const result = parser.parseContent(md, '/docs/my-document.md', 'md') as ParsedDocument

    expect(result.title).toBe('My Document')
    expect(result.text).toContain('Some content here.')
    expect(result.format).toBe('md')
  })

  it('infers title from filename when no H1 present', () => {
    const md = `## Section One\n\nBody text here.`
    const result = parser.parseContent(md, '/docs/my-document.md', 'md') as ParsedDocument

    expect(result.title).toBe('My Document')
  })

  it('parses sections from ATX headings', () => {
    const md = [
      '# Intro',
      '',
      'Introduction paragraph.',
      '',
      '## Background',
      '',
      'Background details.',
      '',
      '### Sub-section',
      '',
      'Sub content.',
    ].join('\n')

    const result = parser.parseContent(md, '/path/doc.md', 'md') as ParsedDocument

    expect(result.sections.length).toBeGreaterThanOrEqual(3)
    const intro = result.sections.find((s) => s.heading === 'Intro')
    expect(intro).toBeDefined()
    expect(intro?.level).toBe(1)

    const bg = result.sections.find((s) => s.heading === 'Background')
    expect(bg).toBeDefined()
    expect(bg?.level).toBe(2)
    expect(bg?.content).toContain('Background details.')
  })

  it('returns single section for headingless markdown', () => {
    const md = 'Just some plain text.\nNo headings at all.'
    const result = parser.parseContent(md, '/doc.md', 'md') as ParsedDocument

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].level).toBe(0)
  })

  it('computes word_count correctly', () => {
    const md = 'one two three four five'
    const result = parser.parseContent(md, '/doc.md', 'md') as ParsedDocument
    expect(result.metadata.word_count).toBe(5)
  })

  it('populates filename and filepath in metadata', () => {
    const md = 'Content.'
    const result = parser.parseContent(md, '/docs/report.md', 'md') as ParsedDocument
    expect(result.metadata.filename).toBe('report.md')
    expect(result.metadata.filepath).toBe('/docs/report.md')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Plain text parsing
// ────────────────────────────────────────────────────────────────────────────

describe('DocumentParserService — plain text', () => {
  const parser = new DocumentParserService()

  it('uses first line as title', () => {
    const txt = 'Meeting Notes\n\nWe discussed the roadmap.'
    const result = parser.parseContent(txt, '/notes/meeting.txt', 'txt') as ParsedDocument

    expect(result.title).toBe('Meeting Notes')
    expect(result.format).toBe('txt')
  })

  it('infers title from filename when file is empty', () => {
    const result = parser.parseContent('', '/notes/status-update.txt', 'txt') as ParsedDocument
    expect(result.title).toBe('Status Update')
  })

  it('returns single section with full text', () => {
    const txt = 'Line one.\nLine two.'
    const result = parser.parseContent(txt, '/notes/log.txt', 'txt') as ParsedDocument

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].content).toContain('Line one.')
  })

  it('computes word count correctly', () => {
    const txt = 'hello world foo bar'
    const result = parser.parseContent(txt, '/doc.txt', 'txt') as ParsedDocument
    expect(result.metadata.word_count).toBe(4)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HTML parsing
// ────────────────────────────────────────────────────────────────────────────

describe('DocumentParserService — HTML', () => {
  const parser = new DocumentParserService()

  it('extracts title from <title> tag', () => {
    const html = `<html><head><title>My Page</title></head><body><p>Content</p></body></html>`
    const result = parser.parseContent(html, '/export/page.html', 'html') as ParsedDocument

    expect(result.title).toBe('My Page')
    expect(result.format).toBe('html')
  })

  it('falls back to H1 when no <title> tag', () => {
    const html = `<body><h1>Article Title</h1><p>Paragraph.</p></body>`
    const result = parser.parseContent(html, '/export/article.html', 'html') as ParsedDocument

    expect(result.title).toBe('Article Title')
  })

  it('falls back to filename when no <title> or H1', () => {
    const html = `<body><p>Just a paragraph.</p></body>`
    const result = parser.parseContent(html, '/export/my-doc.html', 'html') as ParsedDocument

    expect(result.title).toBe('My Doc')
  })

  it('strips HTML tags from text output', () => {
    const html = `<body><h2>Section</h2><p>Hello <strong>world</strong>.</p></body>`
    const result = parser.parseContent(html, '/doc.html', 'html') as ParsedDocument

    expect(result.text).not.toContain('<')
    expect(result.text).toContain('Hello')
    expect(result.text).toContain('world')
  })

  it('strips <style> and <script> blocks from text', () => {
    const html = `<html><head><style>body { color: red; }</style><script>alert(1)</script></head><body><p>Real content.</p></body></html>`
    const result = parser.parseContent(html, '/doc.html', 'html') as ParsedDocument

    expect(result.text).not.toContain('color: red')
    expect(result.text).not.toContain('alert')
    expect(result.text).toContain('Real content.')
  })

  it('decodes common HTML entities', () => {
    const html = `<body><p>AT&amp;T &lt;rocks&gt; &quot;quotes&quot;</p></body>`
    const result = parser.parseContent(html, '/doc.html', 'html') as ParsedDocument

    expect(result.text).toContain('AT&T')
    expect(result.text).toContain('<rocks>')
    expect(result.text).toContain('"quotes"')
  })

  it('parses heading sections from H1-H6', () => {
    const html = [
      '<body>',
      '<h1>Title</h1><p>Intro.</p>',
      '<h2>Methods</h2><p>Methods body.</p>',
      '<h3>Sub</h3><p>Sub body.</p>',
      '</body>',
    ].join('')
    const result = parser.parseContent(html, '/doc.html', 'html') as ParsedDocument

    const methodsSection = result.sections.find((s) => s.heading === 'Methods')
    expect(methodsSection).toBeDefined()
    expect(methodsSection?.level).toBe(2)
    expect(methodsSection?.content).toContain('Methods body.')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// PDF parsing (mocked pdf-parse)
// ────────────────────────────────────────────────────────────────────────────

describe('DocumentParserService — PDF', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('extracts text, title, and author from PDF metadata', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'PDF body content here.',
        numpages: 3,
        info: {
          Title: 'Annual Report 2025',
          Author: 'Troy Davis',
          CreationDate: 'D:20250115120000Z',
        },
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(
      Buffer.from('fake-pdf'),
      '/docs/annual-report.pdf',
      'pdf',
    )

    expect(result.title).toBe('Annual Report 2025')
    expect(result.metadata.author).toBe('Troy Davis')
    expect(result.text).toContain('PDF body content here.')
    expect(result.format).toBe('pdf')
    expect(result.metadata.word_count).toBe(4)
    expect(result.metadata.filename).toBe('annual-report.pdf')
  })

  it('infers title from filename when PDF has no Title metadata', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'Some text.',
        numpages: 1,
        info: {},
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(
      Buffer.from('fake'),
      '/docs/my-report.pdf',
      'pdf',
    )

    expect(result.title).toBe('My Report')
  })

  it('parses PDF creation date from D: format', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'text',
        numpages: 1,
        info: { CreationDate: 'D:20240301000000Z' },
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('f'), '/doc.pdf', 'pdf')

    expect(result.metadata.created_date).toBeDefined()
    expect(result.metadata.created_date).toContain('2024-03-01')
  })

  it('handles missing/malformed PDF creation date gracefully', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'text',
        numpages: 1,
        info: { CreationDate: 'not-a-date' },
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('f'), '/doc.pdf', 'pdf')

    expect(result.metadata.created_date).toBeUndefined()
  })

  it('returns flat single section for PDF content', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text: 'Page one text.\nPage two text.',
        numpages: 2,
        info: {},
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('f'), '/doc.pdf', 'pdf')

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].level).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// DOCX parsing (mocked mammoth)
// ────────────────────────────────────────────────────────────────────────────

describe('DocumentParserService — DOCX', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('extracts title from first H1 in mammoth HTML output', async () => {
    vi.doMock('mammoth', () => ({
      default: undefined,
      convertToHtml: vi.fn().mockResolvedValue({
        value: '<h1>Project Proposal</h1><p>This is the proposal body.</p>',
        messages: [],
      }),
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Project Proposal\nThis is the proposal body.',
        messages: [],
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('fake-docx'), '/docs/proposal.docx', 'docx')

    expect(result.title).toBe('Project Proposal')
    expect(result.text).toContain('proposal body')
    expect(result.format).toBe('docx')
  })

  it('infers title from filename when docx has no H1', async () => {
    vi.doMock('mammoth', () => ({
      default: undefined,
      convertToHtml: vi.fn().mockResolvedValue({
        value: '<p>Just a paragraph.</p>',
        messages: [],
      }),
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Just a paragraph.',
        messages: [],
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('fake'), '/docs/my-notes.docx', 'docx')

    expect(result.title).toBe('My Notes')
  })

  it('extracts heading sections from mammoth HTML', async () => {
    const html = [
      '<h1>Executive Summary</h1><p>Summary text.</p>',
      '<h2>Background</h2><p>Background text.</p>',
      '<h2>Recommendations</h2><p>Recs text.</p>',
    ].join('')

    vi.doMock('mammoth', () => ({
      default: undefined,
      convertToHtml: vi.fn().mockResolvedValue({ value: html, messages: [] }),
      extractRawText: vi.fn().mockResolvedValue({
        value: 'Executive Summary\nSummary text.\nBackground\nBackground text.\nRecommendations\nRecs text.',
        messages: [],
      }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('fake'), '/docs/report.docx', 'docx')

    const bgSection = result.sections.find((s) => s.heading === 'Background')
    expect(bgSection).toBeDefined()
    expect(bgSection?.level).toBe(2)
    expect(bgSection?.content).toContain('Background text.')
  })

  it('computes word count from raw text', async () => {
    vi.doMock('mammoth', () => ({
      default: undefined,
      convertToHtml: vi.fn().mockResolvedValue({ value: '<p>five words in here</p>', messages: [] }),
      extractRawText: vi.fn().mockResolvedValue({ value: 'five words in here', messages: [] }),
    }))

    const { DocumentParserService: FreshParser } = await import('../services/document-parser.js')
    const parser = new FreshParser()
    const result = await parser.parseContent(Buffer.from('f'), '/doc.docx', 'docx')

    expect(result.metadata.word_count).toBe(4)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// detectFormat integration with parseContent
// ────────────────────────────────────────────────────────────────────────────

describe('DocumentParserService — format detection', () => {
  const parser = new DocumentParserService()

  it('produces correct format field for markdown', () => {
    const result = parser.parseContent('# Hello', '/x.md', 'md') as ParsedDocument
    expect(result.format).toBe('md')
  })

  it('produces correct format field for txt', () => {
    const result = parser.parseContent('Hello', '/x.txt', 'txt') as ParsedDocument
    expect(result.format).toBe('txt')
  })

  it('produces correct format field for html', () => {
    const result = parser.parseContent('<p>Hi</p>', '/x.html', 'html') as ParsedDocument
    expect(result.format).toBe('html')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Title inference from filename
// ────────────────────────────────────────────────────────────────────────────

describe('filename title inference', () => {
  const parser = new DocumentParserService()

  it('converts hyphens to spaces and title-cases', () => {
    const result = parser.parseContent('', '/some/my-great-doc.txt', 'txt') as ParsedDocument
    expect(result.title).toBe('My Great Doc')
  })

  it('converts underscores to spaces', () => {
    const result = parser.parseContent('', '/some/project_brief.txt', 'txt') as ParsedDocument
    expect(result.title).toBe('Project Brief')
  })

  it('handles mixed separators', () => {
    const result = parser.parseContent('', '/some/my_doc-v2.md', 'md') as ParsedDocument
    expect(result.title).toBe('My Doc V2')
  })
})
