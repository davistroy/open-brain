import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processDocumentPipelineJob, documentPipelineBackoffStrategy } from '../jobs/document-pipeline.js'
import { chunkDocument, MAX_CHUNK_TOKENS, CHUNK_OVERLAP_TOKENS } from '../ingestion/chunker.js'
import { isSupportedDocument } from '../ingestion/document-parser.js'
import type { DocumentParserService } from '../services/document-parser.js'
import { UnrecoverableError } from 'bullmq'

// ---------------------------------------------------------------------------
// Mock DocumentParserService helper
// processDocumentPipelineJob accepts an optional parserService parameter
// for dependency injection. Use this to avoid actual file system access.
// ---------------------------------------------------------------------------

function makeMockParser(textResult = 'Short document content.'): DocumentParserService {
  return {
    parseFile: vi.fn().mockResolvedValue({
      title: 'Test Document',
      text: textResult,
      format: 'pdf',
      sections: [{ heading: '', content: textResult, level: 0 }],
      metadata: {
        word_count: textResult.split(' ').length,
        filename: 'test.pdf',
        filepath: '/tmp/test.pdf',
      },
    }),
    parseContent: vi.fn(),
  } as unknown as DocumentParserService
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInsertChain(returnRows: unknown[] = [{ id: 'chunk-cap-1' }]) {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.onConflictDoNothing = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returnRows)
  return chain
}

function makeSelectChain(rows: unknown[]) {
  const terminal = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(terminal)
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

function makeMockDb(captureRow?: Record<string, unknown>) {
  const defaultCapture = {
    id: 'parent-cap-1',
    content: 'Document placeholder',
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'document',
    source_metadata: {
      file_path: '/tmp/test.pdf',
      original_filename: 'test.pdf',
      mime_type: 'application/pdf',
    },
    pipeline_status: 'pending',
    tags: [],
  }

  return {
    select: vi.fn().mockImplementation(() => makeSelectChain(captureRow ? [captureRow] : [defaultCapture])),
    insert: vi.fn().mockReturnValue(makeInsertChain()),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

function makeMockEmbeddingService(embedImpl?: () => Promise<number[]>) {
  return {
    embed: vi.fn().mockImplementation(embedImpl ?? (() => Promise.resolve(new Array(768).fill(0.1)))),
  }
}

function makeMockEmbedQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
  }
}

// ---------------------------------------------------------------------------
// documentPipelineBackoffStrategy
// ---------------------------------------------------------------------------

describe('documentPipelineBackoffStrategy', () => {
  it('returns 30s for first failure (attemptsMade=1)', () => {
    expect(documentPipelineBackoffStrategy(1)).toBe(30_000)
  })

  it('returns 2m for second failure (attemptsMade=2)', () => {
    expect(documentPipelineBackoffStrategy(2)).toBe(120_000)
  })

  it('returns 2h for fifth and beyond failures (attemptsMade=5+)', () => {
    expect(documentPipelineBackoffStrategy(5)).toBe(7_200_000)
    expect(documentPipelineBackoffStrategy(99)).toBe(7_200_000)
  })
})

// ---------------------------------------------------------------------------
// isSupportedDocument
// ---------------------------------------------------------------------------

describe('isSupportedDocument', () => {
  it('accepts PDF by MIME type', () => {
    expect(isSupportedDocument('/tmp/doc.pdf', 'application/pdf')).toBe(true)
  })

  it('accepts DOCX by MIME type', () => {
    expect(isSupportedDocument(
      '/tmp/doc.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )).toBe(true)
  })

  it('accepts PDF by extension when MIME type is absent', () => {
    expect(isSupportedDocument('/tmp/doc.pdf')).toBe(true)
  })

  it('accepts .txt by extension', () => {
    expect(isSupportedDocument('/tmp/notes.txt')).toBe(true)
  })

  it('rejects unsupported format', () => {
    expect(isSupportedDocument('/tmp/video.mp4', 'video/mp4')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// chunkDocument — unit tests
// ---------------------------------------------------------------------------

describe('chunkDocument — single chunk for small documents', () => {
  it('returns a single chunk when document fits within MAX_CHUNK_TOKENS', () => {
    const text = 'Hello world. This is a short document.'
    const chunks = chunkDocument(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].total).toBe(1)
    expect(chunks[0].text).toBe(text)
    expect(chunks[0].charStart).toBe(0)
    expect(chunks[0].charEnd).toBe(text.length)
  })

  it('returns empty-text chunk for single empty string', () => {
    const text = '   '
    const chunks = chunkDocument(text)
    expect(chunks).toHaveLength(1)
    // estimateTokens of whitespace ≈ 0 — stays as single chunk
  })
})

describe('chunkDocument — chunking large documents', () => {
  /**
   * Build a large text with N paragraphs of ~words words each.
   * Uses estimateTokens(text) ≈ chars*1.1/4 to target actual token counts.
   */
  function makeLargeText(targetTokens: number): string {
    // Each word ≈ 5 chars, each space 1 char → ~6 chars/word → ~1.65 tokens/word
    // target words ≈ targetTokens / 1.65
    const targetWords = Math.ceil(targetTokens / 1.65)
    const wordsPerPara = 80
    const paragraphs: string[] = []
    let words = 0
    while (words < targetWords) {
      const paraWords = Math.min(wordsPerPara, targetWords - words)
      const para = Array.from({ length: paraWords }, (_, i) =>
        `word${words + i}`,
      ).join(' ')
      paragraphs.push(para)
      words += paraWords
    }
    return paragraphs.join('\n\n')
  }

  it('produces multiple chunks when document exceeds MAX_CHUNK_TOKENS', () => {
    // Create a document that requires >1 chunk (3x the limit)
    const text = makeLargeText(MAX_CHUNK_TOKENS * 3)
    const chunks = chunkDocument(text)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('each chunk stays within MAX_CHUNK_TOKENS', () => {
    const text = makeLargeText(MAX_CHUNK_TOKENS * 2.5)
    const chunks = chunkDocument(text)
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(MAX_CHUNK_TOKENS)
    }
  })

  it('chunk indices are sequential and total is consistent', () => {
    const text = makeLargeText(MAX_CHUNK_TOKENS * 2)
    const chunks = chunkDocument(text)
    const total = chunks[0].total
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i)
      expect(chunk.total).toBe(total)
    })
  })

  it('consecutive chunks overlap (next chunk starts before previous ends)', () => {
    const text = makeLargeText(MAX_CHUNK_TOKENS * 3)
    const chunks = chunkDocument(text)
    if (chunks.length >= 2) {
      for (let i = 0; i < chunks.length - 1; i++) {
        // The start of chunk[i+1] should be before the end of chunk[i]
        expect(chunks[i + 1].charStart).toBeLessThan(chunks[i].charEnd)
      }
    }
  })

  it('charStart and charEnd cover valid ranges within original text', () => {
    const text = makeLargeText(MAX_CHUNK_TOKENS * 2)
    const chunks = chunkDocument(text)
    for (const chunk of chunks) {
      expect(chunk.charStart).toBeGreaterThanOrEqual(0)
      expect(chunk.charEnd).toBeLessThanOrEqual(text.length)
      expect(chunk.charStart).toBeLessThan(chunk.charEnd)
    }
  })
})

// ---------------------------------------------------------------------------
// processDocumentPipelineJob — happy path (single chunk)
// ---------------------------------------------------------------------------

describe('processDocumentPipelineJob — single-chunk document', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('parses document and creates sub-capture + enqueues embed', async () => {
    const db = makeMockDb()
    const embeddingService = makeMockEmbeddingService()
    const embedQueue = makeMockEmbedQueue()
    const parserService = makeMockParser('Short document content.')
    const data = { captureId: 'parent-cap-1' }

    await processDocumentPipelineJob(
      data,
      db as any,
      embeddingService as any,
      embedQueue as any,
      parserService,
    )

    // Parent capture should be updated to 'complete' (single chunk)
    expect(db.update).toHaveBeenCalled()
    // Insert called: pipeline_events (parse started) + chunk capture + pipeline_events (chunk success) + pipeline_events (embed success)
    expect(db.insert).toHaveBeenCalled()
    // Embed queue should have been called for the chunk
    expect(embedQueue.add).toHaveBeenCalledWith(
      'embed',
      expect.objectContaining({ captureId: expect.any(String) }),
      expect.objectContaining({ jobId: expect.stringContaining('embed_') }),
    )
  })
})

// ---------------------------------------------------------------------------
// processDocumentPipelineJob — missing capture
// ---------------------------------------------------------------------------

describe('processDocumentPipelineJob — capture not found', () => {
  it('throws UnrecoverableError when capture does not exist', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const embeddingService = makeMockEmbeddingService()
    const embedQueue = makeMockEmbedQueue()

    await expect(
      processDocumentPipelineJob(
        { captureId: 'missing-id' },
        db as any,
        embeddingService as any,
        embedQueue as any,
      ),
    ).rejects.toThrow(UnrecoverableError)
  })
})

// ---------------------------------------------------------------------------
// processDocumentPipelineJob — no file_path in source_metadata
// ---------------------------------------------------------------------------

describe('processDocumentPipelineJob — missing file_path', () => {
  it('throws UnrecoverableError when source_metadata has no file_path', async () => {
    const captureWithoutFilePath = {
      id: 'parent-cap-1',
      content: 'placeholder',
      capture_type: 'observation',
      brain_view: 'technical',
      source: 'document',
      source_metadata: {}, // no file_path
      pipeline_status: 'pending',
      tags: [],
    }

    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([captureWithoutFilePath])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const embeddingService = makeMockEmbeddingService()

    await expect(
      processDocumentPipelineJob(
        { captureId: 'parent-cap-1' },
        db as any,
        embeddingService as any,
      ),
    ).rejects.toThrow(UnrecoverableError)
  })
})

// ---------------------------------------------------------------------------
// processDocumentPipelineJob — already-terminal capture
// ---------------------------------------------------------------------------

describe('processDocumentPipelineJob — already terminal', () => {
  it('skips processing when pipeline_status is complete', async () => {
    const completedCapture = {
      id: 'parent-cap-1',
      content: 'placeholder',
      capture_type: 'observation',
      brain_view: 'technical',
      source: 'document',
      source_metadata: { file_path: '/tmp/test.pdf' },
      pipeline_status: 'complete',
      tags: [],
    }

    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([completedCapture])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const embeddingService = makeMockEmbeddingService()
    const embedQueue = makeMockEmbedQueue()

    await processDocumentPipelineJob(
      { captureId: 'parent-cap-1' },
      db as any,
      embeddingService as any,
      embedQueue as any,
    )

    // No updates, no inserts (pipeline events), no embed queue calls
    expect(db.update).not.toHaveBeenCalled()
    expect(embedQueue.add).not.toHaveBeenCalled()
  })

  it('skips processing when pipeline_status is chunked', async () => {
    const chunkedCapture = {
      id: 'parent-cap-1',
      content: 'placeholder',
      capture_type: 'observation',
      brain_view: 'technical',
      source: 'document',
      source_metadata: { file_path: '/tmp/test.pdf' },
      pipeline_status: 'chunked',
      tags: [],
    }

    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([chunkedCapture])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const embeddingService = makeMockEmbeddingService()
    const embedQueue = makeMockEmbedQueue()

    await processDocumentPipelineJob(
      { captureId: 'parent-cap-1' },
      db as any,
      embeddingService as any,
      embedQueue as any,
    )

    expect(db.update).not.toHaveBeenCalled()
    expect(embedQueue.add).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// processDocumentPipelineJob — dedup (duplicate chunk hash)
// ---------------------------------------------------------------------------

describe('processDocumentPipelineJob — duplicate chunk dedup', () => {
  it('does not re-enqueue existing chunk captures', async () => {
    const parserService = makeMockParser('Duplicate content.')
    const db = makeMockDb()
    // Simulate conflict (onConflictDoNothing returns empty — no inserted row)
    const insertChainWithConflict: Record<string, unknown> = {}
    insertChainWithConflict.values = vi.fn().mockReturnValue(insertChainWithConflict)
    insertChainWithConflict.onConflictDoNothing = vi.fn().mockReturnValue(insertChainWithConflict)
    insertChainWithConflict.returning = vi.fn().mockResolvedValue([]) // empty = conflict
    // Keep events inserts working
    let insertCallCount = 0
    db.insert = vi.fn().mockImplementation(() => {
      insertCallCount++
      if (insertCallCount <= 3) {
        // First few calls are for pipeline_events — use normal chain
        return makeInsertChain([])
      }
      // Chunk insert — simulate conflict
      return insertChainWithConflict
    })

    const embedQueue = makeMockEmbedQueue()
    const embeddingService = makeMockEmbeddingService()

    await processDocumentPipelineJob(
      { captureId: 'parent-cap-1' },
      db as any,
      embeddingService as any,
      embedQueue as any,
      parserService,
    )

    // embed queue should NOT have been called (chunk was deduped)
    expect(embedQueue.add).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// processDocumentPipelineJob — embed queue failure is non-fatal
// ---------------------------------------------------------------------------

describe('processDocumentPipelineJob — embed queue failure handling', () => {
  it('completes job even when embed queue add fails', async () => {
    const parserService = makeMockParser('Document text.')
    const db = makeMockDb()
    const embeddingService = makeMockEmbeddingService()
    const failingEmbedQueue = {
      add: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    }

    // Should not throw — embed queue failure is non-fatal
    await expect(
      processDocumentPipelineJob(
        { captureId: 'parent-cap-1' },
        db as any,
        embeddingService as any,
        failingEmbedQueue as any,
        parserService,
      ),
    ).resolves.toBeUndefined()
  })
})
