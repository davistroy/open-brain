import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { entitiesApi } from '@/lib/api';
import type { Entity, Capture } from '@/lib/types';
import { cn } from '@/lib/utils';

// --- Shared type colors (mirrors Entities.tsx) ---
const TYPE_COLORS: Record<string, string> = {
  person: 'bg-sky-100 text-sky-800 border-sky-200',
  org: 'bg-amber-100 text-amber-800 border-amber-200',
  concept: 'bg-violet-100 text-violet-800 border-violet-200',
  decision: 'bg-rose-100 text-rose-800 border-rose-200',
  project: 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

const VIEW_COLORS: Record<string, string> = {
  career: 'bg-blue-100 text-blue-800 border-blue-200',
  personal: 'bg-green-100 text-green-800 border-green-200',
  technical: 'bg-purple-100 text-purple-800 border-purple-200',
  'work-internal': 'bg-orange-100 text-orange-800 border-orange-200',
  client: 'bg-red-100 text-red-800 border-red-200',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return formatDate(iso);
}

// --- Entity card ---
function EntityCard({ entity }: { entity: Entity }) {
  const typeCls = TYPE_COLORS[entity.type] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-xl">{entity.name}</CardTitle>
            {entity.aliases.length > 0 && (
              <p className="text-sm text-muted-foreground mt-1">
                Aliases: {entity.aliases.join(', ')}
              </p>
            )}
          </div>
          <Badge variant="outline" className={cn('shrink-0 border', typeCls)}>
            {entity.type}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold">{entity.mention_count ?? entity.capture_count}</div>
            <div className="text-xs text-muted-foreground">mentions</div>
          </div>
          <div>
            <div className="text-sm font-medium">{formatRelative(entity.last_seen)}</div>
            <div className="text-xs text-muted-foreground">last seen</div>
          </div>
          <div>
            <div className="text-sm font-medium">{formatDate(entity.first_seen)}</div>
            <div className="text-xs text-muted-foreground">first seen</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Capture row ---
function CaptureRow({ capture }: { capture: Capture }) {
  const viewCls = VIEW_COLORS[capture.brain_view] ?? 'bg-gray-100 text-gray-800 border-gray-200';
  return (
    <div className="py-3 border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <span className="text-xs text-muted-foreground">{formatDate(capture.created_at)}</span>
        <Badge variant="outline" className={cn('text-xs border', viewCls)}>
          {capture.brain_view}
        </Badge>
        <Badge variant="secondary" className="text-xs capitalize">
          {capture.capture_type}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed line-clamp-3">{capture.content}</p>
    </div>
  );
}

// --- Co-occurrence graph (related entities derived from shared captures) ---
function CoOccurrencePanel({ captures }: { captures: Capture[] }) {
  const countMap = new Map<string, { entity: { id: string; name: string; type: string }; count: number }>();

  for (const capture of captures) {
    for (const e of (capture.entities ?? [])) {
      const existing = countMap.get(e.id);
      if (existing) {
        existing.count += 1;
      } else {
        countMap.set(e.id, { entity: e, count: 1 });
      }
    }
  }

  const related = Array.from(countMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  if (related.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Related Entities</CardTitle>
        <p className="text-xs text-muted-foreground">Co-occurs in same captures</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {related.map(({ entity, count }) => {
            const typeCls = TYPE_COLORS[entity.type] ?? 'bg-gray-100 text-gray-700 border-gray-200';
            return (
              <Link
                key={entity.id}
                to={`/entities/${entity.id}`}
                className="flex items-center gap-1.5 px-2 py-1 rounded-full border text-xs transition-colors hover:bg-accent"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className={cn('inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] border', typeCls)}>
                  {entity.type}
                </span>
                <span className="font-medium">{entity.name}</span>
                <span className="text-muted-foreground">{count}</span>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Merge modal ---
function MergeModal({
  entity,
  onClose,
  onMerge,
}: {
  entity: Entity;
  onClose: () => void;
  onMerge: (targetId: string) => Promise<void>;
}) {
  const [targetId, setTargetId] = useState('');
  const [merging, setMerging] = useState(false);
  const [err, setErr] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId.trim()) return;
    setMerging(true);
    setErr('');
    try {
      await onMerge(targetId.trim());
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card rounded-lg border p-6 w-full max-w-sm shadow-lg">
        <h2 className="text-lg font-semibold mb-1">Merge Entity</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Merge <strong>{entity.name}</strong> into another entity. This transfers all mentions
          and aliases to the target.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            placeholder="Target entity ID"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            autoFocus
          />
          {err && <p className="text-destructive text-xs">{err}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={merging}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" size="sm" disabled={merging || !targetId.trim()}>
              {merging ? 'Merging...' : 'Merge'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Split modal ---
function SplitModal({
  entity,
  onClose,
  onSplit,
}: {
  entity: Entity;
  onClose: () => void;
  onSplit: (alias: string) => Promise<void>;
}) {
  const [alias, setAlias] = useState('');
  const [splitting, setSplitting] = useState(false);
  const [err, setErr] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!alias.trim()) return;
    setSplitting(true);
    setErr('');
    try {
      await onSplit(alias.trim());
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Split failed');
    } finally {
      setSplitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card rounded-lg border p-6 w-full max-w-sm shadow-lg">
        <h2 className="text-lg font-semibold mb-1">Split Entity</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Split an alias of <strong>{entity.name}</strong> into a new independent entity.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          >
            <option value="">Select alias to split out</option>
            {entity.aliases.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          {err && <p className="text-destructive text-xs">{err}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={splitting}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={splitting || !alias}>
              {splitting ? 'Splitting...' : 'Split'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Main page ---
export default function EntityDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [entity, setEntity] = useState<Entity | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loadingEntity, setLoadingEntity] = useState(true);
  const [loadingCaptures, setLoadingCaptures] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showMerge, setShowMerge] = useState(false);
  const [showSplit, setShowSplit] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoadingEntity(true);
    entitiesApi
      .get(id)
      .then((res) => {
        setEntity(res);
        if (res.captures) {
          setCaptures(res.captures);
          setLoadingCaptures(false);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Entity not found'))
      .finally(() => setLoadingEntity(false));

    setLoadingCaptures(true);
    entitiesApi
      .getCaptures(id)
      .then((res) => setCaptures(res.data))
      .catch(() => {/* captures may come from get() instead */})
      .finally(() => setLoadingCaptures(false));
  }, [id]);

  const handleMerge = async (targetId: string) => {
    if (!entity) return;
    await entitiesApi.merge(entity.id, targetId);
    // Navigate to the target entity after merge
    navigate(`/entities/${targetId}`);
  };

  const handleSplit = async (alias: string) => {
    if (!entity) return;
    await entitiesApi.split(entity.id, alias);
    // Reload the entity after split (alias removed from current entity)
    const refreshed = await entitiesApi.get(entity.id);
    setEntity(refreshed);
  };

  if (loadingEntity) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !entity) {
    return (
      <div className="py-12 text-center">
        <p className="text-destructive text-sm mb-3">{error ?? 'Entity not found'}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/entities">Back to Entities</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/entities" className="hover:text-foreground transition-colors">
          Entities
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">{entity.name}</span>
      </div>

      {/* Entity metadata card */}
      <EntityCard entity={entity} />

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowMerge(true)}
          title="Merge this entity into another"
        >
          Merge into...
        </Button>
        {entity.aliases.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSplit(true)}
            title="Split an alias into a new independent entity"
          >
            Split alias
          </Button>
        )}
      </div>

      <Separator />

      {/* Co-occurrence graph */}
      {captures.length > 0 && <CoOccurrencePanel captures={captures} />}

      {/* Linked captures */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Linked Captures
            {captures.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({captures.length})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loadingCaptures && (
            <div className="space-y-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 bg-muted animate-pulse rounded" />
              ))}
            </div>
          )}
          {!loadingCaptures && captures.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No captures linked to this entity yet.
            </p>
          )}
          {!loadingCaptures && captures.map((c) => (
            <CaptureRow key={c.id} capture={c} />
          ))}
        </CardContent>
      </Card>

      {/* Modals */}
      {showMerge && (
        <MergeModal
          entity={entity}
          onClose={() => setShowMerge(false)}
          onMerge={handleMerge}
        />
      )}
      {showSplit && (
        <SplitModal
          entity={entity}
          onClose={() => setShowSplit(false)}
          onSplit={handleSplit}
        />
      )}
    </div>
  );
}
