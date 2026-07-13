/**
 * Tests for the INT-M4 transcript dead-letter spool.
 *
 * Each test points VOICE_SPOOL_DIR at a fresh temp dir so the spool's real
 * filesystem behavior (write-ahead, retry, delete-on-success) is exercised
 * without mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  spoolTranscript,
  listSpooled,
  removeSpooled,
  retrySpooledTranscripts,
} from '../lib/transcript-spool.js'

describe('transcript-spool (INT-M4 dead-letter)', () => {
  let spoolDir: string
  const ORIG = process.env.VOICE_SPOOL_DIR
  const ORIG_MAX_AGE = process.env.VOICE_SPOOL_MAX_AGE_MS

  const payload = {
    content: 'a transcribed memo',
    capture_type: 'idea',
    brain_view: 'personal',
    source: 'voice',
  }

  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), 'voice-spool-test-'))
    process.env.VOICE_SPOOL_DIR = spoolDir
  })

  afterEach(() => {
    rmSync(spoolDir, { recursive: true, force: true })
    if (ORIG === undefined) delete process.env.VOICE_SPOOL_DIR
    else process.env.VOICE_SPOOL_DIR = ORIG
    if (ORIG_MAX_AGE === undefined) delete process.env.VOICE_SPOOL_MAX_AGE_MS
    else process.env.VOICE_SPOOL_MAX_AGE_MS = ORIG_MAX_AGE
  })

  it('returns an empty list when nothing is spooled', async () => {
    expect(await listSpooled()).toEqual([])
  })

  it('spools a payload to disk and lists it', async () => {
    const file = await spoolTranscript(payload)
    expect(file).toContain(spoolDir)
    const files = await listSpooled()
    expect(files).toHaveLength(1)
  })

  it('removeSpooled deletes a spooled file', async () => {
    const file = await spoolTranscript(payload)
    await removeSpooled(file)
    expect(await listSpooled()).toHaveLength(0)
  })

  it('retry ingests and DELETES the spool file on success', async () => {
    await spoolTranscript(payload)
    const ingest = vi.fn().mockResolvedValue({ id: 'capture-1' })

    const result = await retrySpooledTranscripts(ingest)

    expect(ingest).toHaveBeenCalledTimes(1)
    // The payload round-trips through disk back to the ingest fn.
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ content: 'a transcribed memo' }))
    expect(result).toMatchObject({ retried: 1, succeeded: 1, failed: 0 })
    expect(await listSpooled()).toHaveLength(0)
  })

  it('retry LEAVES the spool file when ingest fails (preserved for next sweep)', async () => {
    await spoolTranscript(payload)
    const ingest = vi.fn().mockRejectedValue(new Error('core-api unreachable'))

    const result = await retrySpooledTranscripts(ingest)

    expect(result).toMatchObject({ retried: 1, succeeded: 0, failed: 1 })
    expect(await listSpooled()).toHaveLength(1) // not lost — retried later
  })

  it('retry discards an unparseable spool file rather than looping forever', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(spoolDir, 'corrupt.json'), '{not json', 'utf8')
    const ingest = vi.fn().mockResolvedValue({ id: 'x' })

    const result = await retrySpooledTranscripts(ingest)

    expect(ingest).not.toHaveBeenCalled()
    expect(await listSpooled()).toHaveLength(0) // corrupt file removed
    expect(result.retried).toBe(1)
  })

  it('retry treats a 409-duplicate ingest result as success — spool file removed', async () => {
    // IngestService.ingest() now resolves (rather than rejects) on a 409 dedup
    // conflict, returning { id, duplicate: true }. From the spool's perspective
    // this is indistinguishable from any other successful ingest.
    await spoolTranscript(payload)
    const ingest = vi.fn().mockResolvedValue({ id: 'duplicate', duplicate: true })

    const result = await retrySpooledTranscripts(ingest)

    expect(ingest).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ retried: 1, succeeded: 1, failed: 0, deadLettered: 0 })
    expect(await listSpooled()).toHaveLength(0)
  })

  it('retry LEAVES the spool file when ingest rejects with a non-409 4xx (retained, not dead-lettered)', async () => {
    await spoolTranscript(payload)
    const ingest = vi.fn().mockRejectedValue(new Error('Core API returned HTTP 400: Bad Request: missing content'))

    const result = await retrySpooledTranscripts(ingest)

    expect(result).toMatchObject({ retried: 1, succeeded: 0, failed: 1, deadLettered: 0 })
    expect(await listSpooled()).toHaveLength(1) // fresh file — still eligible for the next sweep
  })

  it('dead-letters a spooled file exceeding max age, alerts via Pushover, and skips ingest entirely', async () => {
    const file = await spoolTranscript(payload)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // default max age is 7 days
    await utimes(file, eightDaysAgo, eightDaysAgo)

    const ingest = vi.fn().mockResolvedValue({ id: 'should-not-be-called' })
    const notify = vi.fn().mockResolvedValue(undefined)

    const result = await retrySpooledTranscripts(ingest, notify)

    expect(ingest).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining('dead-lettered'),
      priority: 1,
    })
    expect(result).toMatchObject({ retried: 1, succeeded: 0, failed: 0, deadLettered: 1 })
    expect(await listSpooled()).toHaveLength(0)
  })

  it('does not dead-letter a fresh file even when it fails ingest repeatedly', async () => {
    await spoolTranscript(payload)
    const ingest = vi.fn().mockRejectedValue(new Error('core-api unreachable'))
    const notify = vi.fn().mockResolvedValue(undefined)

    const result = await retrySpooledTranscripts(ingest, notify)

    expect(notify).not.toHaveBeenCalled()
    expect(result).toMatchObject({ retried: 1, succeeded: 0, failed: 1, deadLettered: 0 })
    expect(await listSpooled()).toHaveLength(1)
  })

  it('respects VOICE_SPOOL_MAX_AGE_MS override for the dead-letter threshold', async () => {
    const file = await spoolTranscript(payload)
    const fiveSecondsAgo = new Date(Date.now() - 5_000)
    await utimes(file, fiveSecondsAgo, fiveSecondsAgo)
    process.env.VOICE_SPOOL_MAX_AGE_MS = '1000' // 1s threshold — the 5s-old file exceeds it

    const ingest = vi.fn()
    const notify = vi.fn().mockResolvedValue(undefined)

    const result = await retrySpooledTranscripts(ingest, notify)

    expect(ingest).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(result.deadLettered).toBe(1)
  })

  it('swallows a notify failure without losing sweep results', async () => {
    const file = await spoolTranscript(payload)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(file, eightDaysAgo, eightDaysAgo)

    const ingest = vi.fn()
    const notify = vi.fn().mockRejectedValue(new Error('pushover unreachable'))

    const result = await retrySpooledTranscripts(ingest, notify)

    expect(result).toMatchObject({ deadLettered: 1 })
    expect(await listSpooled()).toHaveLength(0) // still dead-lettered despite the alert failing
  })
})
