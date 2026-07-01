import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolveClassificationModel } from '../lib/classification-model.js'

// Mirrors the pattern in server.test.ts — compute the real repo config dir
// from this file's location so tests can exercise the actual ai-routing.yaml.
const REPO_CONFIG_DIR = fileURLToPath(new URL('../../../../config', import.meta.url))

describe('resolveClassificationModel', () => {
  let savedClassificationModel: string | undefined
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedClassificationModel = process.env.CLASSIFICATION_MODEL
    savedConfigDir = process.env.CONFIG_DIR
  })

  afterEach(() => {
    if (savedClassificationModel === undefined) delete process.env.CLASSIFICATION_MODEL
    else process.env.CLASSIFICATION_MODEL = savedClassificationModel
    if (savedConfigDir === undefined) delete process.env.CONFIG_DIR
    else process.env.CONFIG_DIR = savedConfigDir
  })

  it('returns CLASSIFICATION_MODEL env var when set (highest priority)', () => {
    process.env.CLASSIFICATION_MODEL = 'my-override-model'
    process.env.CONFIG_DIR = REPO_CONFIG_DIR
    expect(resolveClassificationModel()).toBe('my-override-model')
  })

  it('resolves the OpenAI-servable models.intent alias from ai-routing.yaml when config is available', () => {
    delete process.env.CLASSIFICATION_MODEL
    process.env.CONFIG_DIR = REPO_CONFIG_DIR
    // ai-routing.yaml: models.intent -> "gpt-5.4" (OpenAI-servable — voice-capture's
    // client hits OPENAI_BASE_URL, so the Jetson tier model would 404). Config-driven
    // (SA-7) without changing the working runtime model.
    expect(resolveClassificationModel()).toBe('gpt-5.4')
  })

  it('env override wins over config even when config is available', () => {
    process.env.CLASSIFICATION_MODEL = 'forced-model'
    process.env.CONFIG_DIR = REPO_CONFIG_DIR
    expect(resolveClassificationModel()).toBe('forced-model')
  })

  it('falls back to gpt-5.4 when CONFIG_DIR points to a nonexistent directory', () => {
    delete process.env.CLASSIFICATION_MODEL
    process.env.CONFIG_DIR = '/nonexistent/dir/that/cannot/exist-xyzzy'
    expect(resolveClassificationModel()).toBe('gpt-5.4')
  })

  it('falls back to gpt-5.4 when CONFIG_DIR is not set (default /app/config absent in test env)', () => {
    delete process.env.CLASSIFICATION_MODEL
    delete process.env.CONFIG_DIR
    // Default /app/config does not exist in the test environment -> graceful fallback
    expect(resolveClassificationModel()).toBe('gpt-5.4')
  })
})
