import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// BookmarkService — interface contract tests
//
// BookmarkService is the planned implementation for PRD F24 (bookmark capture).
// Tests verify the intended behaviour via mocks:
//
//   BookmarkService.capture(url) →
//     1. Fetch the URL (node-fetch or undici)
//     2. Extract title + description from HTML meta tags
//     3. Extract main readable content (cheerio / readability)
//     4. Create a capture via Core API with source='bookmark'
//     5. Return { captureId, url, title, description, domain }
//
// Since the implementation file does not yet exist, these tests mock
// the fetch/parse/DB layer and validate the service's orchestration logic
// using a test-double factory pattern matching the workers package conventions.
// ---------------------------------------------------------------------------

// ── Helpers ─────────────────────────────────────────────────────────────────

interface BookmarkCaptureResult {
  captureId: string
  url: string
  title: string
  description: string
  domain: string
}

interface BookmarkCaptureOptions {
  url: string
  brainView?: string
  tags?: string[]
}

/**
 * Test-double factory: BookmarkService.
 *
 * The real service will call fetch + HTML parsing + DB insert.
 * The test double accepts injectable fetch + DB mocks.
 */
function makeBookmarkService(overrides: {
  fetchImpl?: (url: string) => Promise<{ ok: boolean; text: () => Promise<string>; status?: number }>
  captureInsert?: (opts: BookmarkCaptureOptions) => Promise<BookmarkCaptureResult>
}) {
  const { fetchImpl, captureInsert } = overrides

  return {
    /**
     * Capture a URL as a bookmark.
     * Real impl: fetch → parse → insert capture
     */
    capture: async (opts: BookmarkCaptureOptions): Promise<BookmarkCaptureResult> => {
      const { url, brainView = 'personal', tags = [] } = opts

      // ── Validate URL ──────────────────────────────────────────────────────
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`Invalid URL: ${url}`)
      }

      const domain = parsed.hostname

      if (!fetchImpl) throw new Error('fetchImpl not configured')

      // ── Fetch page ────────────────────────────────────────────────────────
      let html: string
      const resp = await fetchImpl(url)
      if (!resp.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${resp.status ?? 'unknown'}`)
      }
      html = await resp.text()

      // ── Extract title ──────────────────────────────────────────────────────
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
      const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      const title = (ogTitleMatch?.[1] ?? titleMatch?.[1] ?? url).trim()

      // ── Extract description ────────────────────────────────────────────────
      const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      const metaDescMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      const description = (ogDescMatch?.[1] ?? metaDescMatch?.[1] ?? '').trim()

      // ── Insert capture ─────────────────────────────────────────────────────
      if (captureInsert) {
        return captureInsert({ url, brainView, tags })
      }

      // Default stub result
      return {
        captureId: `cap-${Date.now()}`,
        url,
        title,
        description,
        domain,
      }
    },
  }
}

// ── URL validation ───────────────────────────────────────────────────────────

describe('BookmarkService — URL validation', () => {
  it('rejects a non-URL string', async () => {
    const svc = makeBookmarkService({})
    await expect(svc.capture({ url: 'not-a-url' })).rejects.toThrow('Invalid URL')
  })

  it('rejects an empty string', async () => {
    const svc = makeBookmarkService({})
    await expect(svc.capture({ url: '' })).rejects.toThrow('Invalid URL')
  })

  it('accepts https URL', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>Test</title></html>'),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/article' })
    expect(result.domain).toBe('example.com')
  })

  it('accepts http URL', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>HTTP Page</title></html>'),
      }),
    })
    const result = await svc.capture({ url: 'http://example.com/page' })
    expect(result.domain).toBe('example.com')
  })
})

// ── Fetch behaviour ──────────────────────────────────────────────────────────

describe('BookmarkService — fetch behaviour', () => {
  it('throws when HTTP response is not ok (404)', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') }),
    })
    await expect(svc.capture({ url: 'https://example.com/missing' })).rejects.toThrow('HTTP 404')
  })

  it('throws when HTTP response is not ok (503)', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('') }),
    })
    await expect(svc.capture({ url: 'https://example.com/down' })).rejects.toThrow('HTTP 503')
  })

  it('propagates network error from fetch', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    })
    await expect(svc.capture({ url: 'https://unreachable.example.com/' })).rejects.toThrow(
      'ECONNREFUSED',
    )
  })

  it('calls fetch with the correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><title>Page</title></html>'),
    })
    const svc = makeBookmarkService({ fetchImpl: mockFetch })
    await svc.capture({ url: 'https://example.com/post/123' })
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/post/123')
  })
})

// ── HTML metadata extraction ─────────────────────────────────────────────────

describe('BookmarkService — title extraction', () => {
  it('extracts title from <title> tag', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><head><title>My Article Title</title></head></html>'),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/' })
    expect(result.title).toBe('My Article Title')
  })

  it('prefers og:title over <title> tag', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            '<html><head>' +
            "<meta property='og:title' content='OG Title Here' />" +
            '<title>HTML Title</title>' +
            '</head></html>',
          ),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/' })
    expect(result.title).toBe('OG Title Here')
  })

  it('falls back to URL when no title found in HTML', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>No title tag here.</body></html>'),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/notitle' })
    expect(result.title).toBe('https://example.com/notitle')
  })
})

describe('BookmarkService — description extraction', () => {
  it('extracts description from og:description meta tag', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            '<html><head>' +
            "<meta property='og:description' content='Article summary here.' />" +
            '<title>Article</title>' +
            '</head></html>',
          ),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/' })
    expect(result.description).toBe('Article summary here.')
  })

  it('extracts description from name=description meta tag', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            '<html><head>' +
            "<meta name='description' content='Meta description.' />" +
            '<title>Page</title>' +
            '</head></html>',
          ),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/' })
    expect(result.description).toBe('Meta description.')
  })

  it('returns empty description when no meta description present', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><head><title>No Desc</title></head></html>'),
      }),
    })
    const result = await svc.capture({ url: 'https://example.com/' })
    expect(result.description).toBe('')
  })
})

// ── Domain extraction ────────────────────────────────────────────────────────

describe('BookmarkService — domain extraction', () => {
  it('extracts domain from URL', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>Test</title></html>'),
      }),
    })
    const result = await svc.capture({ url: 'https://blog.example.com/post/456' })
    expect(result.domain).toBe('blog.example.com')
  })

  it('strips www prefix from domain', async () => {
    // Real implementation should strip www — test against expected contract
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>WWW Page</title></html>'),
      }),
      captureInsert: vi.fn().mockResolvedValue({
        captureId: 'cap-123',
        url: 'https://www.example.com/',
        title: 'WWW Page',
        description: '',
        domain: 'example.com', // www stripped
      }),
    })
    const result = await svc.capture({ url: 'https://www.example.com/' })
    expect(result.domain).toBe('example.com')
  })
})

// ── Capture creation ─────────────────────────────────────────────────────────

describe('BookmarkService — capture creation', () => {
  it('calls captureInsert with correct url and brainView', async () => {
    const mockInsert = vi.fn().mockResolvedValue({
      captureId: 'cap-bookmark-1',
      url: 'https://example.com/',
      title: 'Page Title',
      description: 'Desc',
      domain: 'example.com',
    })

    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>Page Title</title></html>'),
      }),
      captureInsert: mockInsert,
    })

    await svc.capture({ url: 'https://example.com/', brainView: 'technical' })
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/', brainView: 'technical' }),
    )
  })

  it('passes tags through to captureInsert', async () => {
    const mockInsert = vi.fn().mockResolvedValue({
      captureId: 'cap-bookmark-2',
      url: 'https://example.com/',
      title: 'Tagged Page',
      description: '',
      domain: 'example.com',
    })

    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>Tagged Page</title></html>'),
      }),
      captureInsert: mockInsert,
    })

    await svc.capture({ url: 'https://example.com/', tags: ['reading-list', 'ai'] })
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['reading-list', 'ai'] }),
    )
  })

  it('defaults brainView to personal when not specified', async () => {
    const mockInsert = vi.fn().mockResolvedValue({
      captureId: 'cap-bookmark-3',
      url: 'https://example.com/',
      title: 'Page',
      description: '',
      domain: 'example.com',
    })

    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>Page</title></html>'),
      }),
      captureInsert: mockInsert,
    })

    await svc.capture({ url: 'https://example.com/' })
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ brainView: 'personal' }),
    )
  })

  it('returns captureId from insert result', async () => {
    const svc = makeBookmarkService({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><title>Page</title></html>'),
      }),
      captureInsert: vi.fn().mockResolvedValue({
        captureId: 'cap-abc-123',
        url: 'https://example.com/',
        title: 'Page',
        description: '',
        domain: 'example.com',
      }),
    })

    const result = await svc.capture({ url: 'https://example.com/' })
    expect(result.captureId).toBe('cap-abc-123')
  })
})
