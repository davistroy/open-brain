import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Search,
  Sparkles,
  AlertCircle,
  CheckCircle,
  Clock,
  FileText,
  Loader2,
  GitCommitHorizontal,
  ShieldAlert,
  Tag,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import type { Components } from 'react-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import WikiNavTree from '@/components/WikiNavTree';
import { wikiApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDate, relativeTime } from '@/lib/utils';
import type { WikiPageMeta, WikiPageFull, WikiRecentChange, WikiLintReport, WikiLintIssue } from '@/lib/types';

// ─── Tab types ───────────────────────────────────────────────────────────────

type TabId = 'content' | 'changes' | 'health';

// ─── Page type badge colors ──────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  entity: 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  concept: 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  source: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  comparison: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800',
  synthesis: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  overview: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700',
};

const SEVERITY_COLORS: Record<string, string> = {
  error: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
  warning: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-800',
  info: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800',
};

// ─── Markdown component overrides (matches Help page) ────────────────────────

const markdownComponents: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="text-2xl font-bold mt-8 mb-4 first:mt-0 scroll-mt-20" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-xl font-semibold mt-8 mb-3 scroll-mt-20" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-lg font-semibold mt-6 mb-2 scroll-mt-20" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="text-base font-semibold mt-4 mb-2 scroll-mt-20" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="text-sm leading-relaxed mb-3" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc list-inside space-y-1 mb-3 text-sm" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal list-inside space-y-1 mb-3 text-sm" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="text-sm leading-relaxed" {...props}>
      {children}
    </li>
  ),
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto mb-4">
      <table className="min-w-full border border-border rounded-lg text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted/50" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }) => (
    <tbody className="divide-y divide-border" {...props}>
      {children}
    </tbody>
  ),
  tr: ({ children, ...props }) => (
    <tr className="divide-x divide-border" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-3 py-2 text-sm" {...props}>
      {children}
    </td>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className={`${className ?? ''} block bg-muted rounded-lg p-3 font-mono text-sm overflow-x-auto mb-3`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre className="bg-muted rounded-lg p-3 font-mono text-sm overflow-x-auto mb-3" {...props}>
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground mb-3" {...props}>
      {children}
    </blockquote>
  ),
  hr: (props) => <hr className="my-6 border-border" {...props} />,
  a: ({ href, children, ...props }) => {
    const isExternal = href?.startsWith('http');
    return (
      <a
        href={href}
        className="text-primary hover:underline"
        {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...props}
      >
        {children}
      </a>
    );
  },
  strong: ({ children, ...props }) => (
    <strong className="font-semibold" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
};

// ─── Toast notification ──────────────────────────────────────────────────────

interface ToastState {
  message: string;
  success: boolean;
}

function ToastBanner({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-4 py-3 text-sm',
        toast.success
          ? 'bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800'
          : 'bg-destructive/10 text-destructive border-destructive/30',
      )}
    >
      {toast.success ? (
        <CheckCircle className="h-4 w-4 shrink-0" />
      ) : (
        <AlertCircle className="h-4 w-4 shrink-0" />
      )}
      {toast.message}
    </div>
  );
}

// ─── Page metadata header ────────────────────────────────────────────────────

function PageHeader({ page }: { page: WikiPageFull }) {
  const typeCls = TYPE_COLORS[page.type] ?? TYPE_COLORS.overview;

  return (
    <div className="space-y-2 mb-6">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xl font-bold">{page.title || page.path}</h2>
        <Badge variant="outline" className={cn('text-xs border', typeCls)}>
          {page.type}
        </Badge>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
        {page.updated && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Updated {formatDate(page.updated)}
          </span>
        )}
        {page.source_count !== undefined && page.source_count > 0 && (
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {page.source_count} source{page.source_count !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {page.tags && page.tags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Tag className="h-3 w-3 text-muted-foreground" />
          {page.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Recent Changes tab ──────────────────────────────────────────────────────

function RecentChangesTab({
  changes,
  loading,
  onSelectPage,
}: {
  changes: WikiRecentChange[];
  loading: boolean;
  onSelectPage: (path: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (changes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No recent changes recorded.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {changes.map((change) => (
        <Card key={change.hash}>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <GitCommitHorizontal className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{change.message}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {relativeTime(change.date)} &middot; {change.hash.slice(0, 7)}
                </p>
                {change.files.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {change.files.map((file) => (
                      <button
                        key={file}
                        type="button"
                        onClick={() => onSelectPage(file)}
                        className="text-xs text-primary hover:underline"
                      >
                        {file}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Health / Lint tab ───────────────────────────────────────────────────────

function HealthTab({
  report,
  loading,
  onRunLint,
  lintRunning,
}: {
  report: WikiLintReport | null;
  loading: boolean;
  onRunLint: () => void;
  lintRunning: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const issues = report?.issues ?? [];
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {report?.total_pages ?? 0} pages scanned
          </span>
          {report?.last_run && (
            <span className="text-xs text-muted-foreground">
              Last run: {relativeTime(report.last_run)}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRunLint}
          disabled={lintRunning}
          className="gap-1.5"
        >
          {lintRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5" />
          )}
          Run Lint Now
        </Button>
      </div>

      {issues.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border px-4 py-6 text-sm text-center justify-center bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800">
          <CheckCircle className="h-4 w-4" />
          No lint issues found.
        </div>
      ) : (
        <>
          <div className="flex gap-3 text-xs">
            {errorCount > 0 && (
              <Badge variant="outline" className={cn('border', SEVERITY_COLORS.error)}>
                {errorCount} error{errorCount !== 1 ? 's' : ''}
              </Badge>
            )}
            {warningCount > 0 && (
              <Badge variant="outline" className={cn('border', SEVERITY_COLORS.warning)}>
                {warningCount} warning{warningCount !== 1 ? 's' : ''}
              </Badge>
            )}
            {infoCount > 0 && (
              <Badge variant="outline" className={cn('border', SEVERITY_COLORS.info)}>
                {infoCount} info
              </Badge>
            )}
          </div>
          <div className="space-y-2">
            {issues.map((issue, i) => (
              <LintIssueRow key={`${issue.page}-${issue.rule}-${i}`} issue={issue} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LintIssueRow({ issue }: { issue: WikiLintIssue }) {
  const severityCls = SEVERITY_COLORS[issue.severity] ?? SEVERITY_COLORS.info;
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 text-sm">
      <Badge variant="outline" className={cn('text-xs border shrink-0 mt-0.5', severityCls)}>
        {issue.severity}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{issue.message}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {issue.page} &middot; {issue.rule}
        </p>
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <FileText className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-lg font-semibold mb-1">Select a page</h3>
      <p className="text-sm text-muted-foreground max-w-sm">
        Choose a wiki page from the navigation tree, or use search to find what you need.
      </p>
    </div>
  );
}

// ─── Not configured state ───────────────────────────────────────────────────

function NotConfiguredState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <AlertCircle className="h-12 w-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-lg font-semibold mb-2">Wiki not configured</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-4">
        The wiki feature requires a Gitea repository. Set the{' '}
        <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">WIKI_REPO_URL</code>{' '}
        and{' '}
        <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">WIKI_LOCAL_PATH</code>{' '}
        environment variables on the core-api container to enable it.
      </p>
      <p className="text-xs text-muted-foreground max-w-sm">
        Once configured, the wiki will automatically build knowledge pages from your captures
        using LLM synthesis.
      </p>
    </div>
  );
}

// ─── Main Wiki page ──────────────────────────────────────────────────────────

export default function Wiki() {
  const location = useLocation();
  const navigate = useNavigate();

  // Derive selected page path from URL: /wiki/entities/kubernetes.md -> entities/kubernetes.md
  const pathFromUrl = location.pathname.replace(/^\/wiki\/?/, '') || null;

  // State
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [selectedPage, setSelectedPage] = useState<WikiPageFull | null>(null);
  const [recentChanges, setRecentChanges] = useState<WikiRecentChange[]>([]);
  const [lintReport, setLintReport] = useState<WikiLintReport | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<WikiPageMeta[] | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('content');
  const [toast, setToast] = useState<ToastState | null>(null);

  // Loading states
  const [loadingPages, setLoadingPages] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [loadingLint, setLoadingLint] = useState(false);
  const [lintRunning, setLintRunning] = useState(false);
  const [resynthesizing, setResynthesizing] = useState(false);
  const [searching, setSearching] = useState(false);

  // Wiki availability — false when WIKI_REPO_URL is unset (API returns 404)
  const [wikiAvailable, setWikiAvailable] = useState(true);

  // ─── Load page list ──────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoadingPages(true);
    wikiApi
      .pages()
      .then((data) => {
        if (!cancelled) {
          setPages(data);
          setWikiAvailable(true);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setPages([]);
          // 404 means wiki routes are not registered (WIKI_REPO_URL unset)
          if (err.message?.includes('404')) {
            setWikiAvailable(false);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPages(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ─── Load selected page content when URL changes ─────────────────────────

  useEffect(() => {
    if (!pathFromUrl) {
      setSelectedPage(null);
      return;
    }

    let cancelled = false;
    setLoadingPage(true);
    wikiApi
      .page(pathFromUrl)
      .then((data) => {
        if (!cancelled) {
          setSelectedPage(data);
          setActiveTab('content');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedPage(null);
          setToast({ message: `Page not found: ${pathFromUrl}`, success: false });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPage(false);
      });
    return () => { cancelled = true; };
  }, [pathFromUrl]);

  // ─── Load recent changes when tab activates ──────────────────────────────

  useEffect(() => {
    if (activeTab !== 'changes') return;
    let cancelled = false;
    setLoadingChanges(true);
    wikiApi
      .recentChanges()
      .then((data) => {
        if (!cancelled) setRecentChanges(data);
      })
      .catch(() => {
        if (!cancelled) setRecentChanges([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingChanges(false);
      });
    return () => { cancelled = true; };
  }, [activeTab]);

  // ─── Load lint report when tab activates ─────────────────────────────────

  useEffect(() => {
    if (activeTab !== 'health') return;
    let cancelled = false;
    setLoadingLint(true);
    wikiApi
      .lintReport()
      .then((data) => {
        if (!cancelled) setLintReport(data);
      })
      .catch(() => {
        if (!cancelled) setLintReport(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingLint(false);
      });
    return () => { cancelled = true; };
  }, [activeTab]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleSelectPage = useCallback(
    (path: string) => {
      setSearchResults(null);
      setSearchQuery('');
      navigate(`/wiki/${path}`);
    },
    [navigate],
  );

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!searchQuery.trim()) {
        setSearchResults(null);
        return;
      }
      setSearching(true);
      try {
        const results = await wikiApi.search(searchQuery.trim());
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [searchQuery],
  );

  const handleRunLint = useCallback(async () => {
    setLintRunning(true);
    try {
      await wikiApi.triggerLint();
      setToast({ message: 'Lint job queued. Refresh the Health tab to see results.', success: true });
    } catch {
      setToast({ message: 'Failed to trigger lint.', success: false });
    } finally {
      setLintRunning(false);
    }
  }, []);

  const handleResynthesize = useCallback(async () => {
    if (!selectedPage) return;
    setResynthesizing(true);
    try {
      await wikiApi.triggerResynthesize(selectedPage.path);
      setToast({ message: `Re-synthesis queued for ${selectedPage.title || selectedPage.path}.`, success: true });
    } catch {
      setToast({ message: 'Failed to trigger re-synthesis.', success: false });
    } finally {
      setResynthesizing(false);
    }
  }, [selectedPage]);

  const dismissToast = useCallback(() => setToast(null), []);

  // ─── Displayed pages in nav tree (search results override) ───────────────

  const displayedPages = searchResults ?? pages;

  // ─── Tab buttons ─────────────────────────────────────────────────────────

  const tabs: { id: TabId; label: string }[] = [
    { id: 'content', label: 'Content' },
    { id: 'changes', label: 'Recent Changes' },
    { id: 'health', label: 'Health' },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Wiki</h1>
        <p className="text-sm text-muted-foreground mt-1">
          LLM-maintained knowledge base built from your captures.
        </p>
      </div>

      {/* Toast */}
      {toast && <ToastBanner toast={toast} onDismiss={dismissToast} />}

      {/* Not configured state */}
      {!loadingPages && !wikiAvailable && <NotConfiguredState />}

      {/* Wiki content — only rendered when wiki is available */}
      {wikiAvailable && (
        <>
          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search wiki pages..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!e.target.value.trim()) setSearchResults(null);
                }}
                className="pl-9"
              />
            </div>
            <Button type="submit" variant="outline" size="default" disabled={searching}>
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
            </Button>
          </form>

          {/* Tab buttons */}
          <div className="flex gap-2">
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                variant={activeTab === tab.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          <Separator />

          {/* Two-panel layout */}
          {activeTab === 'content' && (
            <div className="flex gap-6 items-start">
              {/* Left: Navigation tree */}
              <div className="hidden md:block w-56 shrink-0 sticky top-4 max-h-[calc(100vh-14rem)] overflow-y-auto rounded-lg border bg-card p-2">
                {loadingPages ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <WikiNavTree
                    pages={displayedPages}
                    selectedPath={pathFromUrl}
                    onSelectPage={handleSelectPage}
                  />
                )}
              </div>

              {/* Mobile: simple page list */}
              <div className="md:hidden w-full">
                {!pathFromUrl && !loadingPage && (
                  <div className="mb-4 rounded-lg border bg-card p-2">
                    {loadingPages ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <WikiNavTree
                        pages={displayedPages}
                        selectedPath={pathFromUrl}
                        onSelectPage={handleSelectPage}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Right: Page content */}
              <div className="flex-1 min-w-0">
                {loadingPage ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedPage ? (
                  <div>
                    {/* Page header */}
                    <PageHeader page={selectedPage} />

                    {/* Action buttons */}
                    <div className="flex gap-2 mb-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleResynthesize}
                        disabled={resynthesizing}
                        className="gap-1.5"
                      >
                        {resynthesizing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5" />
                        )}
                        Re-synthesize Page
                      </Button>
                    </div>

                    <Separator className="mb-6" />

                    {/* Rendered markdown */}
                    <div className="prose-custom">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeSlug, rehypeAutolinkHeadings]}
                        components={markdownComponents}
                      >
                        {selectedPage.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <EmptyState />
                )}
              </div>
            </div>
          )}

          {/* Recent Changes tab */}
          {activeTab === 'changes' && (
            <RecentChangesTab
              changes={recentChanges}
              loading={loadingChanges}
              onSelectPage={(path) => {
                setActiveTab('content');
                handleSelectPage(path);
              }}
            />
          )}

          {/* Health / Lint tab */}
          {activeTab === 'health' && (
            <HealthTab
              report={lintReport}
              loading={loadingLint}
              onRunLint={handleRunLint}
              lintRunning={lintRunning}
            />
          )}
        </>
      )}
    </div>
  );
}
