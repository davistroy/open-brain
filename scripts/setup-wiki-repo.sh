#!/usr/bin/env bash
# setup-wiki-repo.sh — Create and initialize the open-brain-wiki repository.
#
# This script:
#   1. Creates the open-brain-wiki repo on Gitea via API (if it doesn't exist)
#   2. Clones it locally
#   3. Initializes the directory structure per PRD-UNIFIED §5.4
#   4. Authors WIKI_SCHEMA.md, index.md, log.md, overview.md
#   5. Commits and pushes the initial structure
#
# Usage:
#   GITEA_TOKEN=<your-token> ./scripts/setup-wiki-repo.sh [target-dir]
#
# Environment variables:
#   GITEA_URL       — Gitea base URL (default: https://gitea.k4jda.net)
#   GITEA_TOKEN     — Gitea API token (required for repo creation)
#   GITEA_USER      — Gitea username (default: davistroy)
#   GITEA_SSH_URL   — SSH clone URL override (default: derived from GITEA_URL)
#   REPO_NAME       — Repository name (default: open-brain-wiki)
#
# If GITEA_TOKEN is not set, the script skips API calls and initializes
# the directory structure locally (useful for dev/testing).

set -euo pipefail

# --- Configuration ---
GITEA_URL="${GITEA_URL:-https://gitea.k4jda.net}"
GITEA_USER="${GITEA_USER:-davistroy}"
REPO_NAME="${REPO_NAME:-open-brain-wiki}"
TARGET_DIR="${1:-/tmp/${REPO_NAME}}"
TODAY=$(date +%Y-%m-%d)

echo "=== Open Brain Wiki — Repository Setup ==="
echo "Gitea:  ${GITEA_URL}"
echo "User:   ${GITEA_USER}"
echo "Repo:   ${REPO_NAME}"
echo "Target: ${TARGET_DIR}"
echo ""

# --- Step 1: Create Gitea repository via API ---
if [ -n "${GITEA_TOKEN:-}" ]; then
  echo "--- Step 1: Creating Gitea repository ---"

  # Check if repo already exists
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: token ${GITEA_TOKEN}" \
    "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${REPO_NAME}")

  if [ "$HTTP_STATUS" = "200" ]; then
    echo "Repository already exists at ${GITEA_URL}/${GITEA_USER}/${REPO_NAME}"
  elif [ "$HTTP_STATUS" = "404" ]; then
    echo "Creating repository ${GITEA_USER}/${REPO_NAME}..."
    CREATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: token ${GITEA_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{
        \"name\": \"${REPO_NAME}\",
        \"description\": \"LLM-maintained knowledge wiki for Open Brain. Auto-generated from captures, documents, and synthesis.\",
        \"private\": true,
        \"auto_init\": false,
        \"default_branch\": \"main\"
      }" \
      "${GITEA_URL}/api/v1/user/repos")

    CREATE_STATUS=$(echo "$CREATE_RESPONSE" | tail -1)
    if [ "$CREATE_STATUS" = "201" ]; then
      echo "Repository created successfully."
    else
      echo "ERROR: Failed to create repository (HTTP ${CREATE_STATUS})"
      echo "$CREATE_RESPONSE" | head -n -1
      exit 1
    fi
  else
    echo "ERROR: Unexpected status ${HTTP_STATUS} checking for repository."
    exit 1
  fi

  # Clone the repo (or init fresh if empty)
  CLONE_URL="${GITEA_SSH_URL:-${GITEA_URL}/${GITEA_USER}/${REPO_NAME}.git}"

  if [ -d "${TARGET_DIR}/.git" ]; then
    echo "Git repo already exists at ${TARGET_DIR}, pulling latest..."
    cd "${TARGET_DIR}" && git pull --rebase || true
  elif [ -d "${TARGET_DIR}" ]; then
    echo "Directory exists but is not a git repo. Initializing..."
    cd "${TARGET_DIR}"
    git init -b main
    git remote add origin "${CLONE_URL}" 2>/dev/null || true
  else
    echo "Cloning ${CLONE_URL} into ${TARGET_DIR}..."
    git clone "${CLONE_URL}" "${TARGET_DIR}" 2>/dev/null || {
      echo "Clone failed (repo may be empty). Initializing locally..."
      mkdir -p "${TARGET_DIR}"
      cd "${TARGET_DIR}"
      git init -b main
      git remote add origin "${CLONE_URL}"
    }
  fi
else
  echo "--- Step 1: GITEA_TOKEN not set, skipping API calls ---"
  echo "Creating local directory structure only."
  mkdir -p "${TARGET_DIR}"
  if [ ! -d "${TARGET_DIR}/.git" ]; then
    cd "${TARGET_DIR}"
    git init -b main
  fi
fi

cd "${TARGET_DIR}"
echo ""

# --- Step 2: Create directory structure (PRD-UNIFIED §5.4) ---
echo "--- Step 2: Creating directory structure ---"

WIKI_DIRS=(
  "wiki/sources"
  "wiki/entities"
  "wiki/projects"
  "wiki/domains"
  "wiki/concepts"
  "wiki/comparisons"
  "wiki/synthesis"
  "wiki/operations"
  "wiki/maintenance"
)

for dir in "${WIKI_DIRS[@]}"; do
  mkdir -p "${TARGET_DIR}/${dir}"
  touch "${TARGET_DIR}/${dir}/.gitkeep"
done

echo "Created ${#WIKI_DIRS[@]} wiki subdirectories with .gitkeep files."
echo ""

# --- Step 3: Author WIKI_SCHEMA.md ---
echo "--- Step 3: Authoring WIKI_SCHEMA.md ---"

cat > "${TARGET_DIR}/WIKI_SCHEMA.md" << 'SCHEMA_EOF'
# Open Brain Wiki Schema

This document defines the structure, conventions, and page types for the Open Brain wiki.
The wiki is an LLM-maintained knowledge base that grows organically from captured thoughts,
voice memos, Slack messages, emails, documents, and file ingestion. It is Git-backed
(Gitea at gitea.k4jda.net) and managed programmatically by the wiki-ingest, wiki-lint,
and wiki-synthesis workers in the Open Brain pipeline.

The core philosophy: **knowledge compounds rather than re-derives.** Every query answer,
every synthesis, every connection discovered gets written back to the wiki so future
queries start from accumulated understanding, not raw captures.

---

## Directory Structure

```
open-brain-wiki/
  WIKI_SCHEMA.md            # This file — conventions, templates, workflows
  index.md                  # Catalog of all pages with one-line summaries
  log.md                    # Append-only chronological record of all operations
  overview.md               # Top-level summary of the entire wiki
  wiki/
    sources/                # One summary page per ingested source file or capture cluster
    entities/               # Pages for people, companies, organizations
    projects/               # Pages for projects and engagements
    domains/                # Pages for knowledge domains and practice areas
    concepts/               # Pages for frameworks, methodologies, technologies
    comparisons/            # Side-by-side analyses of two or more items
    synthesis/              # Cross-cutting analyses, filed query results
    operations/             # Cost reports, storage reports (infrastructure skill outputs)
    maintenance/            # Lint reports, health checks
```

---

## Page Types

| Type | Directory | Description | When Created |
|------|-----------|-------------|--------------|
| `source` | `wiki/sources/` | Summary of a specific ingested document, file, or capture cluster. One page per source. | Auto-created by wiki-ingest when a new document or capture cluster is processed. |
| `entity` | `wiki/entities/` | A person, company, organization, or system that appears across multiple captures. | Auto-created when an entity is mentioned in 3+ captures or linked to 3+ wiki pages. |
| `project` | `wiki/projects/` | A project, engagement, or initiative with defined scope and timeline. | Auto-created when project-related captures cluster, or manually via MCP. |
| `domain` | `wiki/domains/` | A knowledge domain or practice area (e.g., "contact-center-operations", "ai-transformation"). | Auto-created when enough entities/concepts cluster in a domain. |
| `concept` | `wiki/concepts/` | An idea, framework, methodology, or technology worth tracking. | Auto-created when a concept cluster is detected across captures. |
| `comparison` | `wiki/comparisons/` | Side-by-side analysis of two or more entities, concepts, or technologies. | Created by wiki-synthesis skill when contrasting items are detected, or via MCP. |
| `synthesis` | `wiki/synthesis/` | Cross-cutting analysis connecting multiple entities/concepts into a narrative. Also stores filed query results worth preserving. | Created by wiki-synthesis skill or when a query answer is worth persisting. |
| `overview` | root (`/`) | Top-level pages: index.md, log.md, overview.md, this schema file. | Manual or during setup. |

### Operations and Maintenance Pages

| Type | Directory | Description |
|------|-----------|-------------|
| `operations` | `wiki/operations/` | Infrastructure skill outputs: cost analysis reports, storage audit reports, budget summaries. Written by the cost-analysis and storage-audit skills. |
| `maintenance` | `wiki/maintenance/` | Wiki health reports: lint results, orphan page lists, contradiction flags, schema validation. Written by the wiki-lint skill. |

---

## YAML Frontmatter Specification

Every wiki page MUST have YAML frontmatter. The frontmatter is machine-parsed by
WikiGitService and wiki-lint for validation, indexing, and cross-reference maintenance.

### Required Fields

```yaml
---
title: "Human-readable page title"
type: entity | concept | source | comparison | synthesis | overview | project | domain
created: 2026-04-11
updated: 2026-04-11
---
```

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable page title. Used in index.md and cross-references. |
| `type` | string | One of: `entity`, `concept`, `source`, `comparison`, `synthesis`, `overview`, `project`, `domain`. |
| `created` | date | ISO 8601 date (YYYY-MM-DD) when the page was first created. Never changes. |
| `updated` | date | ISO 8601 date (YYYY-MM-DD) of the most recent update. Updated on every edit. |

### Optional Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `source_count` | number | Number of captures that contributed to this page. Serves as a confidence proxy: 1 source = tentative, 5+ = well-supported. | `source_count: 7` |
| `source_captures` | string[] | UUIDs of Postgres captures that contributed to this page. Bidirectional link -- captures also track `wiki_pages` in metadata. | `source_captures: [uuid-1, uuid-2]` |
| `tags` | string[] | Categorization tags for filtering and grouping. | `tags: [infrastructure, docker, deployment]` |
| `related_pages` | string[] | Relative paths to related wiki pages. Maintained by wiki-lint backlink scanner. | `related_pages: [entities/chick-fil-a.md, concepts/triz.md]` |
| `source_removed` | boolean | Set to `true` when the source file (e.g., OneDrive document) has been deleted. Page is preserved but marked as having lost its primary source. Default: `false`. | `source_removed: false` |
| `aliases` | string[] | Alternative names for this entity/concept. Used by search and cross-referencing. | `aliases: [k8s, kube]` |
| `status` | string | Page maturity: `stub`, `draft`, `reviewed`, `stable`. Newly created pages start as `stub`. | `status: draft` |
| `confidence` | string | How well-supported the content is: `low` (1 source), `medium` (2-4 sources), `high` (5+ sources). Derived from `source_count`. | `confidence: high` |
| `domain` | string | Primary knowledge domain this page belongs to. | `domain: ai-transformation` |

### Full Frontmatter Example

```yaml
---
title: "Chick-fil-A Support Now"
type: entity
created: 2026-04-11
updated: 2026-04-15
source_count: 12
source_captures:
  - "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  - "b2c3d4e5-f6a7-8901-bcde-f12345678901"
tags:
  - consulting
  - qsr
  - contact-center
related_pages:
  - "wiki/projects/support-now-implementation.md"
  - "wiki/domains/contact-center-operations.md"
  - "wiki/concepts/servicenow-csm.md"
source_removed: false
aliases:
  - "CFA Support Now"
  - "Support Now"
status: reviewed
confidence: high
domain: contact-center-operations
---
```

---

## Naming Conventions

### Filenames

- **Format:** lowercase, kebab-case (hyphen-separated), `.md` extension
- **No spaces or special characters** in filenames
- **Singular nouns** for entities (`kubernetes.md`, not `kubernetes-clusters.md`)
- **Descriptive but concise** -- aim for 2-4 words

#### Examples by Type

| Type | Pattern | Examples |
|------|---------|---------|
| Entity | `wiki/entities/{name}.md` | `troy-davis.md`, `chick-fil-a.md`, `coca-cola-bsna.md` |
| Project | `wiki/projects/{project-name}.md` | `support-now-implementation.md`, `open-brain-v2.md` |
| Domain | `wiki/domains/{domain-name}.md` | `contact-center-operations.md`, `ai-transformation.md` |
| Concept | `wiki/concepts/{concept-name}.md` | `rag-architecture.md`, `change-management.md`, `triz.md` |
| Source | `wiki/sources/{date}-{descriptive-name}.md` | `2026-04-10-pipecat-architecture-research.md` |
| Comparison | `wiki/comparisons/{item-a}-vs-{item-b}.md` | `drizzle-vs-prisma.md`, `bullmq-vs-rabbitmq.md` |
| Synthesis | `wiki/synthesis/{descriptive-name}.md` | `contact-center-ai-transformation-thesis.md` |
| Operations | `wiki/operations/{report-type}-{date}.md` | `cost-analysis-2026-04.md`, `storage-audit-2026-w15.md` |
| Maintenance | `wiki/maintenance/{check-type}-{date}.md` | `lint-report-2026-w15.md`, `health-check-2026-04-11.md` |

### Source Page Naming

Source pages use a date prefix to ensure chronological ordering:
- Format: `{YYYY-MM-DD}-{descriptive-slug}.md`
- The date is when the source was ingested, not when the original was created
- Multiple sources on the same day get distinct slugs

---

## Cross-Reference Format

Use standard markdown links with **relative paths** from the referencing file:

```markdown
See [Kubernetes](../entities/kubernetes.md) for container orchestration details.

Related: [RAG Architecture](../concepts/rag-architecture.md)

This builds on the [Contact Center AI Transformation](../synthesis/contact-center-ai-transformation-thesis.md) thesis.
```

### Rules

1. **Always use relative paths** (not absolute). Paths are relative to the linking page's directory.
2. **Link text should be the page title** or a natural description, not the filename.
3. **Bidirectional links** are preferred. When page A links to page B, page B should link back to page A (maintained by wiki-lint).
4. **Cross-directory links** use `../` to navigate up from the current directory:
   - From `wiki/entities/kubernetes.md` to `wiki/concepts/rag-architecture.md`: `[RAG Architecture](../concepts/rag-architecture.md)`
   - From `wiki/synthesis/foo.md` to `wiki/entities/bar.md`: `[Bar](../entities/bar.md)`
5. **Root-level links** from pages inside `wiki/` use `../../`: `[Index](../../index.md)`

### Backlinks Section

Pages MAY include a `## Backlinks` section at the bottom, auto-maintained by the
wiki-lint skill. This section lists all pages that link TO this page:

```markdown
## Backlinks

- [Docker Compose](../concepts/docker-compose.md) -- mentions this entity
- [Weekly Brief 2026-W15](../synthesis/weekly-2026-w15.md) -- synthesized from
- [Q3 Sales Deck Summary](../sources/2026-04-10-q3-sales-deck.md) -- source material
```

---

## Content Structure Templates

### Entity Pages

```markdown
---
title: "Entity Name"
type: entity
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_count: N
source_captures: [...]
tags: [...]
related_pages: [...]
---

# Entity Name

Brief description synthesized from accumulated captures.

## Key Points

- Point derived from captures (with source traceability)
- Another point

## Context

How this entity relates to other things in the brain. Cross-references to
related entities, projects, and concepts.

## Timeline

Chronological events related to this entity, if applicable.

## Sources

- [Source 1](../sources/date-source-name.md) -- contributed key points X, Y
- [Source 2](../sources/date-source-name.md) -- contributed context on Z

## Backlinks

- [link](path) -- context
```

### Concept Pages

```markdown
---
title: "Concept Name"
type: concept
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_count: N
tags: [...]
---

# Concept Name

What this concept is and why it matters.

## How It Works

Explanation at practitioner depth.

## Applications

Where and how this concept has been applied (from captures).

## Trade-offs

Strengths, weaknesses, and when to use alternatives.

## Related Concepts

- [Related A](../concepts/related-a.md) -- relationship description
- [Related B](../concepts/related-b.md) -- relationship description

## Sources

- [Source](path) -- what it contributed

## Backlinks

- [link](path) -- context
```

### Comparison Pages

```markdown
---
title: "Item A vs Item B"
type: comparison
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [...]
---

# Item A vs Item B

## Summary

One-paragraph comparison overview.

## Comparison Table

| Aspect | Item A | Item B |
|--------|--------|--------|
| ... | ... | ... |

## When to Use Each

Decision guidance based on captured experience.

## Sources

- [Source](path) -- what it contributed

## Backlinks

- [link](path) -- context
```

### Source Pages

```markdown
---
title: "Source Document Title"
type: source
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_count: 1
source_captures: ["capture-uuid"]
tags: [...]
source_removed: false
---

# Source Document Title

## Summary

Concise summary of the source material.

## Key Takeaways

- Takeaway 1
- Takeaway 2

## Entities Mentioned

- [Entity A](../entities/entity-a.md)
- [Entity B](../entities/entity-b.md)

## Concepts Referenced

- [Concept A](../concepts/concept-a.md)

## Original Source

- **File:** original-filename.ext
- **Ingested:** YYYY-MM-DD
- **Type:** PDF / DOCX / voice memo / email / etc.
```

### Synthesis Pages

```markdown
---
title: "Synthesis Title"
type: synthesis
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_count: N
source_captures: [...]
tags: [...]
related_pages: [...]
---

# Synthesis Title

## Thesis

One-paragraph summary of the cross-cutting analysis.

## Analysis

Detailed narrative connecting multiple entities, concepts, and sources.

## Evidence

- [Source 1](path) -- what it supports
- [Source 2](path) -- what it supports

## Implications

What this synthesis means for decision-making or future work.

## Open Questions

Unresolved questions identified during synthesis.

## Backlinks

- [link](path) -- context
```

---

## Operations and Maintenance Pages

### Operations Reports (wiki/operations/)

Infrastructure skill outputs written here by cost-analysis and storage-audit skills.
These are append-per-period (monthly cost reports, weekly storage audits).

```markdown
---
title: "Cost Analysis - April 2026"
type: operations
created: 2026-04-01
updated: 2026-04-30
tags: [cost, infrastructure, monthly]
---

# Cost Analysis - April 2026

## Summary

Total spend: $X.XX (soft limit: $20, hard limit: $35)

## Breakdown by Provider

| Provider | Spend | Calls | Avg Cost/Call |
|----------|-------|-------|---------------|
| ... | ... | ... | ... |
```

### Maintenance Reports (wiki/maintenance/)

Wiki-lint skill writes health reports here.

```markdown
---
title: "Wiki Lint Report - 2026-W15"
type: maintenance
created: 2026-04-11
updated: 2026-04-11
tags: [lint, health, weekly]
---

# Wiki Lint Report - 2026-W15

## Summary

- Pages scanned: N
- Issues found: N
- Orphan pages: N
- Broken links: N
- Missing frontmatter: N

## Issues

### Orphan Pages (no inbound links)
- wiki/entities/orphan.md

### Broken Links
- wiki/concepts/foo.md -> wiki/entities/missing.md (404)
```

---

## Log Convention (log.md)

`log.md` is an append-only chronological record of all wiki operations. Each entry
uses a parseable format with date, operation type, and target:

```markdown
## [2026-04-11] ingest | Q3 Sales Deck.pptx
Created wiki/sources/2026-04-11-q3-sales-deck.md from document ingestion.
Updated wiki/entities/chick-fil-a.md with new context (source_count 11 -> 12).

## [2026-04-11] query | Relationship between TRIZ and automation scoring
Created wiki/synthesis/triz-automation-scoring.md from query synthesis.

## [2026-04-11] lint | 3 orphan pages, 2 contradictions flagged
Created wiki/maintenance/lint-report-2026-w15.md.

## [2026-04-11] synthesis | Weekly cross-cutting analysis
Updated wiki/synthesis/contact-center-ai-transformation-thesis.md.
Created wiki/comparisons/bullmq-vs-rabbitmq.md.
```

### Operation Types

| Prefix | Meaning |
|--------|---------|
| `ingest` | New source material processed into wiki pages |
| `query` | Query answer persisted as a synthesis page |
| `lint` | Wiki-lint health check results |
| `synthesis` | Cross-cutting analysis by wiki-synthesis skill |
| `merge` | Pages merged due to overlap (memory consolidation) |
| `update` | Existing page updated with new information |
| `delete` | Page removed (with reason) |

---

## Index Convention (index.md)

`index.md` is the catalog of all wiki pages. The LLM reads this first when answering
queries to identify relevant pages without needing embedding-based retrieval.

Organized by type, each entry has: link, one-line summary, and tag list.

```markdown
## Entities

- [Chick-fil-A](wiki/entities/chick-fil-a.md) -- QSR chain, consulting client for Support Now. `consulting` `qsr`
- [Troy Davis](wiki/entities/troy-davis.md) -- System owner. `personal`

## Concepts

- [RAG Architecture](wiki/concepts/rag-architecture.md) -- Retrieval-augmented generation patterns. `ai` `architecture`
```

---

## Validation Rules (enforced by wiki-lint)

1. **Every page must have valid YAML frontmatter** with all required fields.
2. **`type` must be one of the defined page types.**
3. **`created` date must not be in the future.**
4. **`updated` must be >= `created`.**
5. **Filenames must be kebab-case** (lowercase, hyphens, `.md` extension only).
6. **No orphan pages** (every page should have at least one inbound link from another page or index.md).
7. **No broken cross-references** (all relative links must resolve to existing files).
8. **`source_count` must match `source_captures` array length** (when both are present).
9. **`source_removed` pages should be flagged** for review.
10. **Duplicate page detection**: no two pages should cover the same entity/concept (flag for merge).

---

## WikiGitService API Contract

The `WikiGitService` in `@open-brain/shared` provides programmatic access:

| Method | Description |
|--------|-------------|
| `clone()` | Clone repo to local path (first run) |
| `pull()` | Pull latest changes |
| `readPage(path)` | Read and parse a wiki page (frontmatter + body) |
| `writePage(path, frontmatter, body)` | Write a page, commit, push |
| `listPages(type?)` | List all pages, optionally filtered by type |
| `search(query)` | Search page titles and content |
| `appendLog(entry)` | Append to log.md |
| `updateIndex()` | Regenerate index.md from current pages |
SCHEMA_EOF

echo "Created WIKI_SCHEMA.md"

# --- Step 4: Author index.md ---
echo "--- Step 4: Authoring index.md ---"

cat > "${TARGET_DIR}/index.md" << EOF
---
title: "Open Brain Wiki Index"
type: overview
created: ${TODAY}
updated: ${TODAY}
---

# Open Brain Wiki

This wiki is automatically maintained by the Open Brain system. It synthesizes
knowledge from voice memos, Slack messages, emails, documents, and ingested files
into structured, interconnected pages.

The wiki is the **persistent knowledge layer** -- knowledge compounds here rather
than being re-derived from raw captures on every query.

## Directories

- [Sources](wiki/sources/) -- Summaries of ingested documents and capture clusters
- [Entities](wiki/entities/) -- People, companies, organizations
- [Projects](wiki/projects/) -- Projects, engagements, initiatives
- [Domains](wiki/domains/) -- Knowledge domains and practice areas
- [Concepts](wiki/concepts/) -- Frameworks, methodologies, technologies
- [Comparisons](wiki/comparisons/) -- Side-by-side analyses
- [Synthesis](wiki/synthesis/) -- Cross-cutting narratives and insights
- [Operations](wiki/operations/) -- Cost reports, storage audits
- [Maintenance](wiki/maintenance/) -- Lint reports, health checks

## Pages by Type

### Entities

*No pages yet.*

### Projects

*No pages yet.*

### Domains

*No pages yet.*

### Concepts

*No pages yet.*

### Sources

*No pages yet.*

### Comparisons

*No pages yet.*

### Synthesis

*No pages yet.*

## Statistics

- **Total pages:** 0
- **Last updated:** ${TODAY}
EOF

echo "Created index.md"

# --- Step 5: Author log.md ---
echo "--- Step 5: Authoring log.md ---"

cat > "${TARGET_DIR}/log.md" << EOF
---
title: "Wiki Change Log"
type: overview
created: ${TODAY}
updated: ${TODAY}
---

# Wiki Change Log

Append-only chronological record of all wiki operations. Each entry uses the format:

\`\`\`
## [YYYY-MM-DD] operation_type | Subject
Description of what was done.
\`\`\`

See [WIKI_SCHEMA.md](WIKI_SCHEMA.md) for operation type definitions.

---

## [${TODAY}] ingest | Repository initialization
Initialized wiki repository structure with 9 subdirectories, schema definition,
index catalog, and this change log.
EOF

echo "Created log.md"

# --- Step 6: Author overview.md ---
echo "--- Step 6: Authoring overview.md ---"

cat > "${TARGET_DIR}/overview.md" << EOF
---
title: "Open Brain Wiki Overview"
type: overview
created: ${TODAY}
updated: ${TODAY}
---

# Open Brain Wiki Overview

This is the persistent knowledge layer of the Open Brain system -- a personal AI
knowledge infrastructure that captures thoughts from voice memos, Slack, email,
and documents, then synthesizes them into structured, interconnected wiki pages.

## Purpose

The wiki implements the Karpathy pattern: **knowledge compounds rather than
re-derives.** Instead of re-processing raw captures on every query, the system
builds and maintains a structured knowledge base that grows smarter over time.

## How It Works

1. **Capture** -- Thoughts arrive via voice memos, Slack, email, or document upload.
2. **Process** -- The BullMQ pipeline extracts entities, generates embeddings, and
   classifies content.
3. **Ingest** -- The wiki-ingest worker creates or updates wiki pages based on
   new captures.
4. **Synthesize** -- The wiki-synthesis skill identifies cross-cutting themes and
   creates synthesis pages.
5. **Maintain** -- The wiki-lint skill validates structure, fixes broken links,
   and flags issues.

## Key Topics

*This section will be auto-updated as the wiki grows, highlighting the most
connected and frequently referenced topics.*

## Statistics

- **Total pages:** 0
- **Total entities:** 0
- **Total concepts:** 0
- **Total sources:** 0
- **Last synthesis run:** Never
- **Last lint run:** Never
EOF

echo "Created overview.md"

# --- Step 7: Git commit and push ---
echo ""
echo "--- Step 7: Git commit and push ---"

cd "${TARGET_DIR}"
git add -A

# Check if there are changes to commit
if git diff --cached --quiet; then
  echo "No changes to commit (structure already exists)."
else
  git commit -m "Initialize wiki: schema, index, log, overview, 9 directories

Directories: sources, entities, projects, domains, concepts,
comparisons, synthesis, operations, maintenance.

Schema defines: page types, YAML frontmatter spec, naming
conventions (kebab-case), cross-reference format (relative
markdown links), log convention, validation rules.

Per PRD-UNIFIED sections 5.4-5.7."

  echo "Committed initial wiki structure."

  # Push if remote exists
  if git remote get-url origin &>/dev/null; then
    echo "Pushing to origin..."
    git push -u origin main && echo "Pushed successfully." || {
      echo ""
      echo "Push failed. You may need to:"
      echo "  1. Verify SSH key is configured for Gitea"
      echo "  2. Run: cd ${TARGET_DIR} && git push -u origin main"
    }
  else
    echo ""
    echo "No remote configured. To push:"
    echo "  1. git remote add origin <gitea-repo-url>"
    echo "  2. git push -u origin main"
  fi
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Wiki structure at ${TARGET_DIR}:"
echo ""
find "${TARGET_DIR}" -not -path '*/.git/*' -not -path '*/.git' -type f | sort | sed "s|${TARGET_DIR}/||"
echo ""
echo "Next steps:"
echo "  1. Verify repo at ${GITEA_URL}/${GITEA_USER}/${REPO_NAME}"
echo "  2. Set WIKI_REPO_URL and WIKI_LOCAL_PATH in docker-compose.yml"
echo "  3. Deploy wiki-ingest worker (Phase 3.3)"
