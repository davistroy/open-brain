import { describe, it, expect } from 'vitest'
import { renderBriefHtml, mapCaptureSourceToBriefType, extractToc } from '../brief-renderer.js'

// ---------------------------------------------------------------------------
// renderBriefHtml — basic cases
// ---------------------------------------------------------------------------

describe('renderBriefHtml', () => {
  it('returns empty html and empty toc for empty string', () => {
    const { html, toc } = renderBriefHtml('')
    expect(html).toBe('')
    expect(toc).toEqual([])
  })

  it('returns empty html and empty toc for whitespace-only string', () => {
    const { html, toc } = renderBriefHtml('   \n\t  ')
    expect(html).toBe('')
    expect(toc).toEqual([])
  })

  it('renders plain paragraph markdown to html', () => {
    const { html, toc } = renderBriefHtml('Hello, world.')
    expect(html).toContain('<p>Hello, world.</p>')
    expect(toc).toEqual([])
  })

  it('renders headings-only markdown and populates toc', () => {
    const md = '# Section One\n\n## Subsection Two\n\n### Deep Three'
    const { html, toc } = renderBriefHtml(md)

    expect(html).toContain('<h1')
    expect(html).toContain('<h2')
    expect(html).toContain('<h3')
    expect(toc).toHaveLength(3)

    expect(toc[0].level).toBe(1)
    expect(toc[0].text).toBe('Section One')
    expect(typeof toc[0].id).toBe('string')
    expect(toc[0].id.length).toBeGreaterThan(0)

    expect(toc[1].level).toBe(2)
    expect(toc[1].text).toBe('Subsection Two')

    expect(toc[2].level).toBe(3)
    expect(toc[2].text).toBe('Deep Three')
  })

  it('assigns slugified ids to headings via rehype-slug', () => {
    const md = '## My Heading With Spaces'
    const { toc } = renderBriefHtml(md)
    expect(toc).toHaveLength(1)
    // rehype-slug lowercases and replaces spaces with hyphens
    expect(toc[0].id).toBe('my-heading-with-spaces')
  })

  it('renders mixed content (headings + paragraphs + lists)', () => {
    const md = `# Daily Brief

A summary paragraph.

## Highlights

- Item one
- Item two

## Decisions

A decision block.
`
    const { html, toc } = renderBriefHtml(md)

    expect(html).toContain('<h1')
    expect(html).toContain('<h2')
    expect(html).toContain('<p>A summary paragraph.</p>')
    expect(html).toContain('<li>Item one</li>')
    expect(toc).toHaveLength(3)
    expect(toc.map(t => t.text)).toEqual(['Daily Brief', 'Highlights', 'Decisions'])
  })

  it('strips script tags — HTML injection is sanitized', () => {
    const md = 'Normal text\n\n<script>alert("xss")</script>'
    const { html } = renderBriefHtml(md)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(')
    expect(html).toContain('Normal text')
  })

  it('strips onclick event handler attributes from inline html', () => {
    // remark-rehype with allowDangerousHtml: false strips raw HTML blocks entirely.
    // xss is the second layer that would strip event handlers if raw HTML were passed.
    // Test that the output contains neither the event handler nor a live script vector.
    const md = '<a href="https://example.com" onclick="evil()">click me</a>'
    const { html } = renderBriefHtml(md)
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('evil()')
  })

  it('strips javascript: URI schemes', () => {
    const md = '[click](javascript:alert(1))'
    const { html } = renderBriefHtml(md)
    expect(html).not.toContain('javascript:')
  })

  it('renders special characters and unicode correctly', () => {
    const md = '## Résumé & Notes — 2026\n\nContent with "smart quotes" and em—dashes.'
    const { html, toc } = renderBriefHtml(md)
    expect(html).toContain('Résumé')
    expect(html).toContain('em—dashes')
    expect(toc).toHaveLength(1)
    expect(toc[0].text).toContain('Résumé')
  })

  it('only includes h1–h3 in toc, not h4+', () => {
    const md = '# H1\n\n## H2\n\n### H3\n\n#### H4 Should Be Excluded\n\n##### H5 Too'
    const { toc } = renderBriefHtml(md)
    expect(toc).toHaveLength(3)
    expect(toc.map(t => t.level)).toEqual([1, 2, 3])
    expect(toc.map(t => t.text)).toEqual(['H1', 'H2', 'H3'])
  })

  it('handles markdown bold, italic, code inline', () => {
    const md = 'Text with **bold**, *italic*, and `inline code`.'
    const { html } = renderBriefHtml(md)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<code>inline code</code>')
  })

  it('toc text is plain text with no HTML tags', () => {
    const md = '## **Bold Heading** and `code`'
    const { toc } = renderBriefHtml(md)
    // extractText should strip all tags
    expect(toc).toHaveLength(1)
    expect(toc[0].text).not.toContain('<')
    expect(toc[0].text).not.toContain('>')
    expect(toc[0].text).toContain('Bold Heading')
  })

  it('returns valid html structure — no dangling open tags', () => {
    const md = '## Section\n\nSome content.\n\n- list item\n\n> blockquote'
    const { html } = renderBriefHtml(md)
    // Simple balanced check: count open tags ≥ close tags for major elements
    const openH2 = (html.match(/<h2/g) ?? []).length
    const closeH2 = (html.match(/<\/h2>/g) ?? []).length
    expect(openH2).toBeGreaterThan(0)
    expect(openH2).toBe(closeH2)
  })
})

// ---------------------------------------------------------------------------
// extractToc — unit test the helper directly
// ---------------------------------------------------------------------------

describe('extractToc', () => {
  it('returns empty array for root with no heading children', () => {
    const root = { type: 'root' as const, children: [] }
    expect(extractToc(root)).toEqual([])
  })

  it('extracts items from a pre-built HAST structure', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'element',
          tagName: 'h1',
          properties: { id: 'top' },
          children: [{ type: 'text', value: 'Top Heading' }],
        },
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [{ type: 'text', value: 'Paragraph text.' }],
        },
        {
          type: 'element',
          tagName: 'h2',
          properties: { id: 'section-a' },
          children: [{ type: 'text', value: 'Section A' }],
        },
      ],
    }
    const toc = extractToc(root as Parameters<typeof extractToc>[0])
    expect(toc).toHaveLength(2)
    expect(toc[0]).toEqual({ id: 'top', text: 'Top Heading', level: 1 })
    expect(toc[1]).toEqual({ id: 'section-a', text: 'Section A', level: 2 })
  })

  it('skips headings without an id attribute', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'element',
          tagName: 'h2',
          properties: {},
          children: [{ type: 'text', value: 'No ID' }],
        },
        {
          type: 'element',
          tagName: 'h2',
          properties: { id: 'with-id' },
          children: [{ type: 'text', value: 'With ID' }],
        },
      ],
    }
    const toc = extractToc(root as Parameters<typeof extractToc>[0])
    expect(toc).toHaveLength(1)
    expect(toc[0].text).toBe('With ID')
  })
})

// ---------------------------------------------------------------------------
// mapCaptureSourceToBriefType — canonical mapping
// ---------------------------------------------------------------------------

describe('mapCaptureSourceToBriefType', () => {
  it('maps voice → VOICE', () => {
    expect(mapCaptureSourceToBriefType('voice')).toBe('VOICE')
  })

  it('maps email → EMAIL', () => {
    expect(mapCaptureSourceToBriefType('email')).toBe('EMAIL')
  })

  it('maps api → NOTE', () => {
    expect(mapCaptureSourceToBriefType('api')).toBe('NOTE')
  })

  it('maps mcp → NOTE', () => {
    expect(mapCaptureSourceToBriefType('mcp')).toBe('NOTE')
  })

  it('maps slack → NOTE', () => {
    expect(mapCaptureSourceToBriefType('slack')).toBe('NOTE')
  })

  it('maps document → NOTE', () => {
    expect(mapCaptureSourceToBriefType('document')).toBe('NOTE')
  })

  it('maps file → NOTE', () => {
    expect(mapCaptureSourceToBriefType('file')).toBe('NOTE')
  })

  it('maps consolidation → NOTE', () => {
    expect(mapCaptureSourceToBriefType('consolidation')).toBe('NOTE')
  })

  it('maps system → NOTE', () => {
    expect(mapCaptureSourceToBriefType('system')).toBe('NOTE')
  })
})
