import { useState } from 'react';
import { Plus, Trash2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { Trigger } from '@/lib/types';

export interface TriggersSectionProps {
  triggers: Trigger[];
  loading: boolean;
  error: string | null;
  onAdd: (name: string, queryText: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function TriggersSection({ triggers, loading, error, onAdd, onDelete }: TriggersSectionProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [queryText, setQueryText] = useState('');
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !queryText.trim()) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      await onAdd(name.trim(), queryText.trim());
      setName('');
      setQueryText('');
      setAdding(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add trigger');
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await onDelete(id);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Semantic Triggers</h2>
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
          <h3 className="text-sm font-medium">New Trigger</h3>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. client-risk-mentions)"
            required
          />
          <Input
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Semantic query (e.g. client escalation risk blowup)"
            required
          />
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={addSubmitting || !name.trim() || !queryText.trim()}>
              {addSubmitting ? 'Adding...' : 'Add Trigger'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {loading && triggers.length === 0 ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : triggers.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <p className="text-sm">No triggers configured.</p>
          <p className="text-xs mt-1">Triggers fire a Pushover notification when a new capture matches a semantic query.</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {triggers.map((trigger) => (
            <div key={trigger.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{trigger.name}</span>
                  <Badge variant={(trigger.is_active ?? trigger.enabled) ? 'default' : 'secondary'} className="text-xs">
                    {(trigger.is_active ?? trigger.enabled) ? 'active' : 'inactive'}
                  </Badge>
                  {trigger.delivery_channel && (
                    <Badge variant="outline" className="text-xs capitalize">{trigger.delivery_channel}</Badge>
                  )}
                </div>
                {trigger.query_text && (
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{trigger.query_text}</p>
                )}
                <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                  {trigger.threshold !== undefined && <span>Threshold: {trigger.threshold}</span>}
                  {trigger.cooldown_minutes !== undefined && <span>Cooldown: {trigger.cooldown_minutes}m</span>}
                  {trigger.fire_count !== undefined && <span>Fired: {trigger.fire_count}x</span>}
                  {trigger.last_fired_at && (
                    <span>Last: {new Date(trigger.last_fired_at).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive shrink-0"
                disabled={deleting === trigger.id}
                onClick={() => handleDelete(trigger.id)}
                aria-label={`Delete trigger ${trigger.name}`}
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
