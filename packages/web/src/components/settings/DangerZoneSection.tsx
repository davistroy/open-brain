import { useState } from 'react';
import { Trash2, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi } from '@/lib/api';

const CONFIRM_PHRASE = 'WIPE ALL DATA';

export function DangerZoneSection() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [wiping, setWiping] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const confirmed = confirmText === CONFIRM_PHRASE;

  function handleOpen() {
    setOpen(true);
    setConfirmText('');
    setResult(null);
  }

  function handleClose() {
    setOpen(false);
    setConfirmText('');
  }

  async function handleWipe() {
    setWiping(true);
    setResult(null);
    try {
      const res = await adminApi.resetData();
      setResult({
        success: true,
        message: `Wiped ${res.cleared.length} tables. The brain is empty \u2014 ready for real data.`,
      });
      handleClose();
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : 'Wipe failed' });
    } finally {
      setWiping(false);
    }
  }

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Wipe All Data</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently deletes all captures, entities, sessions, briefs, bets, and AI audit logs.
                Schema, migration history, and semantic triggers are preserved. Cannot be undone.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleOpen}
              className="shrink-0 gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Wipe All Data
            </Button>
          </div>
          {result && (
            <div className={`flex items-center gap-2 rounded px-3 py-2 text-sm border ${
              result.success
                ? 'bg-green-50 text-green-800 border-green-200'
                : 'bg-destructive/10 text-destructive border-destructive/30'
            }`}>
              {result.success
                ? <CheckCircle className="h-4 w-4 shrink-0" />
                : <AlertCircle className="h-4 w-4 shrink-0" />}
              {result.message}
            </div>
          )}
        </div>
      </section>

      {/* Confirmation modal — rendered at root level to avoid layout clipping */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-destructive/10 p-2 shrink-0">
                <AlertCircle className="h-5 w-5 text-destructive" />
              </div>
              <h3 className="text-base font-semibold">Wipe All Data?</h3>
            </div>

            <p className="text-sm text-muted-foreground">The following will be <strong>permanently deleted</strong>:</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>All captures and embeddings</li>
              <li>All entities and relationships</li>
              <li>All governance sessions and messages</li>
              <li>All weekly briefs (skills log)</li>
              <li>All AI audit logs and bets</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              <strong>Preserved:</strong> semantic triggers, schema, migration history.
            </p>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">
                Type{' '}
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{CONFIRM_PHRASE}</span>
                {' '}to confirm:
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="font-mono"
                autoFocus
                onKeyDown={(e) => e.key === 'Escape' && handleClose()}
              />
            </div>

            {result && !result.success && (
              <div className="flex items-center gap-2 rounded px-3 py-2 text-sm border bg-destructive/10 text-destructive border-destructive/30">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {result.message}
              </div>
            )}

            <div className="flex gap-2 justify-end pt-1">
              <Button variant="ghost" size="sm" onClick={handleClose} disabled={wiping}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!confirmed || wiping}
                onClick={handleWipe}
              >
                {wiping ? 'Wiping...' : 'Confirm Wipe'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
