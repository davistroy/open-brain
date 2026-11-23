import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'

// ADR-0005 rollout switches (Phase 2 review F3). The runbook's rollback edits
// these values in the workers `environment:` block. They must be literals:
// `.env` is only a compose interpolation source and never reaches the
// container (A145), so a `${...}` or `.env`-only switch is dead config.

const here = dirname(fileURLToPath(import.meta.url))
const composePath = resolve(here, '../../../../docker-compose.yml')

function workersEnvironment(): Record<string, unknown> {
  const doc = load(readFileSync(composePath, 'utf8')) as {
    services?: { workers?: { environment?: Record<string, unknown> | string[] } }
  }
  const env = doc.services?.workers?.environment
  expect(env, 'workers service has an environment: block').toBeDefined()
  expect(Array.isArray(env), 'workers environment: is a map').toBe(false)
  return env as Record<string, unknown>
}

describe('docker-compose.yml — workers alert switches', () => {
  it.each(['ALERT_STATE_ENABLED', 'ALERT_LEGACY_PUSH'])(
    '%s is a literal "true" in the workers environment block (no interpolation)',
    (name) => {
      const env = workersEnvironment()
      expect(env[name]).toBe('true')
    },
  )
})
