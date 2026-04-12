import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import OpenAI from 'openai'
import { createOllamaClient } from '../ollama-client.js'

describe('createOllamaClient', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.OLLAMA_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns null when OLLAMA_URL is not set and no baseUrl provided', () => {
    const client = createOllamaClient()
    expect(client).toBeNull()
  })

  it('returns null when OLLAMA_URL is empty string', () => {
    process.env.OLLAMA_URL = ''
    const client = createOllamaClient()
    expect(client).toBeNull()
  })

  it('returns null when explicit baseUrl is empty string', () => {
    const client = createOllamaClient({ baseUrl: '' })
    expect(client).toBeNull()
  })

  it('returns OpenAI instance when OLLAMA_URL is set', () => {
    process.env.OLLAMA_URL = 'http://localhost:11434/v1'
    const client = createOllamaClient()
    expect(client).toBeInstanceOf(OpenAI)
  })

  it('returns OpenAI instance when baseUrl is provided explicitly', () => {
    const client = createOllamaClient({ baseUrl: 'http://my-ollama:11434/v1' })
    expect(client).toBeInstanceOf(OpenAI)
  })

  it('explicit baseUrl overrides OLLAMA_URL env var', () => {
    process.env.OLLAMA_URL = 'http://env-ollama:11434/v1'
    const client = createOllamaClient({ baseUrl: 'http://explicit-ollama:11434/v1' })
    expect(client).toBeInstanceOf(OpenAI)
    // The OpenAI SDK stores baseURL on the instance
    expect((client as OpenAI).baseURL).toBe('http://explicit-ollama:11434/v1')
  })

  it('appends /v1 if not present in URL', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434' })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as OpenAI).baseURL).toBe('http://ollama:11434/v1')
  })

  it('does not double-append /v1 if already present', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1' })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as OpenAI).baseURL).toBe('http://ollama:11434/v1')
  })

  it('uses dummy API key (Ollama ignores it but SDK requires it)', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1' })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as OpenAI).apiKey).toBe('ollama')
  })

  it('defaults maxRetries to 0 for fail-fast local inference', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1' })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as OpenAI).maxRetries).toBe(0)
  })

  it('respects explicit maxRetries override', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1', maxRetries: 3 })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as OpenAI).maxRetries).toBe(3)
  })

  it('uses standard timeout tier by default (30s)', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1' })
    expect(client).toBeInstanceOf(OpenAI)
    // OpenAI SDK stores timeout as a number
    expect((client as unknown as { timeout: number }).timeout).toBe(30_000)
  })

  it('accepts fast timeout tier (10s)', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1', timeout: 'fast' })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as unknown as { timeout: number }).timeout).toBe(10_000)
  })

  it('accepts extended timeout tier (60s)', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1', timeout: 'extended' })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as unknown as { timeout: number }).timeout).toBe(60_000)
  })

  it('accepts numeric timeout in milliseconds', () => {
    const client = createOllamaClient({ baseUrl: 'http://ollama:11434/v1', timeout: 5000 })
    expect(client).toBeInstanceOf(OpenAI)
    expect((client as unknown as { timeout: number }).timeout).toBe(5000)
  })
})
