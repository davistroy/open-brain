import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from '@open-brain/shared'
import { requireCoreApiUrl, CORE_API_URL_DEV_FALLBACK } from '../lib/require-core-api-url.js'

// ============================================================
// SE-16 — stop the silent OPEN_BRAIN_API_URL fallback in workers.
//
// requireCoreApiUrl() resolves OPEN_BRAIN_API_URL using the codebase's
// established fail-closed NODE_ENV convention:
//   - set                          → return it (no warn)
//   - unset + dev/test             → warn once, return localhost fallback
//   - unset + production/unknown   → throw (fail-fast at startup)
// ============================================================

describe('requireCoreApiUrl', () => {
  let savedApiUrl: string | undefined
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    savedApiUrl = process.env.OPEN_BRAIN_API_URL
    savedNodeEnv = process.env.NODE_ENV
    vi.restoreAllMocks()
  })

  afterEach(() => {
    // Restore both env vars to whatever they were before each test.
    if (savedApiUrl === undefined) delete process.env.OPEN_BRAIN_API_URL
    else process.env.OPEN_BRAIN_API_URL = savedApiUrl

    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  })

  it('returns the value when OPEN_BRAIN_API_URL is set (no warn)', () => {
    process.env.OPEN_BRAIN_API_URL = 'http://core-api:3000'
    process.env.NODE_ENV = 'production'
    const warnSpy = vi.spyOn(logger, 'warn')

    expect(requireCoreApiUrl()).toBe('http://core-api:3000')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns the value when set even in development (no warn, no fallback)', () => {
    process.env.OPEN_BRAIN_API_URL = 'http://custom:9999'
    process.env.NODE_ENV = 'development'
    const warnSpy = vi.spyOn(logger, 'warn')

    expect(requireCoreApiUrl()).toBe('http://custom:9999')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('throws when unset and NODE_ENV=production', () => {
    delete process.env.OPEN_BRAIN_API_URL
    process.env.NODE_ENV = 'production'

    expect(() => requireCoreApiUrl()).toThrow(/OPEN_BRAIN_API_URL/)
  })

  it('throws when unset and NODE_ENV is unset (unset NODE_ENV is treated as production)', () => {
    delete process.env.OPEN_BRAIN_API_URL
    delete process.env.NODE_ENV

    expect(() => requireCoreApiUrl()).toThrow(/OPEN_BRAIN_API_URL/)
  })

  it('throws when unset and NODE_ENV is an unknown value (treated as production)', () => {
    delete process.env.OPEN_BRAIN_API_URL
    process.env.NODE_ENV = 'staging'

    expect(() => requireCoreApiUrl()).toThrow(/OPEN_BRAIN_API_URL/)
  })

  it('returns localhost fallback and warns once in development', () => {
    delete process.env.OPEN_BRAIN_API_URL
    process.env.NODE_ENV = 'development'
    const warnSpy = vi.spyOn(logger, 'warn')

    expect(requireCoreApiUrl()).toBe(CORE_API_URL_DEV_FALLBACK)
    expect(CORE_API_URL_DEV_FALLBACK).toBe('http://localhost:3000')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('returns localhost fallback and warns in test environment', () => {
    delete process.env.OPEN_BRAIN_API_URL
    process.env.NODE_ENV = 'test'
    const warnSpy = vi.spyOn(logger, 'warn')

    expect(requireCoreApiUrl()).toBe(CORE_API_URL_DEV_FALLBACK)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
