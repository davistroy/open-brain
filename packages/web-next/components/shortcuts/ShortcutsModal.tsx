'use client';

/**
 * ShortcutsModal — keyboard shortcuts reference dialog.
 *
 * Opened by pressing '?' anywhere in the shell (except inside text inputs).
 * Implemented with Radix Dialog so Escape + click-outside close automatically.
 *
 * Client component.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { Keyboard, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShortcutsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Shortcut definitions
// ---------------------------------------------------------------------------

interface ShortcutEntry {
  keys: string[];
  description: string;
  section: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  // Navigation chords
  { keys: ['g', 'd'], description: 'Go to Dashboard', section: 'Navigation' },
  { keys: ['g', 'e'], description: 'Go to Entities', section: 'Navigation' },
  { keys: ['g', 'b'], description: 'Go to Briefs', section: 'Navigation' },
  { keys: ['g', 's'], description: 'Go to Search', section: 'Navigation' },
  { keys: ['g', 't'], description: 'Go to Timeline', section: 'Navigation' },
  // Actions
  { keys: ['/'], description: 'Focus search input', section: 'Actions' },
  { keys: ['?'], description: 'Show this help', section: 'Actions' },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface KbdProps {
  children: string;
}

function Kbd({ children }: KbdProps) {
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 22,
        height: 22,
        padding: '0 6px',
        background: 'var(--color-cloud-light)',
        border: '1px solid var(--color-cloud-medium)',
        borderBottomWidth: 2,
        fontFamily: 'var(--font-family-monospace)',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.03em',
        color: 'var(--color-text-heading)',
        lineHeight: 1,
      }}
    >
      {children}
    </kbd>
  );
}

interface ShortcutRowProps {
  entry: ShortcutEntry;
}

function ShortcutRow({ entry }: ShortcutRowProps) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--color-cloud-light)' }}
    >
      <span
        className="text-text-body"
        style={{ fontFamily: 'var(--font-family-base)', fontSize: 13 }}
      >
        {entry.description}
      </span>
      <div className="flex items-center gap-[4px]" style={{ flexShrink: 0, marginLeft: 24 }}>
        {entry.keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShortcutsModal
// ---------------------------------------------------------------------------

/**
 * Radix Dialog listing all keyboard shortcuts grouped by section.
 * Escape and click-outside close the dialog automatically via Radix defaults.
 */
export function ShortcutsModal({ open, onOpenChange }: ShortcutsModalProps) {
  // Group shortcuts by section
  const sections = Array.from(new Set(SHORTCUTS.map((s) => s.section)));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Overlay */}
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0, 0, 0, 0.45)' }}
        />

        {/* Content panel */}
        <Dialog.Content
          className="fixed z-50 bg-bg-container border border-cloud-medium"
          style={{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '100%',
            maxWidth: 480,
            maxHeight: '80vh',
            overflow: 'auto',
            padding: '28px 28px 24px',
            outline: 'none',
          }}
          aria-describedby="shortcuts-desc"
        >
          {/* Header */}
          <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
            <div className="flex items-center gap-[10px]">
              <Keyboard
                size={15}
                strokeWidth={1.5}
                style={{ color: 'var(--color-book-cloth)' }}
              />
              <Dialog.Title
                className="text-text-heading"
                style={{
                  fontFamily: 'var(--font-family-display)',
                  fontSize: 18,
                  fontWeight: 300,
                  letterSpacing: '-0.01em',
                  margin: 0,
                }}
              >
                Keyboard shortcuts
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                className="flex items-center justify-center bg-transparent border-none cursor-pointer"
                aria-label="Close"
                style={{ padding: 4, color: 'var(--color-text-body-secondary)' }}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          <p
            id="shortcuts-desc"
            className="text-text-body-secondary"
            style={{ fontSize: 12.5, marginBottom: 20, lineHeight: 1.5 }}
          >
            Shortcuts are disabled when a text field is focused. Chord shortcuts (e.g.{' '}
            <Kbd>g</Kbd> then <Kbd>d</Kbd>) require both keys within 500 ms.
          </p>

          {/* Sections */}
          {sections.map((section) => (
            <div key={section} style={{ marginBottom: 24 }}>
              <div
                style={{
                  fontFamily: 'var(--font-family-monospace)',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--color-text-body-secondary)',
                  marginBottom: 8,
                }}
              >
                {section}
              </div>
              {SHORTCUTS.filter((s) => s.section === section).map((entry, i) => (
                <ShortcutRow key={i} entry={entry} />
              ))}
            </div>
          ))}

          {/* Footer close */}
          <div className="flex justify-end" style={{ marginTop: 8 }}>
            <Dialog.Close asChild>
              <button
                className="bg-transparent border border-cloud-medium text-text-body"
                style={{
                  padding: '7px 16px',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-family-base)',
                }}
              >
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
