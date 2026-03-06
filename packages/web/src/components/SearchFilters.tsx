import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import type { BrainView, CaptureSource, CaptureType, SearchFilters } from '@/lib/types';

const BRAIN_VIEWS: BrainView[] = ['career', 'personal', 'technical', 'work-internal', 'client'];
const CAPTURE_TYPES: CaptureType[] = [
  'decision', 'idea', 'observation', 'task', 'win', 'blocker', 'question', 'reflection',
];
const CAPTURE_SOURCES: CaptureSource[] = ['slack', 'voice', 'api', 'mcp', 'system', 'bookmark', 'calendar'];

interface SearchFiltersProps {
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  onClear: () => void;
}

function SelectFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: T[];
  onChange: (v: T | undefined) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value as T) || undefined)}
        className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">All</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function SearchFiltersPanel({ filters, onChange, onClear }: SearchFiltersProps) {
  function update(partial: Partial<SearchFilters>) {
    onChange({ ...filters, ...partial });
  }

  const hasActiveFilters =
    filters.brain_view || filters.capture_type || filters.source || filters.start_date || filters.end_date;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Filters</p>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={onClear} className="h-7 px-2 text-xs gap-1">
            <X className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      <SelectFilter<BrainView>
        label="Brain View"
        value={filters.brain_view}
        options={BRAIN_VIEWS}
        onChange={(v) => update({ brain_view: v })}
      />

      <SelectFilter<CaptureType>
        label="Capture Type"
        value={filters.capture_type}
        options={CAPTURE_TYPES}
        onChange={(v) => update({ capture_type: v })}
      />

      <SelectFilter<CaptureSource>
        label="Source"
        value={filters.source}
        options={CAPTURE_SOURCES}
        onChange={(v) => update({ source: v })}
      />

      <div>
        <label className="block text-xs text-muted-foreground mb-1">Start Date</label>
        <Input
          type="date"
          value={filters.start_date ?? ''}
          onChange={(e) => update({ start_date: e.target.value || undefined })}
          className="h-9 text-sm"
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">End Date</label>
        <Input
          type="date"
          value={filters.end_date ?? ''}
          onChange={(e) => update({ end_date: e.target.value || undefined })}
          className="h-9 text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="hybrid-toggle"
          type="checkbox"
          checked={filters.hybrid ?? true}
          onChange={(e) => update({ hybrid: e.target.checked })}
          className="rounded border-input"
        />
        <label htmlFor="hybrid-toggle" className="text-sm text-muted-foreground cursor-pointer">
          Hybrid search (FTS + vector)
        </label>
      </div>
    </div>
  );
}
