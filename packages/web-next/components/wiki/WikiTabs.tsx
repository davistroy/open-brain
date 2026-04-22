'use client';

/**
 * WikiTabs — 4-tab panel for wiki page detail.
 *
 * Tabs:
 *   1. Content      — rendered markdown via dangerouslySetInnerHTML
 *   2. Recent Changes — git-log list of changes
 *   3. Health       — lint report (issues list, last run time)
 *   4. Stats        — aggregate wiki statistics
 *
 * Content is passed as props from the RSC page (server fetched).
 * Client component — manages active tab state only.
 */

import { useState } from 'react';
import { AlertTriangle, Info, CheckCircle, RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/design-system';
import type { WikiPageFull, WikiChange, WikiLintReport, WikiStats } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Tab IDs
// ---------------------------------------------------------------------------

type TabId = 'content' | 'changes' | 'health' | 'stats';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'content', label: 'Content' },
  { id: 'changes', label: 'Recent Changes' },
  { id: 'health', label: 'Health' },
  { id: 'stats', label: 'Stats' },
];

// ---------------------------------------------------------------------------
// Content panel — pre-rendered markdown or raw markdown fallback
// ---------------------------------------------------------------------------

function ContentPanel({ page }: { page: WikiPageFull | null }) {
  if (!page) {
    return (
      <div className="py-[48px] text-center text-text-body-secondary text-[13px] font-light">
        Select a page from the sidebar to read its content.
      </div>
    );
  }

  return (
    <article className="min-w-0">
      {/* Page title */}
      <h1
        className="m-0 mb-[8px] font-display font-light leading-[1.1] text-text-heading"
        style={{ fontSize: 28, letterSpacing: '-0.02em' }}
      >
        {page.title}
      </h1>

      {/* Meta row */}
      <div className="flex flex-wrap gap-[16px] items-center text-[12px] font-light text-text-body-secondary pb-[16px] mb-[20px] border-b border-cloud-medium">
        <span>Updated {new Date(page.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        {page.type && (
          <>
            <span className="text-cloud-medium" aria-hidden="true">·</span>
            <span className="capitalize">{page.type}</span>
          </>
        )}
        {page.source_count !== undefined && page.source_count > 0 && (
          <>
            <span className="text-cloud-medium" aria-hidden="true">·</span>
            <span>{page.source_count} sources</span>
          </>
        )}
        {page.tags && page.tags.length > 0 && (
          <>
            <span className="text-cloud-medium" aria-hidden="true">·</span>
            <span>{page.tags.join(', ')}</span>
          </>
        )}
      </div>

      {/* Wiki content — treated as trusted server-generated markdown */}
      <div
        className="reader"
        style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-family-body)', fontSize: 14, lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: markdownToHtml(page.content) }}
      />
    </article>
  );
}

/**
 * Minimal markdown-to-HTML conversion for wiki content.
 * Handles: headings, bold, italic, code blocks, inline code, lists, blockquotes, links, horizontal rules.
 * The API returns raw markdown (not pre-rendered HTML), so we convert client-side.
 * This is trusted content from the git wiki repo — no user input.
 */
function markdownToHtml(md: string): string {
  return md
    // Escape HTML entities first to prevent injection from special chars
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Code blocks (must come before inline code)
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre class="wiki-code"><code>$1</code></pre>')
    // Headings
    .replace(/^#### (.+)$/gm, '<h4 class="wiki-h4">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="wiki-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="wiki-h2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="wiki-h1">$1</h1>')
    // Blockquotes
    .replace(/^> (.+)$/gm, '<blockquote class="wiki-blockquote">$1</blockquote>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr class="wiki-rule" />')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="wiki-inline-code">$1</code>')
    // Unordered lists
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul class="wiki-list">${m}</ul>`)
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="wiki-link">$1</a>')
    // Paragraphs — wrap bare lines
    .replace(/^(?!<[a-z]).+$/gm, '<p class="wiki-para">$&</p>')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
}

// ---------------------------------------------------------------------------
// Recent changes panel
// ---------------------------------------------------------------------------

function ChangesPanel({ changes }: { changes: WikiChange[] }) {
  if (changes.length === 0) {
    return (
      <div className="py-[48px] text-center text-text-body-secondary text-[13px] font-light">
        No recent changes recorded.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-cloud-light">
      {changes.map((change) => (
        <div key={change.hash} className="py-[12px]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] text-text-heading font-normal truncate">
                {change.message}
              </div>
              {change.files_changed && change.files_changed.length > 0 && (
                <div className="mt-[3px] text-[11.5px] text-text-body-secondary font-light truncate">
                  {change.files_changed.slice(0, 3).join(', ')}
                  {change.files_changed.length > 3 && ` +${change.files_changed.length - 3} more`}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11.5px] text-text-body-secondary font-light">
                {change.author}
              </div>
              <div
                className="text-[10.5px] text-text-body-secondary font-mono mt-[1px]"
              >
                {new Date(change.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health panel — lint report
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<string, React.ReactNode> = {
  error: <AlertTriangle size={13} strokeWidth={1.5} className="text-red-500 shrink-0" />,
  warning: <AlertTriangle size={13} strokeWidth={1.5} className="text-amber-500 shrink-0" />,
  info: <Info size={13} strokeWidth={1.5} className="text-blue-400 shrink-0" />,
};

function HealthPanel({
  report,
  onTriggerLint,
  lintLoading,
}: {
  report: WikiLintReport;
  onTriggerLint: () => void;
  lintLoading: boolean;
}) {
  return (
    <div>
      {/* Summary bar */}
      <div className="flex items-center justify-between mb-[16px]">
        <div className="flex items-center gap-[16px] text-[13px]">
          <span className="text-text-body-secondary font-light">
            {report.total_pages} pages checked
          </span>
          {report.issues.length === 0 ? (
            <span className="flex items-center gap-[5px] text-emerald-600">
              <CheckCircle size={13} strokeWidth={1.5} />
              No issues
            </span>
          ) : (
            <span className="text-red-600">
              {report.issues.length} issue{report.issues.length !== 1 ? 's' : ''}
            </span>
          )}
          {report.last_run && (
            <span className="text-text-body-secondary font-light text-[11.5px]">
              Last run {new Date(report.last_run).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={11} strokeWidth={1.5} />}
          onClick={onTriggerLint}
          disabled={lintLoading}
        >
          {lintLoading ? 'Queued…' : 'Run lint'}
        </Button>
      </div>

      {/* Issues list */}
      {report.issues.length === 0 ? (
        <div className="py-[32px] text-center text-text-body-secondary text-[13px] font-light">
          All wiki pages pass lint checks.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-cloud-light">
          {report.issues.map((issue, i) => (
            <div key={i} className="flex items-start gap-[8px] py-[10px]">
              {SEVERITY_ICON[issue.severity] ?? SEVERITY_ICON.info}
              <div className="min-w-0">
                <div className="text-[12.5px] text-text-heading font-normal">
                  {issue.message}
                </div>
                <div className="mt-[2px] text-[11px] text-text-body-secondary font-light font-mono truncate">
                  {issue.path} · {issue.rule}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats panel
// ---------------------------------------------------------------------------

function StatsPanel({
  stats,
  onTriggerResynthesize,
  resynthLoading,
  activePath,
}: {
  stats: WikiStats;
  onTriggerResynthesize: () => void;
  resynthLoading: boolean;
  activePath: string | null;
}) {
  return (
    <div>
      {/* Aggregate numbers */}
      <div className="grid grid-cols-2 gap-[12px] mb-[20px] sm:grid-cols-4">
        {[
          { label: 'Total pages', value: stats.total_pages },
          { label: 'Orphaned', value: stats.orphaned_pages },
          { label: 'Domains', value: stats.domains?.length ?? 0 },
          {
            label: 'Last synthesized',
            value: stats.last_synthesized
              ? new Date(stats.last_synthesized).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : '—',
          },
        ].map((item) => (
          <div
            key={item.label}
            className="bg-bg-container border border-cloud-light rounded-[4px] px-[12px] py-[10px]"
          >
            <div className="text-[11px] text-text-body-secondary font-mono uppercase tracking-[0.04em] mb-[4px]">
              {item.label}
            </div>
            <div className="text-[22px] font-display font-light text-text-heading leading-none">
              {item.value}
            </div>
          </div>
        ))}
      </div>

      {/* By type breakdown */}
      {Object.keys(stats.by_type ?? {}).length > 0 && (
        <div className="mb-[20px]">
          <div className="text-[11px] text-text-body-secondary font-mono uppercase tracking-[0.04em] mb-[8px]">
            By type
          </div>
          <div className="flex flex-wrap gap-[6px]">
            {Object.entries(stats.by_type).map(([type, count]) => (
              <span
                key={type}
                className="inline-flex items-center gap-[5px] px-[8px] py-[3px] rounded-full bg-cloud-light text-[11.5px] text-text-body-secondary"
              >
                <span className="capitalize">{type}</span>
                <span className="font-mono text-[10px]">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Domains list */}
      {stats.domains && stats.domains.length > 0 && (
        <div className="mb-[20px]">
          <div className="text-[11px] text-text-body-secondary font-mono uppercase tracking-[0.04em] mb-[6px]">
            Domains
          </div>
          <div className="text-[13px] text-text-body-secondary font-light">
            {stats.domains.join(', ')}
          </div>
        </div>
      )}

      {/* Re-synthesize action */}
      {activePath && (
        <div className="border-t border-cloud-light pt-[16px] mt-[8px]">
          <Button
            variant="secondary"
            size="sm"
            icon={<Zap size={11} strokeWidth={1.5} />}
            onClick={onTriggerResynthesize}
            disabled={resynthLoading}
          >
            {resynthLoading ? 'Queued…' : 'Re-synthesize this page'}
          </Button>
          <div className="text-[11px] text-text-body-secondary font-light mt-[6px]">
            Triggers wiki-synthesis skill for <span className="font-mono">{activePath}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface WikiTabsProps {
  /** Active page content (null on the list/root page). */
  page: WikiPageFull | null;
  changes: WikiChange[];
  lintReport: WikiLintReport;
  stats: WikiStats;
  /** The active page path for re-synthesize action (null on root page). */
  activePath: string | null;
}

export function WikiTabs({ page, changes, lintReport, stats, activePath }: WikiTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('content');
  const [lintLoading, setLintLoading] = useState(false);
  const [resynthLoading, setResynthLoading] = useState(false);

  async function handleTriggerLint() {
    setLintLoading(true);
    try {
      const { wikiApi } = await import('@/lib/api-client');
      await wikiApi.triggerLint();
    } catch {
      // fire-and-forget — user can see it worked via the next reload
    } finally {
      setLintLoading(false);
    }
  }

  async function handleTriggerResynthesize() {
    if (!activePath) return;
    setResynthLoading(true);
    try {
      const { wikiApi } = await import('@/lib/api-client');
      await wikiApi.triggerResynthesize(activePath);
    } catch {
      // fire-and-forget
    } finally {
      setResynthLoading(false);
    }
  }

  return (
    <div>
      {/* Tab bar */}
      <div
        className="flex border-b border-cloud-medium mb-[20px]"
        role="tablist"
        aria-label="Wiki sections"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'inline-flex items-center gap-2 px-[18px] py-[10px] -mb-px',
                'bg-transparent border-none cursor-pointer',
                'font-body text-[13px] transition-colors duration-[120ms]',
                isActive
                  ? 'border-b-2 border-book-cloth text-text-heading font-normal'
                  : 'border-b-2 border-transparent text-text-body-secondary font-light hover:text-text-heading',
              ].join(' ')}
              style={{ outline: 'none' }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {activeTab === 'content' && <ContentPanel page={page} />}
      {activeTab === 'changes' && <ChangesPanel changes={changes} />}
      {activeTab === 'health' && (
        <HealthPanel
          report={lintReport}
          onTriggerLint={handleTriggerLint}
          lintLoading={lintLoading}
        />
      )}
      {activeTab === 'stats' && (
        <StatsPanel
          stats={stats}
          onTriggerResynthesize={handleTriggerResynthesize}
          resynthLoading={resynthLoading}
          activePath={activePath}
        />
      )}
    </div>
  );
}
