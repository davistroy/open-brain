/**
 * Smoke test: QuickCapture → Dashboard refresh
 *
 * Golden-path E2E covering the full stack:
 *   Next.js dev (port 3001) → api-client → core-api (port 3002)
 *   → POST /api/v1/captures → SSE capture_created → Query invalidate
 *   → Dashboard refetch → new capture visible in Recent activity list
 *
 * Prerequisites (not started by this test):
 *   docker compose up -d postgres redis core-api
 *
 * Run:
 *   pnpm --filter @open-brain/web-next test:e2e
 *
 * The test fails gracefully with a clear SKIP message if core-api is
 * unreachable, rather than timing out or emitting cryptic assertion errors.
 */

import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORE_API_HEALTH = 'http://localhost:3002/api/v1/captures?limit=1'
const DASHBOARD_URL = 'http://localhost:3001/dashboard'

/**
 * Return true if core-api is reachable. Uses a simple GET to a known
 * cheap endpoint rather than /health (Docker-internal only per CLAUDE.md).
 */
async function isCoreApiReachable(page: Page): Promise<boolean> {
  try {
    const response = await page.request.get(CORE_API_HEALTH, { timeout: 3_000 })
    return response.ok()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe('QuickCapture smoke test', () => {
  test('submits a capture and it appears in Recent activity', async ({ page }) => {
    // ------------------------------------------------------------------
    // Pre-flight: skip gracefully if core-api is unreachable.
    // This lets the test suite pass in CI environments that don't spin
    // up the full stack; it signals clearly why the test was skipped.
    // ------------------------------------------------------------------
    const reachable = await isCoreApiReachable(page)
    if (!reachable) {
      test.skip(true, [
        'core-api is unreachable at localhost:3002.',
        'Start the backend stack before running E2E tests:',
        '  docker compose up -d postgres redis core-api',
      ].join(' '))
      return
    }

    // ------------------------------------------------------------------
    // Step 1: Navigate to dashboard — verify it renders
    // ------------------------------------------------------------------
    await page.goto(DASHBOARD_URL)

    // The page header contains the text "Dashboard" in the breadcrumb.
    // This is the lightest assertion that the shell + dashboard page
    // rendered without a 500 or redirect.
    await expect(page.getByText('Dashboard', { exact: false })).toBeVisible({ timeout: 10_000 })

    // ------------------------------------------------------------------
    // Step 2: Locate the QuickCapture textarea and fill it
    // ------------------------------------------------------------------
    const uniqueContent = `Smoke test capture ${randomUUID()}`

    // QuickCapture renders a <textarea> with placeholder "What's on your mind?"
    // No data-testid exists in M1; locate by placeholder (resilient to DOM
    // structure changes, since QuickCapture is the only textarea on the page).
    const textarea = page.getByPlaceholder("What's on your mind?")
    await expect(textarea).toBeVisible({ timeout: 5_000 })
    await textarea.fill(uniqueContent)

    // ------------------------------------------------------------------
    // Step 3: Click Capture button and wait for POST /api/v1/captures
    // ------------------------------------------------------------------

    // Arm the response waiter before clicking to avoid a race where the
    // request resolves before waitForResponse is registered.
    const captureResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/captures') &&
        response.request().method() === 'POST',
      { timeout: 10_000 },
    )

    // The Capture button is a <button> with text "Capture" and is only
    // enabled when textarea has content (disabled={!text.trim()}).
    const captureButton = page.getByRole('button', { name: 'Capture', exact: true })
    await expect(captureButton).toBeEnabled()
    await captureButton.click()

    // Wait for the POST response — this validates the api-client wiring
    // and the Next.js rewrite proxy (/api → core-api).
    const captureResponse = await captureResponsePromise
    expect(captureResponse.status()).toBe(201)

    const captureBody = await captureResponse.json() as { id: string; pipeline_status: string; created_at: string }
    expect(captureBody.id).toBeTruthy()
    expect(captureBody.pipeline_status).toBeTruthy()

    // ------------------------------------------------------------------
    // Step 4: Wait for the new capture to appear in Recent activity
    //
    // The SSE connection (SSEProvider) receives a `capture_created` event
    // from core-api pg-notify bridge, invalidates the 'captures' query
    // key, and TanStack Query refetches the list. RecentCaptures renders
    // the top 8 rows; the new capture should be first (newest-first).
    //
    // Timeout: 5s — SSE delivery + refetch is typically <500ms on localhost.
    // ------------------------------------------------------------------
    await expect(
      page.getByText(uniqueContent, { exact: false }),
    ).toBeVisible({ timeout: 5_000 })

    // ------------------------------------------------------------------
    // Step 5: Assert content matches exactly what was submitted
    // ------------------------------------------------------------------
    // The RecentCaptures row renders: capture.title ?? capture.content.slice(0, 60)
    // For a new API capture without an extracted title, content is shown.
    // We match a substring (first 60 chars) since the full UUID content
    // is 38 + prefix chars and truncation applies at 60.
    const expectedPrefix = uniqueContent.slice(0, 59) // stay inside truncation boundary
    const captureRow = page.getByText(expectedPrefix, { exact: false })
    await expect(captureRow).toBeVisible()
  })
})
