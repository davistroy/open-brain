import { useState } from 'react';
import { Plus, Trash2, AlertCircle, Mail, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface EmailAllowlistSectionProps {
  entries: string[];
  loading: boolean;
  error: string | null;
  onAdd: (entry: string) => Promise<void>;
  onRemove: (entry: string) => Promise<void>;
}

function validateEntry(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return 'Entry cannot be empty';
  if (trimmed.startsWith('@')) {
    // Domain pattern: @example.com
    if (!/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) return 'Invalid domain format. Use @example.com';
    return null;
  }
  // Email address
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Invalid email address';
  return null;
}

export function EmailAllowlistSection({ entries, loading, error, onAdd, onRemove }: EmailAllowlistSectionProps) {
  const [adding, setAdding] = useState(false);
  const [newEntry, setNewEntry] = useState('');
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newEntry.trim().toLowerCase();
    const validationError = validateEntry(trimmed);
    if (validationError) {
      setAddError(validationError);
      return;
    }
    if (entries.includes(trimmed)) {
      setAddError('Already in the allowlist');
      return;
    }
    setAddSubmitting(true);
    setAddError(null);
    try {
      await onAdd(trimmed);
      setNewEntry('');
      setAdding(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add entry');
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleRemove(entry: string) {
    setRemoving(entry);
    try {
      await onRemove(entry);
    } catch {
      setAddError('Failed to remove entry — please try again');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Email Allowlist</h2>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <p>Controls which senders can create captures via <strong>brain@troy-davis.com</strong>.</p>
                <p className="mt-1">Enter a full email address (e.g. <code className="text-xs bg-muted px-1 rounded">user@example.com</code>) for exact matching, or a domain starting with <code className="text-xs bg-muted px-1 rounded">@</code> (e.g. <code className="text-xs bg-muted px-1 rounded">@example.com</code>) to allow all addresses from that domain.</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {adding && (
        <form onSubmit={handleAdd} className="rounded-lg border bg-card p-4 space-y-3">
          <h3 className="text-sm font-medium">Add Allowed Sender</h3>
          <Input
            value={newEntry}
            onChange={(e) => { setNewEntry(e.target.value); setAddError(null); }}
            placeholder="user@example.com or @example.com"
            required
            autoFocus
          />
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={addSubmitting || !newEntry.trim()}>
              {addSubmitting ? 'Adding...' : 'Add'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setAddError(null); }}>Cancel</Button>
          </div>
        </form>
      )}

      {loading && entries.length === 0 ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <p className="text-sm">No allowed senders configured.</p>
          <p className="text-xs mt-1">All emails to brain@troy-davis.com will be rejected until you add at least one entry.</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {entries.map((entry) => (
            <div key={entry} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm font-mono truncate">{entry}</span>
                <Badge variant={entry.startsWith('@') ? 'secondary' : 'outline'} className="text-xs shrink-0">
                  {entry.startsWith('@') ? 'domain' : 'exact'}
                </Badge>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive shrink-0"
                disabled={removing === entry}
                onClick={() => handleRemove(entry)}
                aria-label={`Remove ${entry}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
