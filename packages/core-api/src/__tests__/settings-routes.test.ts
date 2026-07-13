/**
 * Phase 3.6 (settings half) — settings route unit tests.
 *
 * Covers `packages/core-api/src/routes/settings.ts`:
 *   GET  /api/v1/settings/:key
 *   PUT  /api/v1/settings/:key
 *
 * Per CLAUDE.md, `app_settings` is a generic key/value store. The route
 * enforces:
 *   - WRITABLE_KEYS whitelist on PUT (200+null payload on GET when row missing — Phase C)
 *   - READABLE_KEYS whitelist on GET (DA-2: WRITABLE_KEYS minus the 3 OAuth
 *     token keys — `GET` on a token key is rejected with the same shape as
 *     an unknown key; workers still read tokens via direct Drizzle access)
 *   - Type-specific validators (autonomy_level, auto_response_threshold,
 *     auto_response_staleness_days, monitored_channels)
 *   - JSONB roundtrip preservation (value passed through to upsert as-is)
 *
 * DI strategy:
 *   - `makeTestApp(app => registerSettingsRoutes(app, db))` from helpers.ts.
 *   - `db` is a focused mock that only implements the two chains the route
 *     actually uses:
 *       1) db.select().from(table).where(condition)               → rows
 *       2) db.insert(table).values(row).onConflictDoUpdate(opts)  → void
 *     No other db methods are exercised by this route.
 *   - `vi.fn()` instances let tests inspect what was upserted (assert JSONB
 *     roundtrip on PUT).
 *
 * DI gap surfaced: the route imports `logger` from `@open-brain/shared` at
 * module scope (not injected). Acceptable here — logger is a no-op pass-
 * through; tests do not assert on log output. If Phase 5 extracts a
 * SettingsService, logger should become a constructor option for parity
 * with the rest of the service layer.
 */
import { describe, it, expect, vi } from 'vitest'
import { registerSettingsRoutes } from '../routes/settings.js'
import { makeTestApp, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Mock db factory — only implements the two chains the settings route uses.
// ---------------------------------------------------------------------------

interface MockDbOptions {
  /** Rows returned from the next select().from().where() call. */
  selectRows?: unknown[]
}

function makeMockDb(opts: MockDbOptions = {}) {
  const selectRows = opts.selectRows ?? []

  // Capture what gets upserted so tests can assert on JSONB roundtrip.
  const insertedRows: Array<{ key: string; value: unknown; updated_at: Date }> = []
  const upsertedSets: Array<{ key: string; value: unknown }> = []

  const onConflictDoUpdate = vi.fn(async (opts: { set: { value: unknown } }) => {
    // The route passes the same `body.value` reference to both .values() and
    // .onConflictDoUpdate({ set: { value } }). Capturing the SET clause is
    // sufficient for JSONB roundtrip assertions.
    upsertedSets.push({ key: insertedRows[insertedRows.length - 1].key, value: opts.set.value })
    return undefined
  })

  const valuesChain = vi.fn((row: { key: string; value: unknown; updated_at: Date }) => {
    insertedRows.push(row)
    return { onConflictDoUpdate }
  })

  const whereChain = vi.fn(async () => selectRows)

  const fromChain = vi.fn(() => ({ where: whereChain }))

  const select = vi.fn(() => ({ from: fromChain }))
  const insert = vi.fn(() => ({ values: valuesChain }))

  return {
    db: { select, insert } as never,
    insertedRows,
    upsertedSets,
    select,
    insert,
  }
}

function buildApp(opts: MockDbOptions = {}) {
  const ctx = makeMockDb(opts)
  const app = makeTestApp((app) => {
    registerSettingsRoutes(app, ctx.db)
    return app
  })
  return { app, ...ctx }
}

// ---------------------------------------------------------------------------
// GET /api/v1/settings/:key
// ---------------------------------------------------------------------------

describe('GET /api/v1/settings/:key', () => {
  it('returns a setting when row exists (whitelisted key)', async () => {
    const updatedAt = new Date('2026-04-22T10:00:00Z')
    const { app } = buildApp({
      selectRows: [{ key: 'autonomy_level', value: 'assist', updated_at: updatedAt }],
    })

    const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level')

    expect(status).toBe(200)
    // Hono's c.json() serializes Date via JSON.stringify → ISO string.
    expect(body).toEqual({
      key: 'autonomy_level',
      value: 'assist',
      updated_at: updatedAt.toISOString(),
    })
  })

  it('returns 200 with null payload when whitelisted key has no row in DB', async () => {
    // Phase C: missing-row is no longer a 404. Route returns 200 with null value
    // so frontend can read data?.value ?? DEFAULT cleanly without .catch() plumbing.
    const { app } = buildApp({ selectRows: [] })

    const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level')

    expect(status).toBe(200)
    expect(body).toEqual({ key: 'autonomy_level', value: null, updated_at: null })
  })

  it('returns 400 ValidationError for non-whitelisted key (A110)', async () => {
    // A110: GET enforces VALID_SETTINGS_KEYS whitelist — non-whitelisted key
    // returns 400 + VALIDATION_ERROR rather than falling through to DB.
    // Error message matches the PUT endpoint's pattern exactly.
    const { app, select } = buildApp({ selectRows: [] })

    const { status, body } = await testJson(app, '/api/v1/settings/totally_made_up_key')

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/Unknown settings key/i)
    // Whitelist check fires before DB query
    expect(select).not.toHaveBeenCalled()
  })

  it('returns 200 with null payload for whitelisted-but-unset key (Phase C RC4)', async () => {
    // Phase C: whitelisted-but-unset key returns {key, value: null, updated_at: null}.
    // This confirms the whitelist gate fires before the DB query and that
    // a valid key with a missing row returns the null-payload shape, not 404.
    const { app } = buildApp({ selectRows: [] })

    const { status, body } = await testJson(app, '/api/v1/settings/user_profile')

    expect(status).toBe(200)
    expect(body).toEqual({ key: 'user_profile', value: null, updated_at: null })
  })

  // -------------------------------------------------------------------------
  // DA-2: OAuth token keys are writable but never readable via HTTP
  // -------------------------------------------------------------------------
  describe('DA-2 — OAuth token keys rejected on GET', () => {
    for (const tokenKey of ['ms_token_cache_node', 'gmail_token_cache', 'gmail_credentials']) {
      it(`returns 400 ValidationError for GET ${tokenKey} — same shape as an unknown key`, async () => {
        const { app, select } = buildApp({
          selectRows: [{ key: tokenKey, value: { secret: 'plaintext-token' }, updated_at: new Date() }],
        })

        const { status, body } = await testJson(app, `/api/v1/settings/${tokenKey}`)

        expect(status).toBe(400)
        expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
        expect((body as { error?: string }).error).toMatch(/Unknown settings key/i)
        // Whitelist check fires before any DB query — plaintext token value
        // must never be reachable, even if a row exists.
        expect(select).not.toHaveBeenCalled()
      })
    }
  })
})

// ---------------------------------------------------------------------------
// PUT /api/v1/settings/:key — whitelist enforcement
// ---------------------------------------------------------------------------

describe('PUT /api/v1/settings/:key — whitelist', () => {
  it('returns 400 ValidationError for non-whitelisted key', async () => {
    const { app, insert } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/random_key', {
      method: 'PUT',
      body: JSON.stringify({ value: 'anything' }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/Unknown settings key/i)
    // Whitelist check happens before any DB write
    expect(insert).not.toHaveBeenCalled()
  })

  it('returns 400 when body.value is missing', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level', {
      method: 'PUT',
      body: JSON.stringify({ /* no value */ }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/value is required/i)
  })

  it('returns 400 when JSON body is malformed', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level', {
      method: 'PUT',
      body: 'not-json{{{',
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/Invalid JSON body/i)
  })
})

// ---------------------------------------------------------------------------
// PUT /api/v1/settings/:key — autonomy_level enum validator
// ---------------------------------------------------------------------------

describe('PUT /api/v1/settings/autonomy_level', () => {
  for (const level of ['observe', 'assist', 'advise', 'partner'] as const) {
    it(`accepts '${level}'`, async () => {
      const { app, upsertedSets } = buildApp()

      const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level', {
        method: 'PUT',
        body: JSON.stringify({ value: level }),
      })

      expect(status).toBe(200)
      expect(body).toMatchObject({ key: 'autonomy_level', value: level })
      expect(upsertedSets).toHaveLength(1)
      expect(upsertedSets[0]).toEqual({ key: 'autonomy_level', value: level })
    })
  }

  it("rejects 'invalid' with 400 ValidationError", async () => {
    const { app, insert } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level', {
      method: 'PUT',
      body: JSON.stringify({ value: 'invalid' }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/autonomy_level must be one of/i)
    expect((body as { error?: string }).error).toMatch(/observe.*assist.*advise.*partner/i)
    expect(insert).not.toHaveBeenCalled()
  })

  it('rejects non-string types (number) with 400', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/autonomy_level', {
      method: 'PUT',
      body: JSON.stringify({ value: 42 }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// PUT /api/v1/settings/auto_response_threshold — numeric range validator
// ---------------------------------------------------------------------------

describe('PUT /api/v1/settings/auto_response_threshold', () => {
  it('accepts 0.75 (within [0,1])', async () => {
    const { app, upsertedSets } = buildApp()

    const { status } = await testJson(app, '/api/v1/settings/auto_response_threshold', {
      method: 'PUT',
      body: JSON.stringify({ value: 0.75 }),
    })

    expect(status).toBe(200)
    expect(upsertedSets[0]?.value).toBe(0.75)
  })

  it('rejects 1.5 (out of range) with 400', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/auto_response_threshold', {
      method: 'PUT',
      body: JSON.stringify({ value: 1.5 }),
    })

    expect(status).toBe(400)
    expect((body as { error?: string }).error).toMatch(/between 0 and 1/i)
  })
})

// ---------------------------------------------------------------------------
// JSONB roundtrip — complex nested object on a key without a type validator
// ---------------------------------------------------------------------------

describe('PUT /api/v1/settings/:key — JSONB roundtrip', () => {
  it('preserves a complex nested object end-to-end (user_profile)', async () => {
    const profile = {
      name: 'Troy Davis',
      timezone: 'America/New_York',
      preferences: {
        theme: 'dark',
        notifications: { slack: true, email: false, channels: ['ops', 'alerts'] },
      },
      tags: ['ham-radio', 'sailing'],
    }
    const { app, upsertedSets } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/user_profile', {
      method: 'PUT',
      body: JSON.stringify({ value: profile }),
    })

    expect(status).toBe(200)
    // Response carries the same shape back
    expect((body as { value?: unknown }).value).toEqual(profile)
    // And the same shape was passed to db.insert(...).values() / SET clause
    expect(upsertedSets).toHaveLength(1)
    expect(upsertedSets[0]).toEqual({ key: 'user_profile', value: profile })
  })
})

// ---------------------------------------------------------------------------
// Email allowlist (PUT email_allowlist) — A111 array validator
// ---------------------------------------------------------------------------

describe('PUT /api/v1/settings/email_allowlist', () => {
  it('accepts a valid array of email strings (A111)', async () => {
    const allowlist = ['troy@example.com', 'ops@example.com', 'brain@troy-davis.com']
    const { app, upsertedSets } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/email_allowlist', {
      method: 'PUT',
      body: JSON.stringify({ value: allowlist }),
    })

    expect(status).toBe(200)
    expect((body as { value?: unknown }).value).toEqual(allowlist)
    expect(upsertedSets[0]?.value).toEqual(allowlist)
  })

  it('accepts an empty array (clearing the allowlist is valid) (A111)', async () => {
    const { app, upsertedSets } = buildApp()

    const { status } = await testJson(app, '/api/v1/settings/email_allowlist', {
      method: 'PUT',
      body: JSON.stringify({ value: [] }),
    })

    expect(status).toBe(200)
    expect(upsertedSets[0]?.value).toEqual([])
  })

  it('returns 400 when value is a string instead of array (A111)', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/email_allowlist', {
      method: 'PUT',
      body: JSON.stringify({ value: 'foo@bar.com' }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/array of valid email addresses/i)
  })

  it('returns 400 when array contains a non-string entry (A111)', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/email_allowlist', {
      method: 'PUT',
      body: JSON.stringify({ value: [42] }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/array of valid email addresses/i)
  })

  it('returns 400 when array contains a malformed email string (A111)', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/email_allowlist', {
      method: 'PUT',
      body: JSON.stringify({ value: ['not-an-email'] }),
    })

    expect(status).toBe(400)
    expect((body as { code?: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error?: string }).error).toMatch(/array of valid email addresses/i)
  })
})

// ---------------------------------------------------------------------------
// monitored_channels — array-of-strings validator
// ---------------------------------------------------------------------------

describe('PUT /api/v1/settings/monitored_channels', () => {
  it('accepts an array of channel ID strings', async () => {
    const channels = ['C123', 'C456', 'C789']
    const { app, upsertedSets } = buildApp()

    const { status } = await testJson(app, '/api/v1/settings/monitored_channels', {
      method: 'PUT',
      body: JSON.stringify({ value: channels }),
    })

    expect(status).toBe(200)
    expect(upsertedSets[0]?.value).toEqual(channels)
  })

  it('rejects a non-array value with 400', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/monitored_channels', {
      method: 'PUT',
      body: JSON.stringify({ value: 'C123' }),
    })

    expect(status).toBe(400)
    expect((body as { error?: string }).error).toMatch(/array of channel ID strings/i)
  })

  it('rejects an array containing non-string entries with 400', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/settings/monitored_channels', {
      method: 'PUT',
      body: JSON.stringify({ value: ['C123', 42, 'C789'] }),
    })

    expect(status).toBe(400)
    expect((body as { error?: string }).error).toMatch(/array of channel ID strings/i)
  })
})
