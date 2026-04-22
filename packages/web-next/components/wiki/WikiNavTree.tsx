'use client';

/**
 * WikiNavTree — sidebar navigation tree for the wiki.
 *
 * Builds a hierarchical tree from flat `WikiPageMeta[]` using slug path
 * segments as hierarchy keys. Top-level segments are expandable nodes;
 * leaf pages link to `/wiki/<path>`.
 *
 * Active page is highlighted via book-cloth border. Nodes with children
 * can be toggled open/closed; they start open if the active page lives
 * beneath them.
 *
 * Client component — manages expand/collapse state.
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ChevronRight, FileText } from 'lucide-react';
import type { WikiPageMeta } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

interface TreeLeaf {
  kind: 'leaf';
  label: string;
  path: string;        // full wiki path, e.g. "career/goals"
  href: string;        // Next.js href, e.g. "/wiki/career/goals"
}

interface TreeBranch {
  kind: 'branch';
  label: string;
  segment: string;     // the path segment, e.g. "career"
  children: TreeNode[];
}

type TreeNode = TreeLeaf | TreeBranch;

// ---------------------------------------------------------------------------
// Tree builder — convert flat page list into nested tree
// ---------------------------------------------------------------------------

function buildTree(pages: WikiPageMeta[]): TreeNode[] {
  const root: Record<string, TreeNode> = {};

  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);

    if (segments.length === 0) continue;

    if (segments.length === 1) {
      // Top-level leaf
      const seg = segments[0];
      root[seg] = {
        kind: 'leaf',
        label: page.title || seg,
        path: page.path,
        href: `/wiki/${page.path}`,
      };
    } else {
      // Nested — ensure branch exists then add leaf
      const topSeg = segments[0];
      if (!root[topSeg] || root[topSeg].kind === 'leaf') {
        root[topSeg] = {
          kind: 'branch',
          label: topSeg.charAt(0).toUpperCase() + topSeg.slice(1),
          segment: topSeg,
          children: [],
        };
      }

      const branch = root[topSeg] as TreeBranch;
      const leafLabel = page.title || segments[segments.length - 1];
      branch.children.push({
        kind: 'leaf',
        label: leafLabel,
        path: page.path,
        href: `/wiki/${page.path}`,
      });
    }
  }

  return Object.values(root).sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LeafItem({
  node,
  activeSlug,
}: {
  node: TreeLeaf;
  activeSlug: string | null;
}) {
  const isActive = activeSlug === node.path;

  return (
    <Link
      href={node.href}
      className={[
        'flex items-center gap-[6px] px-[8px] py-[5px] rounded-[3px]',
        'text-[12.5px] font-light no-underline transition-colors duration-[100ms]',
        isActive
          ? 'bg-[rgba(74,55,40,0.08)] text-text-heading border-l-2 border-book-cloth pl-[6px]'
          : 'text-text-body-secondary hover:text-text-heading hover:bg-[rgba(74,55,40,0.04)]',
      ].join(' ')}
    >
      <FileText size={11} strokeWidth={1.5} className="shrink-0 opacity-60" />
      <span className="truncate">{node.label}</span>
    </Link>
  );
}

function BranchItem({
  node,
  activeSlug,
  initiallyOpen,
}: {
  node: TreeBranch;
  activeSlug: string | null;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={[
          'flex items-center gap-[6px] w-full px-[8px] py-[5px] rounded-[3px]',
          'text-[12.5px] font-normal bg-transparent border-none cursor-pointer text-left',
          'text-text-heading hover:bg-[rgba(74,55,40,0.04)] transition-colors duration-[100ms]',
        ].join(' ')}
        aria-expanded={open}
      >
        <ChevronRight
          size={11}
          strokeWidth={2}
          className={`shrink-0 transition-transform duration-[150ms] ${open ? 'rotate-90' : ''}`}
        />
        <span className="truncate">{node.label}</span>
        <span
          className="ml-auto text-text-body-secondary font-mono"
          style={{ fontSize: 10 }}
        >
          {node.children.length}
        </span>
      </button>

      {open && (
        <div className="ml-[14px] mt-[1px] flex flex-col gap-[1px] border-l border-cloud-medium pl-[6px]">
          {node.children.map((child) =>
            child.kind === 'leaf' ? (
              <LeafItem key={child.path} node={child} activeSlug={activeSlug} />
            ) : (
              <BranchItem
                key={child.segment}
                node={child}
                activeSlug={activeSlug}
                initiallyOpen={
                  activeSlug !== null &&
                  activeSlug.startsWith(child.segment + '/')
                }
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface WikiNavTreeProps {
  pages: WikiPageMeta[];
  /** Current active page path, e.g. "career/goals" or null on the root page. */
  activeSlug: string | null;
}

export function WikiNavTree({ pages, activeSlug }: WikiNavTreeProps) {
  const tree = useMemo(() => buildTree(pages), [pages]);

  if (tree.length === 0) {
    return (
      <div className="text-[12px] text-text-body-secondary font-light px-[8px] py-[12px]">
        No wiki pages yet.
      </div>
    );
  }

  return (
    <nav aria-label="Wiki pages" className="flex flex-col gap-[2px]">
      {/* Root link */}
      <Link
        href="/wiki"
        className={[
          'flex items-center gap-[6px] px-[8px] py-[5px] rounded-[3px]',
          'text-[12.5px] font-normal no-underline transition-colors duration-[100ms]',
          activeSlug === null
            ? 'bg-[rgba(74,55,40,0.08)] text-text-heading'
            : 'text-text-body-secondary hover:text-text-heading hover:bg-[rgba(74,55,40,0.04)]',
        ].join(' ')}
      >
        All pages
      </Link>

      <div className="h-[6px]" />

      {tree.map((node) =>
        node.kind === 'leaf' ? (
          <LeafItem key={node.path} node={node} activeSlug={activeSlug} />
        ) : (
          <BranchItem
            key={node.segment}
            node={node}
            activeSlug={activeSlug}
            initiallyOpen={
              activeSlug !== null &&
              activeSlug.startsWith(node.segment + '/')
            }
          />
        ),
      )}
    </nav>
  );
}
