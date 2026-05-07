#!/usr/bin/env node
/**
 * Cross-platform integration test runner (A129).
 * Replaces the shell one-liner in package.json that broke on PowerShell
 * because pnpm parsed `test:integration;` as a literal script name.
 *
 * Usage: node scripts/test-integration.mjs
 * Or via: pnpm test:integration
 */
import { spawnSync } from 'node:child_process'

const COMPOSE_FILE = 'docker-compose.test.yml'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  return r.status ?? (r.error ? 1 : 0)
}

const upStatus = run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'])
if (upStatus !== 0) {
  console.error('docker compose up failed; aborting without test run')
  process.exit(upStatus)
}

let testStatus = 0
try {
  testStatus = run('pnpm', ['--filter', '@open-brain/core-api', 'test:integration'])
} finally {
  // Always tear down, even if tests crashed or were interrupted
  run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
}

process.exit(testStatus)
