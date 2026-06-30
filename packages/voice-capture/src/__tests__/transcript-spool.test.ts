/**
 * Tests for the INT-M4 transcript dead-letter spool.
 *
 * Each test points VOICE_SPOOL_DIR at a fresh temp dir so the spool's real
 * filesystem behavior (write-ahead, retry, delete-on-success) is exercised
 * without mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
})
