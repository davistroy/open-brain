'use client';

import { useState, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitMerge, X, Search, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { entitiesApi, HttpError } from '@/lib/api-client';
import type { Entity } from '@/lib/types';

interface MergeEntityModalProps {
  /** The entity being merged away (the "source") */
  entityId: string;
  entityName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal for merging this entity into another entity.
 * Search → pick target → confirm → POST /entities/:id/merge → redirect to target.
 * If the merge API is not yet available, shows a "Coming in M3" toast.
 * Client component.
 */
export function MergeEntityModal({ entityId, entityName, open, onOpenChange }: MergeEntityModalProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entity[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);
  const [merging, setMerging] = useState(false);

  const firstName = entityName.split(' ')[0];

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q);
    setSelected(null);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await entitiesApi.list({ limit: 8 });
      // Client-side fuzzy filter until server-side name search is wired
      const lower = q.toLowerCase();
      const filtered = res.items.filter(
        (e) =>
          e.id !== entityId &&
          (e.name.toLowerCase().includes(lower) ||
            (e.blurb ?? '').toLowerCase().includes(lower)),
      );
      setResults(filtered.slice(0, 6));
    } catch {
      toast.error('Search failed. Please try again.');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [entityId]);

  async function handleMerge() {
    if (!selected) return;
    setMerging(true);
    try {
      await entitiesApi.merge(entityId, selected.id);
      toast.success(`Merged "${entityName}" into "${selected.name}"`);
      onOpenChange(false);
      router.push(`/entities/${encodeURIComponent(selected.id)}`);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 501)) {
        // Merge endpoint not yet implemented in M2
        toast.info('Merge API coming in M3');
        onOpenChange(false);
      } else {
        toast.error('Merge failed. Please try again.');
      }
    } finally {
      setMerging(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuery('');
      setResults([]);
      setSelected(null);
      setMerging(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        {/* Overlay */}
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0, 0, 0, 0.45)' }}
        />

        {/* Content panel */}
        <Dialog.Content
          className="fixed z-50 bg-bg-container border border-cloud-medium"
          style={{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '100%',
            maxWidth: 520,
            maxHeight: '80vh',
            overflow: 'auto',
            padding: '28px 28px 24px',
            outline: 'none',
          }}
          aria-describedby="merge-desc"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-[10px]">
              <GitMerge
                size={15}
                strokeWidth={1.5}
                style={{ color: 'var(--color-book-cloth)' }}
              />
              <Dialog.Title
                className="text-text-heading"
                style={{
                  fontFamily: 'var(--font-family-display)',
                  fontSize: 18,
                  fontWeight: 300,
                  letterSpacing: '-0.01em',
                  margin: 0,
                }}
              >
                Merge {firstName}…
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                className="flex items-center justify-center bg-transparent border-none cursor-pointer"
                aria-label="Close"
                style={{ padding: 4, color: 'var(--color-text-body-secondary)' }}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          <p
            id="merge-desc"
            className="text-text-body-secondary"
            style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}
          >
            All captures linked to <strong className="text-text-heading">{entityName}</strong> will be
            re-linked to the target entity. This action cannot be undone.
          </p>

          {/* Search input */}
          <div
            className="flex items-center gap-2 border border-cloud-medium"
            style={{ padding: '8px 12px', marginBottom: 4 }}
          >
            {searching
              ? <Loader2 size={14} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--color-text-body-secondary)', flexShrink: 0 }} />
              : <Search size={14} strokeWidth={1.5} style={{ color: 'var(--color-text-body-secondary)', flexShrink: 0 }} />
            }
            <input
              type="text"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search for target entity…"
              className="flex-1 bg-transparent border-none outline-none text-text-heading"
              style={{ fontSize: 13.5, fontFamily: 'var(--font-family-base)' }}
            />
          </div>

          {/* Results list */}
          {results.length > 0 && (
            <div className="border border-cloud-light" style={{ marginBottom: 16 }}>
              {results.map((entity, i) => {
                const isSelected = selected?.id === entity.id;
                return (
                  <button
                    key={entity.id}
                    onClick={() => setSelected(isSelected ? null : entity)}
                    className="w-full text-left flex items-center justify-between"
                    style={{
                      padding: '10px 14px',
                      background: isSelected ? 'var(--color-book-cloth-50)' : 'transparent',
                      borderBottom: i < results.length - 1 ? '1px solid var(--color-cloud-light)' : 'none',
                      cursor: 'pointer',
                      border: 'none',
                    }}
                  >
                    <div>
                      <div className="text-text-heading" style={{ fontSize: 13.5, fontWeight: 400 }}>
                        {entity.name}
                      </div>
                      {entity.blurb && (
                        <div className="text-text-body-secondary" style={{ fontSize: 11.5 }}>
                          {entity.blurb}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontFamily: 'var(--font-family-monospace)',
                        fontSize: 10,
                        color: 'var(--color-book-cloth-dark)',
                        letterSpacing: '0.06em',
                        marginLeft: 12,
                        flexShrink: 0,
                      }}
                    >
                      {entity.entity_type.toUpperCase()}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {query.trim() && !searching && results.length === 0 && (
            <p
              className="text-text-body-secondary"
              style={{ fontSize: 13, marginBottom: 16 }}
            >
              No entities found matching &ldquo;{query}&rdquo;.
            </p>
          )}

          {/* Confirm row */}
          <div className="flex items-center justify-end gap-3">
            <Dialog.Close asChild>
              <button
                className="bg-transparent border border-cloud-medium text-text-body"
                style={{
                  padding: '7px 16px',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-family-base)',
                }}
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleMerge}
              disabled={!selected || merging}
              className="flex items-center gap-2"
              style={{
                padding: '7px 16px',
                background: !selected || merging
                  ? 'var(--color-cloud-medium)'
                  : 'var(--color-book-cloth)',
                color: 'var(--color-ivory-light)',
                border: 'none',
                cursor: !selected || merging ? 'not-allowed' : 'pointer',
                fontSize: 13,
                fontFamily: 'var(--font-family-base)',
              }}
            >
              {merging && <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />}
              {selected
                ? `Merge into ${selected.name.split(' ')[0]}`
                : 'Select a target first'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
