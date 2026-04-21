'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { Card, Input, EmptyState } from '@/components/design-system';
import { EntityRow } from './EntityRow';
import type { Entity } from '@/lib/types';

interface EntityTableProps {
  entities: Entity[];
}

/**
 * Entity table — search filter toolbar + column header row + entity rows.
 * Client component: manages local search filter state.
 * Wrapped in Card (padded=false) with column-header row matching the prototype.
 */
export function EntityTable({ entities }: EntityTableProps) {
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? entities.filter(
        (e) =>
          e.name.toLowerCase().includes(query.toLowerCase()) ||
          (e.blurb ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : entities;

  return (
    <Card padded={false}>
      {/* Toolbar */}
      <div className="flex items-center gap-[12px] px-[14px] py-[10px] border-b border-cloud-medium">
        <Input
          icon={Search}
          placeholder="Filter entities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-[280px]"
        />
        <div className="flex-1" />
        <span className="font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em]">
          SORT · MENTIONS ↓
        </span>
      </div>

      {/* Column headers */}
      <div
        className="grid px-[18px] py-[10px] border-b border-cloud-medium gap-[16px] font-mono text-[10px] tracking-[0.08em] text-text-body-secondary"
        style={{ gridTemplateColumns: '20px 240px 1fr 90px 90px 28px' }}
      >
        <span />
        <span>NAME</span>
        <span>RELATED</span>
        <span>MENTIONS</span>
        <span>LAST SEEN</span>
        <span />
      </div>

      {/* Rows or empty state */}
      {filtered.length === 0 ? (
        <EmptyState
          title="No entities match"
          description={`No entities found for "${query}". Try a different search term.`}
          className="py-10"
        />
      ) : (
        filtered.map((entity, i) => (
          <EntityRow
            key={entity.id}
            entity={entity}
            isLast={i === filtered.length - 1}
          />
        ))
      )}
    </Card>
  );
}
