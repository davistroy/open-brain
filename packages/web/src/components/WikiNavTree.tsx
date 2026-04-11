import { useState, useMemo } from 'react';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FolderOpen,
  Folder,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WikiPageMeta } from '@/lib/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  page?: WikiPageMeta;
}

interface WikiNavTreeProps {
  pages: WikiPageMeta[];
  selectedPath: string | null;
  onSelectPage: (path: string) => void;
}

// ─── Directory display names ─────────────────────────────────────────────────

const DIR_LABELS: Record<string, string> = {
  entities: 'Entities',
  concepts: 'Concepts',
  sources: 'Sources',
  comparisons: 'Comparisons',
  synthesis: 'Synthesis',
};

const DIR_ORDER = ['entities', 'concepts', 'sources', 'comparisons', 'synthesis'];

// ─── Tree builder ────────────────────────────────────────────────────────────

function buildTree(pages: WikiPageMeta[]): TreeNode[] {
  const root: Record<string, TreeNode> = {};

  for (const page of pages) {
    const parts = page.path.split('/');

    if (parts.length === 1) {
      // Root-level file
      const key = `__file__${page.path}`;
      root[key] = {
        name: page.title || page.path.replace('.md', ''),
        path: page.path,
        isDir: false,
        children: [],
        page,
      };
      continue;
    }

    const dirName = parts[0];
    if (!root[dirName]) {
      root[dirName] = {
        name: DIR_LABELS[dirName] ?? dirName,
        path: dirName,
        isDir: true,
        children: [],
      };
    }

    root[dirName].children.push({
      name: page.title || parts[parts.length - 1].replace('.md', ''),
      path: page.path,
      isDir: false,
      children: [],
      page,
    });
  }

  // Sort directory children alphabetically by name
  for (const node of Object.values(root)) {
    if (node.isDir) {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // Order: known directories first (in DIR_ORDER), then unknown dirs, then root files
  const sorted: TreeNode[] = [];
  for (const dir of DIR_ORDER) {
    if (root[dir]) sorted.push(root[dir]);
  }
  for (const [key, node] of Object.entries(root)) {
    if (node.isDir && !DIR_ORDER.includes(key)) {
      sorted.push(node);
    }
  }
  for (const [key, node] of Object.entries(root)) {
    if (key.startsWith('__file__')) {
      sorted.push(node);
    }
  }

  return sorted;
}

// ─── Directory node ──────────────────────────────────────────────────────────

function DirNode({
  node,
  selectedPath,
  onSelectPage,
  defaultOpen,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelectPage: (path: string) => void;
  defaultOpen?: boolean;
}) {
  const hasSelectedChild = selectedPath
    ? node.children.some((c) => c.path === selectedPath)
    : false;
  const [open, setOpen] = useState(defaultOpen || hasSelectedChild);

  const FolderIcon = open ? FolderOpen : Folder;
  const ChevronIcon = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
      >
        <ChevronIcon className="h-3.5 w-3.5 shrink-0" />
        <FolderIcon className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium">{node.name}</span>
        <span className="ml-auto text-xs text-muted-foreground/70">{node.children.length}</span>
      </button>
      {open && (
        <div className="ml-3 border-l border-border pl-2 mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <FileNode
              key={child.path}
              node={child}
              selected={selectedPath === child.path}
              onSelectPage={onSelectPage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── File node ───────────────────────────────────────────────────────────────

function FileNode({
  node,
  selected,
  onSelectPage,
}: {
  node: TreeNode;
  selected: boolean;
  onSelectPage: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectPage(node.path)}
      className={cn(
        'flex items-center gap-1.5 w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors truncate',
        selected
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

// ─── WikiNavTree ─────────────────────────────────────────────────────────────

export default function WikiNavTree({ pages, selectedPath, onSelectPage }: WikiNavTreeProps) {
  const tree = useMemo(() => buildTree(pages), [pages]);

  if (pages.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        No wiki pages yet.
      </div>
    );
  }

  return (
    <nav className="space-y-0.5" aria-label="Wiki navigation">
      {tree.map((node) =>
        node.isDir ? (
          <DirNode
            key={node.path}
            node={node}
            selectedPath={selectedPath}
            onSelectPage={onSelectPage}
            defaultOpen={node.children.length <= 15}
          />
        ) : (
          <FileNode
            key={node.path}
            node={node}
            selected={selectedPath === node.path}
            onSelectPage={onSelectPage}
          />
        ),
      )}
    </nav>
  );
}
