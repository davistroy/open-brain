'use client';

/**
 * ShortcutsProvider — thin client wrapper that mounts the keyboard shortcuts
 * hook and manages the help modal state.
 *
 * The shell layout (RSC) renders this as a child. Because it is a client
 * component it can safely use `useState` and `useEffect` while the parent
 * layout remains a server component.
 *
 * Client component.
 */

import { useState, useCallback, type ReactNode } from 'react';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { ShortcutsModal } from '@/components/shortcuts/ShortcutsModal';

interface ShortcutsProviderProps {
  children?: ReactNode;
}

/**
 * Mounts the keyboard shortcuts hook and the help modal.
 * Renders no visible UI of its own — just the modal (which is hidden until '?'
 * is pressed) and any children passed through.
 */
export function ShortcutsProvider({ children }: ShortcutsProviderProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  const handleOpenHelp = useCallback(() => {
    setHelpOpen(true);
  }, []);

  useKeyboardShortcuts({ onOpenHelp: handleOpenHelp });

  return (
    <>
      {children}
      <ShortcutsModal open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}
