#!/usr/bin/env bash
# setup-wiki-repo.sh — Initialize the open-brain-wiki repository structure.
#
# Usage:
#   ./scripts/setup-wiki-repo.sh [target-dir]
#
# This script creates the initial directory structure and seed files for the
# wiki repository. The actual Gitea repo must be created manually first at
# gitea.k4jda.net/davistroy/open-brain-wiki. This script initializes the
# local clone with the correct structure and makes the first commit.
#
# If target-dir is not specified, defaults to /tmp/open-brain-wiki.

set -euo pipefail

TARGET_DIR="${1:-/tmp/open-brain-wiki}"

echo "=== Open Brain Wiki — Repository Setup ==="
echo "Target: ${TARGET_DIR}"

# Create directory structure
mkdir -p "${TARGET_DIR}/entities"
mkdir -p "${TARGET_DIR}/concepts"
mkdir -p "${TARGET_DIR}/sources"
mkdir -p "${TARGET_DIR}/comparisons"
mkdir -p "${TARGET_DIR}/synthesis"

echo "Created directory structure."

# --- WIKI_SCHEMA.md ---
cat > "${TARGET_DIR}/WIKI_SCHEMA.md" << 'SCHEMA_EOF'
# Open Brain Wiki Schema

This document defines the structure, conventions, and page types for the Open Brain wiki.
The wiki is an LLM-maintained knowledge base that grows organically from captured thoughts,
decisions, and observations. It is Git-backed (Gitea) and managed programmatically via
the `WikiGitService` in `@open-brain/shared`.

---

## Page Types

| Type | Directory | Description | When Created |
|------|-----------|-------------|--------------|
| `entity` | `entities/` | A person, project, technology, or organization that appears across multiple captures. | Auto-created when an entity is mentioned in 3+ captures. |
| `concept` | `concepts/` | An idea, pattern, or domain concept worth tracking (e.g., "RAG architecture", "change management"). | Auto-created when a concept cluster is detected. |
| `source` | `sources/` | A book, article, talk, or reference material cited in captures. | Auto-created when a source is referenced. |
| `comparison` | `comparisons/` | Side-by-side analysis of two or more entities/concepts (e.g., "drizzle-vs-prisma.md"). | Created by wiki-synthesis skill when contrasting entities are detected. |
| `synthesis` | `synthesis/` | Cross-cutting analysis that connects multiple entities/concepts into a narrative. | Created by wiki-synthesis skill or manual trigger. |
| `overview` | root (`/`) | Top-level pages like index.md, log.md, and this schema file. | Manual or during setup. |

---

## Frontmatter Conventions

Every wiki page MUST have YAML frontmatter with these required fields:

```yaml
---
title: Human-readable page title
type: entity | concept | source | comparison | synthesis | overview
created: 2026-04-11
updated: 2026-04-11
---
```

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `source_count` | number | Number of captures that contributed to this page. |
| `tags` | string[] | Categorization tags (e.g., `[infrastructure, docker]`). |
| `aliases` | string[] | Alternative names for this entity/concept. |
| `related` | string[] | Relative paths to related wiki pages. |
| `status` | string | Page maturity: `stub`, `draft`, `reviewed`, `stable`. |
| `confidence` | string | How well-supported the content is: `low`, `medium`, `high`. |

---

## Naming Conventions

- **Filenames:** lowercase, hyphen-separated, `.md` extension.
  - Entities: `entities/kubernetes.md`, `entities/troy-davis.md`
  - Concepts: `concepts/rag-architecture.md`
  - Comparisons: `comparisons/drizzle-vs-prisma.md`
- **No spaces or special characters** in filenames.
- **Singular nouns** for entities (not `entities/kubernetes-clusters.md`).

---

## Cross-Reference Syntax

Use standard markdown links with relative paths:

```markdown
See [Kubernetes](../entities/kubernetes.md) for container orchestration details.

Related: [RAG Architecture](../concepts/rag-architecture.md)
```

### Backlinks Section

Pages MAY include a `## Backlinks` section at the bottom, auto-maintained by the
wiki-lint skill:

```markdown
## Backlinks

- [Docker Compose](../concepts/docker-compose.md) — mentions this entity
- [Weekly Brief 2026-W15](../synthesis/weekly-2026-w15.md) — synthesized from
```

---

## Content Structure

### Entity Pages

```markdown
---
title: Kubernetes
type: entity
created: 2026-04-11
updated: 2026-04-11
source_count: 7
tags:
  - infrastructure
  - containers
aliases:
  - k8s
---

# Kubernetes

Brief description from accumulated captures.

## Key Points

- Point derived from captures
- Another point

## Context

How this entity relates to other things in the brain.

## Backlinks

- [link](path) — context
```

### Concept Pages

Similar to entity pages but focused on explaining the concept, its applications,
and connections to other concepts.

### Comparison Pages

```markdown
---
title: Drizzle vs Prisma
type: comparison
created: 2026-04-11
updated: 2026-04-11
tags:
  - orm
  - database
---

# Drizzle vs Prisma

## Summary

One-paragraph comparison overview.

## Comparison Table

| Aspect | Drizzle | Prisma |
|--------|---------|--------|
| ... | ... | ... |

## Recommendation

When to use each, based on captured experience.
```

---

## Log Convention

`log.md` is an append-only changelog of wiki operations:

```markdown
## 2026-04-11

- **Created** `entities/kubernetes.md` — from 3 captures about container orchestration
- **Updated** `concepts/rag-architecture.md` — added new retrieval strategy from capture abc123
```

Each entry includes the date, the operation (Created/Updated/Merged/Deleted),
the page path, and a brief reason sourced from the triggering capture.
SCHEMA_EOF

echo "Created WIKI_SCHEMA.md"

# --- index.md ---
cat > "${TARGET_DIR}/index.md" << 'INDEX_EOF'
---
title: Open Brain Wiki Index
type: overview
created: 2026-04-11
updated: 2026-04-11
---

# Open Brain Wiki

This wiki is automatically maintained by the Open Brain system. It synthesizes
knowledge from voice memos, Slack messages, emails, and other captured thoughts
into structured, interconnected pages.

## Directories

- [Entities](entities/) — People, projects, technologies, organizations
- [Concepts](concepts/) — Ideas, patterns, domain knowledge
- [Sources](sources/) — Books, articles, talks, references
- [Comparisons](comparisons/) — Side-by-side analyses
- [Synthesis](synthesis/) — Cross-cutting narratives and insights

## Recent Pages

*This section is auto-updated by the wiki-ingest worker.*

## Statistics

- **Total pages:** 0
- **Last updated:** 2026-04-11
INDEX_EOF

echo "Created index.md"

# --- log.md ---
cat > "${TARGET_DIR}/log.md" << 'LOG_EOF'
---
title: Wiki Change Log
type: overview
created: 2026-04-11
updated: 2026-04-11
---

# Wiki Change Log

Append-only record of all wiki operations performed by the wiki-ingest worker.

---

## 2026-04-11

- **Initialized** wiki repository structure
LOG_EOF

echo "Created log.md"

# --- .gitkeep files for empty directories ---
touch "${TARGET_DIR}/entities/.gitkeep"
touch "${TARGET_DIR}/concepts/.gitkeep"
touch "${TARGET_DIR}/sources/.gitkeep"
touch "${TARGET_DIR}/comparisons/.gitkeep"
touch "${TARGET_DIR}/synthesis/.gitkeep"

echo "Created .gitkeep files in empty directories."

# --- Initialize git if not already a repo ---
if [ ! -d "${TARGET_DIR}/.git" ]; then
  cd "${TARGET_DIR}"
  git init
  git add .
  git commit -m "Initial wiki structure: schema, index, log, directories"
  echo ""
  echo "Git repo initialized with initial commit."
  echo ""
  echo "Next steps:"
  echo "  1. Create the Gitea repo at gitea.k4jda.net/davistroy/open-brain-wiki"
  echo "  2. cd ${TARGET_DIR}"
  echo "  3. git remote add origin <gitea-repo-url>"
  echo "  4. git push -u origin main"
else
  echo "Git repo already exists at ${TARGET_DIR}, skipping init."
fi

echo ""
echo "=== Setup complete ==="
