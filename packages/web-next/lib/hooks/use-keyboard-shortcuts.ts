'use client';

/**
 * useKeyboardShortcuts — global keyboard navigation hook.
 *
 * Chord detection:
 *   On first keypress (e.g. 'g'), the key is stored in a ref and a 500ms timer
 *   is started. If a second key arrives within that window, the chord (e.g. 'gd')
 *   is matched against the routing table. The ref is cleared after the timeout or
 *   after a successful match.
 *
 * Shortcuts:
 *   g d → /dashboard
 *   g e → /entities
 *   g b → /briefs
 *   g s → /search
 *   g t → /timeline
 *   /   → focus search input (data-search-input attribute)
 *   ?   → open shortcuts help modal (calls onOpenHelp callback)
 *
 * Guards:
 *   - Disabled when active element is input, textarea, select, or contenteditable.
 *   - Does not fire when modifier keys (Ctrl, Alt, Meta) are held, except Shift
 *     which is needed for '?' (Shift+/).
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyboardShortcutsConfig {
  /** Called when the user presses '?' — should open the shortcuts help modal. */
  onOpenHelp: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the currently focused element is a text-entry surface.
 * In those cases we suppress all shortcuts to avoid interfering with typing.
 */
function isEditingContext(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

// Chord routing table: chord string → path
const CHORD_ROUTES: Record<string, string> = {
  gd: '/dashboard',
  ge: '/entities',
  gb: '/briefs',
  gs: '/search',
  gt: '/timeline',
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Attaches a global keydown listener to document and handles chord detection.
 * Mount this hook once in the shell layout via a thin client wrapper.
 *
 * @param config - Config object. `onOpenHelp` is called when '?' is pressed.
 */
export function useKeyboardShortcuts(config: KeyboardShortcutsConfig): void {
  const { onOpenHelp } = config;
  const router = useRouter();

  // Pending first-key of a chord. Null when no chord is in progress.
  const pendingKeyRef = useRef<string | null>(null);
  // Timer handle for chord timeout.
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a stable ref to onOpenHelp so the listener closure doesn't go stale.
  const onOpenHelpRef = useRef(onOpenHelp);
  useEffect(() => {
    onOpenHelpRef.current = onOpenHelp;
  }, [onOpenHelp]);

  useEffect(() => {
    function clearChord() {
      pendingKeyRef.current = null;
      if (chordTimerRef.current !== null) {
        clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      // Ignore when modifier keys are held (except Shift, needed for '?').
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      // Suppress shortcuts in text-editing contexts.
      if (isEditingContext()) return;

      const key = event.key;

      // ---------------------------------------------------------------------------
      // '?' — open shortcuts help modal (Shift+/ on US keyboard)
      // ---------------------------------------------------------------------------
      if (key === '?') {
        event.preventDefault();
        clearChord();
        onOpenHelpRef.current();
        return;
      }

      // ---------------------------------------------------------------------------
      // '/' — focus the search input
      // ---------------------------------------------------------------------------
      if (key === '/') {
        event.preventDefault();
        clearChord();
        const searchInput = document.querySelector<HTMLElement>('[data-search-input]');
        if (searchInput) {
          searchInput.focus();
        }
        return;
      }

      // ---------------------------------------------------------------------------
      // Chord detection
      // ---------------------------------------------------------------------------
      if (pendingKeyRef.current !== null) {
        // We have a pending first key. Attempt to match the chord.
        const chord = pendingKeyRef.current + key;
        clearChord();

        const route = CHORD_ROUTES[chord];
        if (route) {
          event.preventDefault();
          router.push(route);
        }
        // If the chord is not recognised, silently discard — the second key
        // may have been meant as a new first-key, so set it as pending.
        // Only do this for 'g' (our only chord leader) to avoid confusion.
        // For unrecognised chords we just drop both keys.
        return;
      }

      // No pending chord. Check if this key is a chord leader ('g').
      if (key === 'g') {
        event.preventDefault();
        pendingKeyRef.current = 'g';
        chordTimerRef.current = setTimeout(clearChord, 500);
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Clear any in-flight chord timer on unmount.
      if (chordTimerRef.current !== null) {
        clearTimeout(chordTimerRef.current);
      }
    };
  }, [router]);
}
