import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadPromptTemplate,
  renderPromptTemplate,
  loadAndRenderPromptTemplate,
} from '../prompt-template.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `open-brain-prompt-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('loadPromptTemplate', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('reads a template file and returns its contents', () => {
    writeFileSync(join(tmpDir, 'test.v1.txt'), 'Hello {{name}}!')
    const result = loadPromptTemplate(tmpDir, 'test.v1.txt')
    expect(result).toBe('Hello {{name}}!')
  })

  it('throws if template file does not exist', () => {
    expect(() => loadPromptTemplate(tmpDir, 'nonexistent.txt')).toThrow(
      'Prompt template not found',
    )
  })

  it('includes the full path in the error message', () => {
    expect(() => loadPromptTemplate(tmpDir, 'missing.txt')).toThrow(
      join(tmpDir, 'missing.txt'),
    )
  })

  it('reads multi-line templates', () => {
    const content = 'Line 1\nLine 2\nLine 3'
    writeFileSync(join(tmpDir, 'multi.txt'), content)
    expect(loadPromptTemplate(tmpDir, 'multi.txt')).toBe(content)
  })
})

describe('renderPromptTemplate', () => {
  it('replaces {{key}} placeholders with values', () => {
    const result = renderPromptTemplate('Hello {{name}}, welcome to {{place}}!', {
      name: 'Troy',
      place: 'Open Brain',
    })
    expect(result).toBe('Hello Troy, welcome to Open Brain!')
  })

  it('leaves missing variables as-is', () => {
    const result = renderPromptTemplate('Hello {{name}}, your role is {{role}}', {
      name: 'Troy',
    })
    expect(result).toBe('Hello Troy, your role is {{role}}')
  })

  it('silently ignores extra variables', () => {
    const result = renderPromptTemplate('Hello {{name}}!', {
      name: 'Troy',
      unused: 'ignored',
    })
    expect(result).toBe('Hello Troy!')
  })

  it('handles empty vars object', () => {
    const template = 'No {{vars}} here'
    expect(renderPromptTemplate(template, {})).toBe('No {{vars}} here')
  })

  it('replaces all occurrences of the same variable', () => {
    const result = renderPromptTemplate('{{x}} and {{x}} and {{x}}', { x: 'A' })
    expect(result).toBe('A and A and A')
  })

  it('handles empty string values', () => {
    const result = renderPromptTemplate('Before{{gap}}After', { gap: '' })
    expect(result).toBe('BeforeAfter')
  })

  it('handles values containing curly braces', () => {
    const result = renderPromptTemplate('Result: {{data}}', {
      data: '{"key": "value"}',
    })
    expect(result).toBe('Result: {"key": "value"}')
  })

  it('replaces sequentially — a value that produces a placeholder for a later key gets substituted', () => {
    // Keys are processed in insertion order. {{a}} → {{b}}, then {{b}} → nested.
    const result = renderPromptTemplate('{{a}}', { a: '{{b}}', b: 'nested' })
    expect(result).toBe('nested')
  })

  it('does not re-process earlier keys after later substitutions', () => {
    // {{b}} → {{a}}, but {{a}} replacement already happened (no match), so {{a}} remains.
    const result = renderPromptTemplate('{{b}}', { a: 'first', b: '{{a}}' })
    expect(result).toBe('{{a}}')
  })

  it('returns template unchanged when no placeholders present', () => {
    const template = 'No placeholders in this text'
    expect(renderPromptTemplate(template, { key: 'val' })).toBe(template)
  })
})

describe('loadAndRenderPromptTemplate', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('loads and renders a template in one call', () => {
    writeFileSync(
      join(tmpDir, 'greeting.v1.txt'),
      'Hello {{name}}, you have {{count}} captures.',
    )
    const result = loadAndRenderPromptTemplate(tmpDir, 'greeting.v1.txt', {
      name: 'Troy',
      count: '42',
    })
    expect(result).toBe('Hello Troy, you have 42 captures.')
  })

  it('throws if the template file is missing', () => {
    expect(() =>
      loadAndRenderPromptTemplate(tmpDir, 'missing.txt', { key: 'val' }),
    ).toThrow('Prompt template not found')
  })

  it('leaves unmatched placeholders intact', () => {
    writeFileSync(join(tmpDir, 'partial.txt'), '{{a}} and {{b}}')
    const result = loadAndRenderPromptTemplate(tmpDir, 'partial.txt', { a: 'filled' })
    expect(result).toBe('filled and {{b}}')
  })
})
