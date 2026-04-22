'use client';

import { useEffect, useState } from 'react';

// The beforeinstallprompt event is non-standard — extend Window type locally.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = 'open-brain-pwa-install-dismissed';

/**
 * PwaInstallPrompt — shows a dismissible "Add to Home Screen" banner when the
 * browser fires the `beforeinstallprompt` event.
 *
 * Dismissal is stored in localStorage — banner does not reappear after dismiss.
 * The prompt is only available on Android Chrome and desktop Chromium; Safari
 * on iOS uses the native Share → Add to Home Screen flow (no JS API).
 *
 * Renders null when the prompt is unavailable or dismissed.
 */
export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true); // true until we confirm not dismissed

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Check if previously dismissed.
    const alreadyDismissed = localStorage.getItem(DISMISS_KEY) === 'true';
    if (alreadyDismissed) return;

    setDismissed(false);

    function handleBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // If the app is already installed, hide the banner.
    window.addEventListener('appinstalled', () => {
      setDeferredPrompt(null);
    });

    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt
      );
    };
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  }

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, 'true');
    setDismissed(true);
    setDeferredPrompt(null);
  }

  // Nothing to show
  if (dismissed || !deferredPrompt) return null;

  return (
    <div
      role="banner"
      aria-label="Install Open Brain app"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border border-[#d9c9bc] bg-[#faf7f2] text-[13px] max-w-sm w-[calc(100%-2rem)]"
    >
      {/* Book-cloth brand dot */}
      <span
        className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: '#4a3728' }}
        aria-hidden="true"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4 3h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
            stroke="#faf7f2"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M9 6v6M6 9h6"
            stroke="#faf7f2"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-medium text-[#4a3728] leading-tight">
          Install Open Brain
        </p>
        <p className="text-[#6b5a4e] text-[12px] leading-snug truncate">
          Add to your home screen for quick access
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleInstall}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-[#faf7f2] leading-none"
          style={{ backgroundColor: '#4a3728' }}
        >
          Install
        </button>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss install prompt"
          className="p-1 rounded-md text-[#6b5a4e] hover:text-[#4a3728] hover:bg-[#ede6df] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M11 3 3 11M3 3l8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
