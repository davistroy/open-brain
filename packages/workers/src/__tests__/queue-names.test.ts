import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKER_QUEUES,
  PRODUCER_ONLY_QUEUES,
  ALL_MONITORED_QUEUES,
} from '@open-brain/shared'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') continue
      walk(p, out)
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.spec.ts')) {
      out.push(p)
    }
  }
  return out
}

/** Collect the queue name of every `new Worker(` call in non-test source. */
function collectWorkerQueueNames(): string[] {
  const names: string[] = []
  const re = /new Worker\s*(?:<[^()]*?>)?\s*\(\s*([^,\s)]+)/g
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(re)) {
      const arg = m[1]!
      const lit = /^['"`]([^'"`]+)['"`]$/.exec(arg)
      if (lit) {
        names.push(lit[1]!)
      } else if (arg === 'INGEST_ROOT_QUEUE_NAME') {
        const c = /export const INGEST_ROOT_QUEUE_NAME\s*=\s*['"]([^'"]+)['"]/.exec(
          readFileSync(join(SRC, 'flows/ingest-pipeline.ts'), 'utf8'),
        )
        if (!c) throw new Error('INGEST_ROOT_QUEUE_NAME constant not found')
        names.push(c[1]!)
      } else {
        throw new Error(`Unresolvable queue name "${arg}" in ${file}`)
      }
    }
  }
  return names
}

describe('queue registry', () => {
  it('WORKER_QUEUES equals the set of new Worker(...) queue names', () => {
    const found = collectWorkerQueueNames()
    expect(found.length).toBeGreaterThan(0)
    expect(new Set(found).size).toBe(found.length) // no queue consumed twice
    expect([...new Set(found)].sort()).toEqual([...WORKER_QUEUES].sort())
  })

  it('has 17 worker queues and no duplicates', () => {
    expect(WORKER_QUEUES).toHaveLength(17)
    expect(new Set(WORKER_QUEUES).size).toBe(WORKER_QUEUES.length)
  })

  it('ALL_MONITORED_QUEUES = worker + producer-only queues', () => {
    expect([...ALL_MONITORED_QUEUES].sort()).toEqual(
      [...WORKER_QUEUES, ...PRODUCER_ONLY_QUEUES].sort(),
    )
  })

  it('does not include the consumer-less notification queue', () => {
    expect(ALL_MONITORED_QUEUES).not.toContain('notification')
  })
})
