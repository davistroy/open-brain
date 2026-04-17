import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { settingsApi } from '@/lib/api';
import type { AutonomyLevel } from '@/lib/types';

const LEVELS: AutonomyLevel[] = ['observe', 'assist', 'advise', 'partner'];

const LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  observe: 'Watches and records. No outbound actions.',
  assist: 'Drafts responses for your review.',
  advise: 'Acts on designated channels, reports what it did.',
  partner: 'Fully autonomous on designated channels.',
};

const UPGRADE_WARNINGS: Record<AutonomyLevel, string | null> = {
  observe: null,
  assist: 'Open Brain will draft responses in Slack threads \u2014 you still approve every action.',
  advise:
    'Open Brain may act on Slack threads and send drafts without asking first. Actions are logged; you can roll back.',
  partner:
    'Open Brain operates fully autonomously on designated channels. High trust level \u2014 review audit log regularly.',
};

function levelRank(level: AutonomyLevel): number {
  return LEVELS.indexOf(level);
}

function isUpgrade(from: AutonomyLevel, to: AutonomyLevel): boolean {
  return levelRank(to) > levelRank(from);
}

export function AutonomyCard(): JSX.Element {
  const [level, setLevel] = useState<AutonomyLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<AutonomyLevel | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await settingsApi.get<AutonomyLevel>('autonomy_level');
        if (!cancelled) {
          setLevel(res.value ?? 'observe');
          setError(null);
        }
      } catch (err) {
        // 404 means unset — fall back to observe (server default)
        const message = err instanceof Error ? err.message : 'Failed to load autonomy level';
        if (!cancelled) {
          if (message.includes('404')) {
            setLevel('observe');
            setError(null);
          } else {
            setError(message);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function commit(newLevel: AutonomyLevel) {
    if (!level || newLevel === level) return;
    const previous = level;
    setSaving(true);
    setBanner(null);
    // Optimistic update
    setLevel(newLevel);
    try {
      await settingsApi.put<AutonomyLevel>('autonomy_level', newLevel);
      setBanner({ kind: 'success', message: `Autonomy set to ${newLevel}.` });
      window.setTimeout(() => setBanner(null), 3000);
    } catch (err) {
      // Revert on error
      setLevel(previous);
      setBanner({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to update autonomy level.',
      });
    } finally {
      setSaving(false);
    }
  }

  function handleSelect(newLevel: AutonomyLevel) {
    if (!level || newLevel === level || saving) return;
    if (isUpgrade(level, newLevel)) {
      setPendingLevel(newLevel);
      return;
    }
    // Moving down — silent
    void commit(newLevel);
  }

  function confirmUpgrade() {
    if (pendingLevel) {
      const target = pendingLevel;
      setPendingLevel(null);
      void commit(target);
    }
  }

  function cancelUpgrade() {
    setPendingLevel(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Autonomy level</CardTitle>
        <CardDescription>Controls how proactively Open Brain acts on your behalf</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2" data-testid="autonomy-skeleton">
            <div className="h-10 animate-pulse rounded bg-secondary" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-secondary" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <>
            <div
              role="radiogroup"
              aria-label="Autonomy level"
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {LEVELS.map((opt) => {
                const selected = level === opt;
                return (
                  <Button
                    key={opt}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    variant={selected ? 'default' : 'outline'}
                    disabled={saving}
                    onClick={() => handleSelect(opt)}
                    className="capitalize"
                  >
                    {opt}
                  </Button>
                );
              })}
            </div>

            {level && (
              <p className="text-sm text-muted-foreground">{LEVEL_DESCRIPTIONS[level]}</p>
            )}

            {banner && (
              <div
                className={
                  banner.kind === 'success'
                    ? 'rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground'
                    : 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'
                }
              >
                {banner.message}
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={pendingLevel !== null} onOpenChange={(open) => !open && cancelUpgrade()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
              Raise autonomy to {pendingLevel}?
            </DialogTitle>
            <DialogDescription>This gives Open Brain more authority to act on your behalf.</DialogDescription>
          </DialogHeader>
          {pendingLevel && UPGRADE_WARNINGS[pendingLevel] && (
            <div className="rounded-md border border-yellow-500 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-300">
              {UPGRADE_WARNINGS[pendingLevel]}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={cancelUpgrade} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={confirmUpgrade} disabled={saving}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
