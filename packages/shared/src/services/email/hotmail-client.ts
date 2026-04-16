/**
 * Hotmail/Outlook email provider — Microsoft Graph API + MSAL device code auth.
 *
 * Ported from Python email-pipeline.py HotmailBackend.
 * Token cache is stored in the app_settings table (key: ms_token_cache),
 * not on the filesystem, so any container can authenticate.
 */
import * as msal from '@azure/msal-node'
import { eq } from 'drizzle-orm'
import { app_settings } from '../../schema/index.js'
import { createLogger } from '../../lib/logger.js'
import type { Database } from '../../db/index.js'
import type { EmailMessage, EmailFolder, EmailProvider } from './types.js'

const log = createLogger('hotmail-client')

// ── Constants ────────────────────────────────────────────────────────────────

/** Public client ID for device code flow — not a secret. */
const MS_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
const MS_AUTHORITY = 'https://login.microsoftonline.com/common'
const MS_SCOPES = ['Mail.ReadWrite', 'User.Read']

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const API_DELAY_MS = 100
const BATCH_SIZE = 50
const MAX_INBOX_MESSAGES = 200
const MAX_SPAM_CLEANUP = 200

const SETTINGS_KEY = 'ms_token_cache'

/** Maximum number of retry attempts for rate-limited (429) requests. */
const MAX_RETRIES = 3

// ── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse a Retry-After header value to milliseconds.
 * Accepts either seconds (number) or an HTTP-date.
 */
function parseRetryAfter(header: string | null): number {
  if (!header) return 5_000
  const secs = Number(header)
  if (!Number.isNaN(secs)) return secs * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 1_000)
  return 5_000
}

// ── Token cache persistence via app_settings ─────────────────────────────────

async function loadTokenCache(db: Database): Promise<string | null> {
  const rows = await db.select().from(app_settings).where(eq(app_settings.key, SETTINGS_KEY))
  if (rows.length === 0) return null
  const value = rows[0].value as { cache?: string } | null
  return value?.cache ?? null
}

async function saveTokenCache(db: Database, serialized: string): Promise<void> {
  const now = new Date()
  await db.insert(app_settings)
    .values({ key: SETTINGS_KEY, value: { cache: serialized }, updated_at: now })
    .onConflictDoUpdate({
      target: app_settings.key,
      set: { value: { cache: serialized }, updated_at: now },
    })
}

// ── HotmailClient ────────────────────────────────────────────────────────────

export interface HotmailClientOptions {
  db: Database
  /** Override client ID for testing. */
  clientId?: string
  /** Override authority for testing. */
  authority?: string
  /** Override Graph API base URL for testing. */
  graphBase?: string
  /** Inject custom fetch for testing. */
  fetchFn?: typeof globalThis.fetch
}

export class HotmailClient implements EmailProvider {
  private db: Database
  private cache: msal.TokenCache
  private app: msal.PublicClientApplication
  private accessToken: string | null = null
  private graphBase: string
  private fetchFn: typeof globalThis.fetch

  constructor(opts: HotmailClientOptions) {
    this.db = opts.db
    this.graphBase = opts.graphBase ?? GRAPH_BASE
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis)

    const cachePlugin: msal.ICachePlugin = {
      beforeCacheAccess: async (ctx: msal.TokenCacheContext) => {
        const serialized = await loadTokenCache(this.db)
        if (serialized) {
          ctx.tokenCache.deserialize(serialized)
        }
      },
      afterCacheAccess: async (ctx: msal.TokenCacheContext) => {
        if (ctx.cacheHasChanged) {
          await saveTokenCache(this.db, ctx.tokenCache.serialize())
        }
      },
    }

    this.app = new msal.PublicClientApplication({
      auth: {
        clientId: opts.clientId ?? MS_CLIENT_ID,
        authority: opts.authority ?? MS_AUTHORITY,
      },
      cache: { cachePlugin },
    })
    this.cache = this.app.getTokenCache()
  }

  // ── Authentication ───────────────────────────────────────────────────────

  async authenticate(): Promise<boolean> {
    // Try silent token acquisition from cache first
    const accounts = await this.cache.getAllAccounts()
    if (accounts.length > 0) {
      try {
        const result = await this.app.acquireTokenSilent({
          account: accounts[0],
          scopes: MS_SCOPES,
        })
        if (result?.accessToken) {
          this.accessToken = result.accessToken
          log.info({ username: accounts[0].username }, 'Hotmail: cached auth')
          return true
        }
      } catch {
        log.debug('Silent token acquisition failed, falling back to device code')
      }
    }

    // Device code flow (interactive — requires user action)
    try {
      const result = await this.app.acquireTokenByDeviceCode({
        scopes: MS_SCOPES,
        deviceCodeCallback: (response) => {
          log.info({ message: response.message }, 'Hotmail: device code auth required')
          // In a server context, this message should be relayed to the user
          // via Slack DM or Pushover notification
          console.log(`\n${'='.repeat(60)}\nMICROSOFT AUTHENTICATION\n${'='.repeat(60)}\n${response.message}\n${'='.repeat(60)}\n`)
        },
      })
      if (result?.accessToken) {
        this.accessToken = result.accessToken
        log.info('Hotmail: authenticated via device code')
        return true
      }
    } catch (err) {
      log.error({ err }, 'Hotmail: device code auth failed')
    }

    return false
  }

  // ── Graph API transport ──────────────────────────────────────────────────

  /**
   * Make a Graph API GET request with automatic token refresh and rate limiting.
   */
  private async graphGet<T = Record<string, unknown>>(url: string): Promise<T | null> {
    return this.graphRequest<T>('GET', url)
  }

  /**
   * Make a Graph API POST request with automatic token refresh and rate limiting.
   */
  private async graphPost<T = Record<string, unknown>>(url: string, body: Record<string, unknown>): Promise<T | null> {
    return this.graphRequest<T>('POST', url, body)
  }

  /**
   * Make a Graph API DELETE request with automatic token refresh and rate limiting.
   */
  private async graphDelete(url: string): Promise<boolean> {
    const result = await this.graphRequest('DELETE', url)
    return result !== null
  }

  private async graphRequest<T>(method: string, url: string, body?: Record<string, unknown>): Promise<T | null> {
    if (!this.accessToken) {
      log.error('No access token — call authenticate() first')
      return null
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      }

      const resp = await this.fetchFn(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })

      // Handle 401 — token expired, try refresh
      if (resp.status === 401 && attempt === 0) {
        log.debug('Token expired, attempting refresh')
        const refreshed = await this.refreshToken()
        if (refreshed) {
          headers.Authorization = `Bearer ${this.accessToken}`
          continue
        }
        log.error('Token refresh failed')
        return null
      }

      // Handle 429 — rate limited
      if (resp.status === 429) {
        const retryAfterMs = parseRetryAfter(resp.headers.get('Retry-After'))
        log.warn({ retryAfterMs, attempt }, 'Rate limited by Graph API')
        if (attempt < MAX_RETRIES) {
          await delay(retryAfterMs)
          continue
        }
        log.error('Rate limit retries exhausted')
        return null
      }

      // Handle 404 — item not found (not an error for many operations)
      if (resp.status === 404) {
        log.debug({ url }, 'Graph API 404 — item not found')
        return null
      }

      // Handle other errors
      if (!resp.ok) {
        const text = await resp.text().catch(() => '(no body)')
        log.error({ status: resp.status, body: text.slice(0, 200), url }, 'Graph API error')
        return null
      }

      await delay(API_DELAY_MS)

      // 204 No Content (e.g., DELETE success)
      if (resp.status === 204) {
        return {} as T
      }

      const text = await resp.text()
      if (!text.trim()) return {} as T
      return JSON.parse(text) as T
    }

    return null
  }

  private async refreshToken(): Promise<boolean> {
    const accounts = await this.cache.getAllAccounts()
    if (accounts.length === 0) return false
    try {
      const result = await this.app.acquireTokenSilent({
        account: accounts[0],
        scopes: MS_SCOPES,
      })
      if (result?.accessToken) {
        this.accessToken = result.accessToken
        return true
      }
    } catch {
      log.debug('Token refresh via silent acquisition failed')
    }
    return false
  }

  // ── EmailProvider interface ──────────────────────────────────────────────

  async fetchInbox(sinceHours: number): Promise<EmailMessage[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString()
    const emails: EmailMessage[] = []

    let url: string | null =
      `${this.graphBase}/me/mailFolders/inbox/messages` +
      `?$top=${BATCH_SIZE}` +
      `&$select=id,subject,from,receivedDateTime,bodyPreview` +
      `&$filter=receivedDateTime ge ${since}` +
      `&$orderby=receivedDateTime desc`

    while (url && emails.length < MAX_INBOX_MESSAGES) {
      const data: {
        value?: Array<{
          id: string
          subject?: string
          from?: { emailAddress?: { address?: string } }
          receivedDateTime?: string
          bodyPreview?: string
        }>
        '@odata.nextLink'?: string
      } | null = await this.graphGet(url)

      if (!data) break

      for (const m of data.value ?? []) {
        emails.push({
          messageId: m.id,
          provider: 'hotmail',
          subject: m.subject ?? '',
          sender: (m.from?.emailAddress?.address ?? '').toLowerCase(),
          receivedAt: m.receivedDateTime ?? '',
          bodyPreview: (m.bodyPreview ?? '').slice(0, 200),
        })
      }

      url = data['@odata.nextLink'] ?? null
    }

    log.info({ count: emails.length, sinceHours }, 'Hotmail: fetched inbox')
    return emails
  }

  async listFolders(): Promise<EmailFolder[]> {
    const folders: EmailFolder[] = []

    const data = await this.graphGet<{
      value?: Array<{ id: string; displayName: string }>
    }>(`${this.graphBase}/me/mailFolders?$top=100`)

    if (!data?.value) return folders

    for (const f of data.value) {
      folders.push({ id: f.id, name: f.displayName })

      // Fetch child folders
      const childData = await this.graphGet<{
        value?: Array<{ id: string; displayName: string }>
      }>(`${this.graphBase}/me/mailFolders/${f.id}/childFolders?$top=100`)

      if (childData?.value) {
        for (const c of childData.value) {
          folders.push({ id: c.id, name: c.displayName, parentFolderId: f.id })
        }
      }
    }

    log.info({ count: folders.length }, 'Hotmail: listed folders')
    return folders
  }

  async setupFolders(categories: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const existing = await this.listFolders()
    const existingMap = new Map(existing.map((f) => [f.name, f.id]))

    // Find Inbox folder ID
    const inboxId = existingMap.get('Inbox')
    if (!inboxId) {
      log.error('Cannot find Inbox folder')
      return result
    }

    // Create category folders + "Needs Review" under Inbox
    const allCategories = [...new Set([...categories, 'Needs Review'])].sort()

    for (const cat of allCategories) {
      if (existingMap.has(cat)) {
        result.set(cat, existingMap.get(cat)!)
        continue
      }

      const resp = await this.graphPost<{ id?: string }>(
        `${this.graphBase}/me/mailFolders/${inboxId}/childFolders`,
        { displayName: cat },
      )

      if (resp?.id) {
        result.set(cat, resp.id)
        log.info({ category: cat }, 'Created folder')
      } else {
        log.error({ category: cat }, 'Failed to create folder')
      }
    }

    log.info({ count: result.size }, 'Hotmail: folders ready')
    return result
  }

  async moveEmail(messageId: string, folderId: string): Promise<boolean> {
    const result = await this.graphPost(
      `${this.graphBase}/me/messages/${messageId}/move`,
      { destinationId: folderId },
    )
    return result !== null
  }

  async cleanupSpam(maxAgeDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
    const allFolders = await this.listFolders()
    const folderMap = new Map(allFolders.map((f) => [f.name, f.id]))

    const junkId = folderMap.get('Junk Email')
    const deletedId = folderMap.get('Deleted Items')

    if (!junkId || !deletedId) {
      log.warn('Junk Email or Deleted Items folder not found')
      return 0
    }

    let moved = 0
    let url: string | null =
      `${this.graphBase}/me/mailFolders/${junkId}/messages` +
      `?$top=${BATCH_SIZE}&$select=id` +
      `&$filter=receivedDateTime lt ${cutoff}`

    while (url && moved < MAX_SPAM_CLEANUP) {
      const data: {
        value?: Array<{ id: string }>
        '@odata.nextLink'?: string
      } | null = await this.graphGet(url)

      if (!data) break

      for (const m of data.value ?? []) {
        if (await this.moveEmail(m.id, deletedId)) {
          moved++
        }
      }

      url = data['@odata.nextLink'] ?? null
    }

    if (moved > 0) {
      log.info({ moved }, 'Hotmail: trashed old spam')
    }
    return moved
  }

  async detectCorrections(
    folderMap: Map<string, string>,
  ): Promise<Array<{ messageId: string; oldCategory: string; newCategory: string }>> {
    const corrections: Array<{ messageId: string; oldCategory: string; newCategory: string }> = []

    // Build reverse map: folderId -> category
    const folderIdToCategory = new Map<string, string>()
    for (const [cat, fid] of folderMap) {
      folderIdToCategory.set(fid, cat)
    }

    // For each category folder, check each known message for moves
    for (const [category, folderId] of folderMap) {
      // List messages currently in this folder
      const data = await this.graphGet<{
        value?: Array<{ id: string; parentFolderId?: string }>
      }>(
        `${this.graphBase}/me/mailFolders/${folderId}/messages?$top=${BATCH_SIZE}&$select=id,parentFolderId`,
      )

      if (!data?.value) continue

      for (const m of data.value) {
        // If the message's parentFolderId differs from where we expect it,
        // the user manually moved it
        if (m.parentFolderId && m.parentFolderId !== folderId) {
          const newCategory = folderIdToCategory.get(m.parentFolderId) ?? 'unknown'
          if (newCategory !== category) {
            corrections.push({
              messageId: m.id,
              oldCategory: category,
              newCategory,
            })
          }
        }
      }
    }

    if (corrections.length > 0) {
      log.info({ count: corrections.length }, 'Hotmail: corrections detected')
    }
    return corrections
  }
}
