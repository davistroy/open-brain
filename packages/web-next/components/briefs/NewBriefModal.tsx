'use client';

import { useState, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sparkles, X, Search, Loader2, Sunrise, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { skillsApi, entitiesApi } from '@/lib/api-client';
import type { Entity } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BriefKindOption = 'DAILY' | 'DOSSIER';

interface NewBriefModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Kind selector card
// ---------------------------------------------------------------------------

interface KindCardProps {
  kind: BriefKindOption;
  selected: boolean;
  onSelect: () => void;
}

function KindCard({ kind, selected, onSelect }: KindCardProps) {
  const isDailyKind = kind === 'DAILY';
  const icon = isDailyKind
    ? <Sunrise size={16} strokeWidth={1.4} style={{ color: 'var(--color-book-cloth)' }} />
    : <UserRound size={16} strokeWidth={1.4} style={{ color: 'var(--color-book-cloth)' }} />;
  const label = isDailyKind ? 'Daily' : 'Dossier';
  const description = isDailyKind
    ? 'AI-generated summary of today\'s captures, decisions, and activity.'
    : 'Deep-dive brief on a specific entity — person, project, or topic.';

  return (
    <button
      onClick={onSelect}
      className="flex-1 text-left border"
      style={{
        padding: '14px 16px',
        borderColor: selected ? 'var(--color-book-cloth)' : 'var(--color-cloud-medium)',
        background: selected ? 'var(--color-book-cloth-50)' : 'transparent',
        cursor: 'pointer',
        transition: 'border-color 80ms, background 80ms',
      }}
    >
      <div className="flex items-center gap-[8px] mb-[6px]">
        {icon}
        <span
          className="text-text-heading"
          style={{
            fontFamily: 'var(--font-family-base)',
            fontSize: 13.5,
            fontWeight: selected ? 400 : 300,
          }}
        >
          {label}
        </span>
      </div>
      <p
        className="text-text-body-secondary m-0"
        style={{ fontFamily: 'var(--font-family-base)', fontSize: 12, lineHeight: 1.5 }}
      >
        {description}
      </p>
    </button>
  );
}

// ---------------------------------------------------------------------------
// NewBriefModal
// ---------------------------------------------------------------------------

/**
 * Modal for triggering a new brief — DAILY or DOSSIER.
 *
 * DAILY: triggers the morning-brief skill via skillsApi.trigger('morning-brief').
 * DOSSIER: entity search → triggers entity-brief skill with entityId param.
 *
 * On success, invalidates the ['briefs'] TanStack Query key so the list
 * refreshes. SSE brief_created also invalidates via SseProvider → no
 * double-work; invalidation is idempotent.
 *
 * Client component.
 */
export function NewBriefModal({ open, onOpenChange }: NewBriefModalProps) {
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<BriefKindOption>('DAILY');

  // Entity search state (DOSSIER flow)
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entity[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);

  // Trigger state
  const [triggering, setTriggering] = useState(false);

  // ---------------------------------------------------------------------------
  // Entity search (DOSSIER flow)
  // ---------------------------------------------------------------------------

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q);
    setSelected(null);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await entitiesApi.list({ limit: 50 });
      const lower = q.toLowerCase();
      const filtered = res.items.filter(
        (e) =>
          e.name.toLowerCase().includes(lower) ||
          (e.blurb ?? '').toLowerCase().includes(lower),
      );
      setResults(filtered.slice(0, 6));
    } catch {
      toast.error('Entity search failed. Please try again.');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Trigger
  // ---------------------------------------------------------------------------

  async function handleTrigger() {
    if (kind === 'DOSSIER' && !selected) return;

    setTriggering(true);
    try {
      if (kind === 'DAILY') {
        await skillsApi.trigger('morning-brief');
        toast.success('Daily brief queued — check back in a moment.');
      } else {
        // DOSSIER: trigger entity-brief skill with entityId
        await skillsApi.trigger('entity-brief', {
          entityId: selected!.id,
          entityName: selected!.name,
          entityType: selected!.entity_type,
        });
        toast.success(`Dossier for "${selected!.name}" queued — check back in a moment.`);
      }
      // Optimistically invalidate briefs list — SSE will also fire brief_created
      queryClient.invalidateQueries({ queryKey: ['briefs'] });
      onOpenChange(false);
    } catch {
      toast.error('Failed to queue brief. Please try again.');
    } finally {
      setTriggering(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Reset on close
  // ---------------------------------------------------------------------------

  function handleOpenChange(next: boolean) {
    if (!next) {
      setKind('DAILY');
      setQuery('');
      setResults([]);
      setSelected(null);
      setTriggering(false);
    }
    onOpenChange(next);
  }

  const canTrigger = kind === 'DAILY' || (kind === 'DOSSIER' && selected !== null);

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
          aria-describedby="new-brief-desc"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-[10px]">
              <Sparkles
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
                New brief
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
            id="new-brief-desc"
            className="text-text-body-secondary"
            style={{ fontSize: 13, marginBottom: 18, lineHeight: 1.5 }}
          >
            Choose a brief type to generate.
          </p>

          {/* Kind selector */}
          <div className="flex gap-[10px] mb-[20px]">
            <KindCard kind="DAILY" selected={kind === 'DAILY'} onSelect={() => { setKind('DAILY'); setQuery(''); setResults([]); setSelected(null); }} />
            <KindCard kind="DOSSIER" selected={kind === 'DOSSIER'} onSelect={() => setKind('DOSSIER')} />
          </div>

          {/* DOSSIER: entity picker */}
          {kind === 'DOSSIER' && (
            <div style={{ marginBottom: 20 }}>
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
                  placeholder="Search for a person, project, or topic…"
                  className="flex-1 bg-transparent border-none outline-none text-text-heading"
                  style={{ fontSize: 13.5, fontFamily: 'var(--font-family-base)' }}
                />
              </div>

              {/* Results list */}
              {results.length > 0 && (
                <div className="border border-cloud-light">
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
                  style={{ fontSize: 13, marginTop: 8 }}
                >
                  No entities found matching &ldquo;{query}&rdquo;.
                </p>
              )}

              {selected && (
                <div
                  className="flex items-center gap-2 mt-[10px]"
                  style={{
                    padding: '8px 12px',
                    background: 'var(--color-book-cloth-50)',
                    borderLeft: '2px solid var(--color-book-cloth)',
                  }}
                >
                  <UserRound size={13} strokeWidth={1.4} style={{ color: 'var(--color-book-cloth)' }} />
                  <span className="text-text-heading" style={{ fontSize: 13 }}>
                    {selected.name}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-family-monospace)',
                      fontSize: 10,
                      color: 'var(--color-book-cloth-dark)',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {selected.entity_type.toUpperCase()}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Action row */}
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
              onClick={handleTrigger}
              disabled={!canTrigger || triggering}
              className="flex items-center gap-2"
              style={{
                padding: '7px 16px',
                background: !canTrigger || triggering
                  ? 'var(--color-cloud-medium)'
                  : 'var(--color-book-cloth)',
                color: 'var(--color-ivory-light)',
                border: 'none',
                cursor: !canTrigger || triggering ? 'not-allowed' : 'pointer',
                fontSize: 13,
                fontFamily: 'var(--font-family-base)',
              }}
            >
              {triggering && <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />}
              {triggering
                ? 'Queuing…'
                : kind === 'DAILY'
                  ? 'Generate daily brief'
                  : selected
                    ? `Generate dossier for ${selected.name.split(' ')[0]}`
                    : 'Select an entity first'
              }
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
