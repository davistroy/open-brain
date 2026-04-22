'use client';

import { useEffect } from 'react';

/**
 * ServiceWorkerRegistration — registers /sw.js on mount.
 *
 * Lifecycle:
 * - Registers the SW on first load (no-op if already registered).
 * - Polls for waiting SW updates on every page focus (background tab → foreground).
 * - When a new SW is waiting, reloads the page once it activates so users
 *   automatically get the updated version without a manual hard-refresh.
 *   (Addresses the aggressive-cache lesson from the old /web Vite PWA.)
 *
 * This component renders nothing — mount it once in a layout.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;

    async function register() {
      try {
        registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        });

        // Listen for a new SW entering the "waiting" state.
        registration.addEventListener('updatefound', () => {
          const installing = registration?.installing;
          if (!installing) return;

          installing.addEventListener('statechange', () => {
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              // A new SW is ready. Tell it to skip waiting, then reload.
              installing.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      } catch (err) {
        // SW registration failures are non-fatal — app still works without SW.
        if (process.env.NODE_ENV === 'development') {
          console.warn('[SW] Registration failed:', err);
        }
      }
    }

    // Reload when the controlling SW changes (i.e. after skipWaiting).
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    register();

    // Check for updates whenever the tab regains focus.
    function checkForUpdate() {
      registration?.update().catch(() => {
        // Ignore — network may be unavailable.
      });
    }

    window.addEventListener('focus', checkForUpdate);
    return () => {
      window.removeEventListener('focus', checkForUpdate);
    };
  }, []);

  return null;
}
