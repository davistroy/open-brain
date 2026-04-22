/**
 * Open Brain — Manual Service Worker
 *
 * Cache strategy:
 * - Static assets (/_next/static/, /fonts/, /icons/): stale-while-revalidate
 * - API routes (/api/): network-first, no offline serving (stale brain data is worse than none)
 * - Navigation / HTML: network-first, offline fallback to /offline
 * - Manifest / SW itself: network-first (no caching)
 *
 * Bump CACHE_VERSION to bust all caches on deploy.
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `open-brain-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline';

// Assets to pre-cache on install (offline shell).
const PRECACHE_URLS = [OFFLINE_URL];

// ---------------------------------------------------------------------------
// Install — pre-cache offline page
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activate — delete old versioned caches
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith('open-brain-') && key !== STATIC_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — route-based cache strategy
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests (ignore CDN, analytics, etc.)
  if (url.origin !== self.location.origin) return;

  // Never intercept: SW itself or manifest
  if (
    url.pathname === '/sw.js' ||
    url.pathname === '/manifest.json'
  ) {
    return;
  }

  // API routes — network-first, no cache fallback (never serve stale API data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Static assets — stale-while-revalidate
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf|otf)$/)
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Navigation requests (HTML pages) — network-first, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }
});

// ---------------------------------------------------------------------------
// Message — handle SKIP_WAITING from ServiceWorkerRegistration component
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Strategy: network-only (no caching)
// ---------------------------------------------------------------------------
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ error: 'Network unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---------------------------------------------------------------------------
// Strategy: stale-while-revalidate
// Serve cached version immediately; update cache in background.
// ---------------------------------------------------------------------------
async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached ?? (await fetchPromise);
}

// ---------------------------------------------------------------------------
// Strategy: network-first with offline fallback (/offline page)
// ---------------------------------------------------------------------------
async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Opportunistically cache navigation responses for offline fallback
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — try cached version first, then generic offline page
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    const offlinePage = await cache.match(OFFLINE_URL);
    if (offlinePage) return offlinePage;

    // Last resort — minimal inline offline response
    return new Response(
      '<html><body style="font-family:sans-serif;text-align:center;padding:4rem"><h1>You\'re offline</h1><p>Reconnect to continue using Open Brain.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
