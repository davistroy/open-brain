import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { entitiesApi } from '@/lib/api';
import type { Entity } from '@/lib/types';
import { cn } from '@/lib/utils';

// --- Entity type styling ---
const TYPE_COLORS: Record<string, string> = {
  person: 'bg-sky-100 text-sky-800 border-sky-200',
  org: 'bg-amber-100 text-amber-800 border-amber-200',
  concept: 'bg-violet-100 text-violet-800 border-violet-200',
  decision: 'bg-rose-100 text-rose-800 border-rose-200',
  project: 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

const ENTITY_TYPES = ['person', 'org', 'concept', 'decision', 'project'];

type SortMode = 'mentions' | 'recency';

function formatRelativeDate(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function EntityRow({ entity }: { entity: Entity }) {
  const typeCls = TYPE_COLORS[entity.type] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <Link to={`/entities/${entity.id}`} className="block group">
      <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm group-hover:text-primary transition-colors truncate">
              {entity.name}
            </span>
            <Badge variant="outline" className={cn('text-xs shrink-0 border', typeCls)}>
              {entity.type}
            </Badge>
          </div>
          {entity.aliases.length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              Also: {entity.aliases.slice(0, 3).join(', ')}
              {entity.aliases.length > 3 && ` +${entity.aliases.length - 3}`}
            </p>
          )}
        </div>

        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {entity.mention_count ?? entity.capture_count}
          </div>
          <div className="text-xs text-muted-foreground">
            {(entity.mention_count ?? entity.capture_count) === 1 ? 'mention' : 'mentions'}
          </div>
        </div>

        <div className="text-right shrink-0 min-w-[60px]">
          <div className="text-xs text-muted-foreground">
            {formatRelativeDate(entity.last_seen)}
          </div>
          <div className="text-xs text-muted-foreground/60">last seen</div>
        </div>
      </div>
    </Link>
  );
}

export default function Entities() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [typeFilter, setTypeFilter] = useState('');
  const [sort, setSort] = useState<SortMode>('mentions');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    entitiesApi
      .list({ type_filter: typeFilter || undefined, sort_by: sort, limit: 200 })
      .then((res) => {
        setEntities(res.data);
        setTotal(res.total);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load entities'))
      .finally(() => setLoading(false));
  }, [typeFilter, sort]);

  const filtered = debouncedSearch
    ? entities.filter(
        (e) =>
          e.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          e.aliases.some((a) => a.toLowerCase().includes(debouncedSearch.toLowerCase())),
      )
    : entities;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Entities</h1>
        {total > 0 && (
          <span className="text-sm text-muted-foreground">
            {total.toLocaleString()} total
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Input
          className="h-9 w-48"
          placeholder="Search entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t} className="capitalize">{t}</option>
          ))}
        </select>

        <div className="flex rounded-md border overflow-hidden">
          {(['mentions', 'recency'] as SortMode[]).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={cn(
                'px-3 h-9 text-sm transition-colors capitalize',
                sort === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background hover:bg-accent',
              )}
            >
              {s === 'mentions' ? 'Most mentioned' : 'Recent'}
            </button>
          ))}
        </div>

        {(typeFilter || debouncedSearch) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTypeFilter('');
              setSearch('');
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Type chips */}
      <div className="flex flex-wrap gap-2 mb-5">
        {ENTITY_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
            className={cn(
              'text-xs px-3 py-1 rounded-full border capitalize transition-colors',
              typeFilter === t
                ? TYPE_COLORS[t]
                : 'border-border text-muted-foreground hover:border-primary',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && (
        <Card>
          <CardContent className="pt-4">
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-12 rounded bg-muted animate-pulse" />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && error && (
        <p className="text-destructive text-sm text-center py-8">{error}</p>
      )}

      {!loading && !error && filtered.length === 0 && (
        <p className="text-muted-foreground text-center py-12">
          {debouncedSearch ? `No entities matching "${debouncedSearch}"` : 'No entities found.'}
        </p>
      )}

      {!loading && !error && filtered.length > 0 && (
        <Card>
          <CardContent className="pt-4 pb-2">
            <div className="divide-y">
              {filtered.map((e) => (
                <EntityRow key={e.id} entity={e} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-center mt-3">
          Showing {filtered.length}{filtered.length !== total ? ` of ${total}` : ''} entities
        </p>
      )}
    </div>
  );
}
