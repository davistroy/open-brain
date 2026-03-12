import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronDown, ChevronUp, ArrowUp, BookOpen, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import type { Components } from 'react-markdown';

// Raw markdown imports (build-time, no runtime fetch)
import quickStartMd from '../../../../docs/USER_QUICK_START.md?raw';
import fullGuideMd from '../../../../docs/USER_GUIDE.md?raw';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = 'quick-start' | 'full-guide';

interface TocHeading {
  level: number;
  text: string;
  id: string;
}

// ─── Markdown heading parser ──────────────────────────────────────────────────

function parseHeadings(markdown: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const regex = /^(#{1,3})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const level = match[1].length;
    const text = match[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    // rehype-slug generates IDs by lowercasing, replacing spaces with hyphens,
    // and stripping special characters
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    headings.push({ level, text, id });
  }
  return headings;
}

// ─── Markdown component overrides ─────────────────────────────────────────────

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
  hr: (props) => (
    <hr className="my-6 border-border" {...props} />
  ),
  a: ({ href, children, ...props }) => {
    const isExternal = href?.startsWith('http');
    const isAnchor = href?.startsWith('#');

    if (isAnchor && href) {
      const anchorHref = href;
      return (
        <a
          href={anchorHref}
          className="text-primary hover:underline"
          onClick={(e) => {
            e.preventDefault();
            const target = document.getElementById(anchorHref.slice(1));
            if (target) {
              target.scrollIntoView({ behavior: 'smooth' });
            }
          }}
          {...props}
        >
          {children}
        </a>
      );
    }

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

// ─── MarkdownRenderer ─────────────────────────────────────────────────────────

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose-custom">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug, rehypeAutolinkHeadings]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ─── Table of Contents ────────────────────────────────────────────────────────

function TableOfContents({ headings, activeId }: { headings: TocHeading[]; activeId: string | null }) {
  function handleClick(id: string) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  return (
    <nav className="space-y-0.5" aria-label="Table of contents">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        On this page
      </p>
      {headings.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => handleClick(h.id)}
          className={`block w-full text-left text-sm py-1 transition-colors rounded-sm ${
            h.level === 1 ? 'pl-2 font-medium' : h.level === 2 ? 'pl-4' : 'pl-6 text-xs'
          } ${
            activeId === h.id
              ? 'text-primary bg-accent/50 font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
          }`}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}

// ─── Mobile ToC (collapsible) ─────────────────────────────────────────────────

function MobileTableOfContents({ headings, activeId }: { headings: TocHeading[]; activeId: string | null }) {
  const [open, setOpen] = useState(false);

  function handleClick(id: string) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
    setOpen(false);
  }

  return (
    <div className="lg:hidden rounded-lg border bg-card mb-4">
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-center justify-between text-sm font-medium hover:bg-accent/50 transition-colors rounded-lg"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Table of Contents</span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-0.5">
          {headings.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => handleClick(h.id)}
              className={`block w-full text-left text-sm py-1 transition-colors rounded-sm ${
                h.level === 1 ? 'pl-1 font-medium' : h.level === 2 ? 'pl-3' : 'pl-5 text-xs'
              } ${
                activeId === h.id
                  ? 'text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Back to Top ──────────────────────────────────────────────────────────────

function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > 400);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      className="fixed bottom-6 right-6 z-40 gap-1.5 shadow-lg"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
    >
      <ArrowUp className="h-4 w-4" />
      Top
    </Button>
  );
}

// ─── Main Help page ───────────────────────────────────────────────────────────

export default function Help() {
  const [activeTab, setActiveTab] = useState<TabId>('quick-start');
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const fullGuideHeadings = useMemo(() => parseHeadings(fullGuideMd), []);
  const quickStartHeadings = useMemo(() => parseHeadings(quickStartMd), []);

  const currentHeadings = activeTab === 'full-guide' ? fullGuideHeadings : quickStartHeadings;

  // IntersectionObserver to track which heading is currently visible
  const setupObserver = useCallback(() => {
    observerRef.current?.disconnect();

    const headingIds = currentHeadings.map((h) => h.id);
    const elements = headingIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Find the first visible heading from top
        const visibleEntries = entries.filter((e) => e.isIntersecting);
        if (visibleEntries.length > 0) {
          // Use the topmost visible heading
          const sorted = visibleEntries.sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          );
          setActiveHeadingId(sorted[0].target.id);
        }
      },
      {
        rootMargin: '-80px 0px -60% 0px',
        threshold: 0,
      }
    );

    elements.forEach((el) => observerRef.current!.observe(el));
  }, [currentHeadings]);

  // Re-observe when tab changes or content loads
  useEffect(() => {
    // Defer to let markdown render
    const timer = setTimeout(setupObserver, 100);
    return () => {
      clearTimeout(timer);
      observerRef.current?.disconnect();
    };
  }, [setupObserver, activeTab]);

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'quick-start', label: 'Quick Start', icon: <Zap className="h-4 w-4" /> },
    { id: 'full-guide', label: 'Full Guide', icon: <BookOpen className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Help</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Learn how to use Open Brain — from quick start to full reference.
        </p>
      </div>

      {/* Tab buttons */}
      <div className="flex gap-2">
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            variant={activeTab === tab.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setActiveTab(tab.id);
              setActiveHeadingId(null);
              window.scrollTo({ top: 0 });
            }}
            className="gap-1.5"
          >
            {tab.icon}
            {tab.label}
          </Button>
        ))}
      </div>

      <Separator />

      {/* Content area */}
      {activeTab === 'quick-start' && (
        <div>
          <MobileTableOfContents headings={quickStartHeadings} activeId={activeHeadingId} />
          <div className="flex gap-8 items-start">
            {/* Desktop ToC */}
            {quickStartHeadings.length > 0 && (
              <div className="hidden lg:block w-56 shrink-0 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto">
                <TableOfContents headings={quickStartHeadings} activeId={activeHeadingId} />
              </div>
            )}
            {/* Content */}
            <div className="flex-1 min-w-0">
              <MarkdownRenderer content={quickStartMd} />
            </div>
          </div>
        </div>
      )}

      {activeTab === 'full-guide' && (
        <div>
          <MobileTableOfContents headings={fullGuideHeadings} activeId={activeHeadingId} />
          <div className="flex gap-8 items-start">
            {/* Desktop ToC */}
            {fullGuideHeadings.length > 0 && (
              <div className="hidden lg:block w-56 shrink-0 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto">
                <TableOfContents headings={fullGuideHeadings} activeId={activeHeadingId} />
              </div>
            )}
            {/* Content */}
            <div className="flex-1 min-w-0">
              <MarkdownRenderer content={fullGuideMd} />
            </div>
          </div>
        </div>
      )}

      {/* Back to top */}
      <BackToTop />
    </div>
  );
}
