const STORAGE_KEY = 'ob-theme';

export type Theme = 'light' | 'dark' | 'system';

/**
 * Read the stored theme preference from localStorage.
 * Defaults to 'system' if nothing is stored.
 */
export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (SSR, iframe sandbox, etc.)
  }
  return 'system';
}

/**
 * Resolve the effective theme (always 'light' or 'dark').
 * If the preference is 'system', check prefers-color-scheme.
 */
export function resolveTheme(preference: Theme): 'light' | 'dark' {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return preference;
}

/**
 * Apply the theme by toggling the 'dark' class on <html>.
 */
function applyToDOM(effective: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (effective === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

/**
 * Save the theme preference and apply it to the DOM.
 */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore write failures
  }
  applyToDOM(resolveTheme(theme));
}

/**
 * Initialize the theme on app startup.
 * Call this as early as possible to avoid a flash of wrong theme.
 */
export function initTheme(): void {
  const preference = getTheme();
  applyToDOM(resolveTheme(preference));

  // Listen for OS-level theme changes when preference is 'system'
  if (preference === 'system') {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e) => {
        // Only react if the user hasn't since set an explicit preference
        if (getTheme() === 'system') {
          applyToDOM(e.matches ? 'dark' : 'light');
        }
      });
  }
}
