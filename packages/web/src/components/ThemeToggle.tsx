import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTheme, setTheme, resolveTheme, type Theme } from '@/lib/theme';

const CYCLE: Theme[] = ['system', 'light', 'dark'];

function nextTheme(current: Theme): Theme {
  const idx = CYCLE.indexOf(current);
  return CYCLE[(idx + 1) % CYCLE.length];
}

function ThemeIcon({ theme }: { theme: Theme }) {
  const effective = theme === 'system' ? null : theme;

  if (effective === null) return <Monitor className="h-4 w-4" />;
  if (effective === 'dark') return <Moon className="h-4 w-4" />;
  return <Sun className="h-4 w-4" />;
}

function themeLabel(theme: Theme): string {
  if (theme === 'system') return 'System theme';
  if (theme === 'dark') return 'Dark mode';
  return 'Light mode';
}

export default function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);

  // Sync with the resolved effective theme on mount
  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  function handleToggle() {
    const next = nextTheme(theme);
    setTheme(next);
    setThemeState(next);
  }

  // Determine what icon to show: for 'system', show the resolved icon
  const displayTheme: 'light' | 'dark' | 'system' = theme === 'system' ? 'system' : resolveTheme(theme);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggle}
      className="gap-2 w-full justify-start text-muted-foreground"
      title={themeLabel(theme)}
      aria-label={themeLabel(theme)}
    >
      <ThemeIcon theme={displayTheme} />
      <span className="text-sm">{themeLabel(theme)}</span>
    </Button>
  );
}
