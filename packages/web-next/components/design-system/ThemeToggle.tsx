'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

// ---------------------------------------------------------------------------
// ThemeToggle — three-state light/dark/system theme picker
//
// Persistence: localStorage key 'theme' → 'light' | 'dark' | 'system'
// Absent key = system (first visit follows OS preference).
//
// Anti-flash: layout.tsx injects an inline script that reads localStorage
// and adds/removes the `dark` class on <html> before first paint.
// ThemeToggle keeps the UI button in sync with that state.
// ---------------------------------------------------------------------------

type ThemeValue = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';

/** Apply or remove the `dark` class on <html> based on resolved preference. */
function applyTheme(value: ThemeValue): void {
  const root = document.documentElement;
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = value === 'system' ? (prefersDark ? 'dark' : 'light') : value;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

/** Cycle order: light → dark → system → light */
const CYCLE: ThemeValue[] = ['light', 'dark', 'system'];

const LABELS: Record<ThemeValue, string> = {
  light: 'Light mode',
  dark: 'Dark mode',
  system: 'System theme',
};

const ICONS: Record<ThemeValue, React.ElementType> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<ThemeValue>('system');
  const [mounted, setMounted] = useState(false);

  // Read initial value from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeValue | null;
    setTheme(stored ?? 'system');
    setMounted(true);
  }, []);

  // Keep `dark` class in sync whenever theme state changes
  useEffect(() => {
    if (!mounted) return;
    applyTheme(theme);
  }, [theme, mounted]);

  // Also listen for OS preference changes when in 'system' mode
  useEffect(() => {
    if (!mounted) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (theme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, mounted]);

  function cycleTheme() {
    const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  // Render a stable placeholder before mount to avoid hydration mismatch
  if (!mounted) {
    return (
      <button
        aria-label="Toggle theme"
        className={[
          'relative p-[7px] cursor-pointer',
          'text-cloud-light hover:bg-[rgba(255,255,255,0.06)]',
          'transition-colors duration-moderate',
          'border-none bg-transparent outline-none',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        disabled
      >
        <Moon size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    );
  }

  const Icon = ICONS[theme];
  const label = LABELS[theme];

  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-label={`${label} — click to cycle theme`}
      title={label}
      className={[
        'relative p-[7px] cursor-pointer',
        'text-cloud-light hover:bg-[rgba(255,255,255,0.06)]',
        'transition-colors duration-moderate',
        'border-none bg-transparent outline-none',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-book-cloth',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
