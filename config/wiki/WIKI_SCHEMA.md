# Open Brain Wiki Schema

**Version:** 1.0
**Last Updated:** 2026-04-15

This document is the definitive reference for wiki page structure, conventions, and quality criteria. The wiki-ingest LLM agent must follow these rules when creating or updating pages.

---

## Page Types

The wiki uses 6 page types. Every page must declare exactly one type in its frontmatter.

| Type | Directory | When to Use | Examples |
|------|-----------|-------------|---------|
| `entity` | `entities/` | People, organizations, projects, tools, products, places | troy-davis.md, open-brain.md, chick-fil-a.md, clemson-university.md |
| `concept` | `concepts/` | Ideas, principles, methodologies, techniques, patterns | triz.md, cloud-migration.md, hebbian-learning.md |
| `source` | `sources/` | Summaries of ingested files, documents, emails, or external references | project-proposal-2024.md, quarterly-review-q3.md |
| `comparison` | `comparisons/` | Side-by-side analysis of alternatives, trade-off evaluations | react-vs-vue.md, cloud-providers-2025.md |
| `synthesis` | `synthesis/` | Aggregated knowledge from multiple captures spanning a topic | weekly-brief-2026-w15.md, ai-transformation-landscape.md |
| `overview` | `domains/` | Broad domain pages that organize and link to sub-topics | work.md, technology.md, sailing.md |

### Type Selection Rules

1. If the subject is a proper noun (person, company, project, tool) -> `entity`
2. If the subject is an abstract idea, method, or pattern -> `concept`
3. If the content summarizes a specific ingested file or document -> `source`
4. If the content compares two or more alternatives -> `comparison`
5. If the content aggregates knowledge from 3+ captures on a theme -> `synthesis`
6. If the content is a top-level domain organizer -> `overview`

When in doubt between `concept` and `synthesis`, prefer `concept` if the page is about a single well-defined topic, and `synthesis` if it weaves together multiple loosely related observations.

---

## Directory Structure

```
wiki/
  index.md              # Auto-generated table of contents
  log.md                # Ingest log (auto-maintained)
  domains/              # Overview pages (one per knowledge domain)
    work.md
    technology.md
    personal.md
    amateur-radio.md
    sailing.md
    making.md
    projects.md
    reference.md
  entities/             # People, orgs, projects, tools
  concepts/             # Ideas, methods, patterns
  sources/              # Document/file summaries
  synthesis/            # Multi-capture aggregations
  comparisons/          # Trade-off analyses
```

Do NOT create subdirectories within these directories. The wiki uses a flat structure within each type directory.

---

## Frontmatter Specification

Every wiki page requires YAML frontmatter. Fields marked **required** must always be present.

### Common Fields (all page types)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | **yes** | Human-readable page title in Title Case |
| `type` | string | **yes** | One of: entity, concept, source, comparison, synthesis, overview |
| `created` | string | **yes** | ISO date (YYYY-MM-DD) when the page was first created |
| `updated` | string | **yes** | ISO date (YYYY-MM-DD) of the most recent update |
| `source_count` | number | **yes** | Number of distinct captures/files that contributed to this page |
| `tags` | string[] | **yes** | Topic tags as an array (minimum 1 tag) |
| `aliases` | string[] | no | Alternative names for the subject (for search matching) |
| `source_captures` | string[] | no | Array of capture UUIDs that contributed to this page |
| `related_pages` | string[] | **yes** | Array of paths to related wiki pages (minimum 2) |

### Type-Specific Fields

**entity pages** additionally support:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `entity_type` | string | no | Sub-classification: person, organization, project, tool, place |

**source pages** additionally support:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source_path` | string | no | Original file path or URL of the source document |
| `source_type` | string | no | File type: pdf, docx, email, spreadsheet, presentation, etc. |

**overview pages** additionally support:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | no | The knowledge domain this page covers |

---

## Naming Conventions

### Filenames

- Use **kebab-case**: lowercase, words separated by hyphens
- Use `.md` extension
- No spaces, underscores, or special characters
- Keep filenames concise but descriptive (3-5 words max)
- Examples: `open-brain.md`, `cloud-migration.md`, `quarterly-review-q3-2025.md`

### Titles (in frontmatter)

- Use **Title Case**: capitalize major words
- Match the subject's canonical name for entities (e.g., "Troy Davis", "Stratfield Consulting")
- Be descriptive for concepts (e.g., "Cloud Migration Strategy", not just "Cloud")

### Tags

- Use **lowercase**, hyphen-separated
- Prefer established tags over creating new ones
- Core tag vocabulary: `ai`, `cloud`, `consulting`, `enterprise`, `personal`, `amateur-radio`, `sailing`, `making`, `electronics`, `finance`, `health`, `project`, `decision`, `architecture`, `devops`, `qsr`, `restaurant`, `transformation`, `open-brain`

---

## Cross-Reference Rules

Cross-references are the backbone of the wiki's knowledge graph. Every page MUST link to at least 2 other wiki pages.

### Hard Requirements

1. **Minimum 2 cross-references per page** -- no orphan pages allowed
2. All cross-referenced pages must appear in the `related_pages` frontmatter array
3. Use relative markdown links in body content: `[Link Text](../entities/page-name.md)`

### Link Format

- In page body: `[Display Text](../directory/filename.md)` -- standard relative markdown links
- In frontmatter `related_pages`: bare paths like `entities/troy-davis.md`, `domains/work.md`

### Cross-Reference Guidelines

- Entity pages should link to: projects they're involved in, domains they belong to, related entities
- Concept pages should link to: entities that use the concept, other related concepts, domain pages
- Source pages should link to: entities and concepts mentioned in the source, the relevant domain
- Synthesis pages should link to: all entity and concept pages that contributed, domain pages
- Overview/domain pages should link to: key entities, concepts, and sub-topics within the domain
- When creating a new page, actively search for existing pages to link to
- When updating an existing page, consider whether new cross-references should be added

### Reciprocal Links

When page A links to page B, page B should ideally link back to page A. This is a soft guideline, not a hard requirement -- the wiki-ingest agent should add reciprocal links when practical but should not update dozens of pages just to add back-links.

---

## Quality Criteria

### What Makes a Good Wiki Page

1. **Focused**: covers a single, well-defined topic
2. **Factual**: states facts and observations, not journal entries
3. **Connected**: links to 2+ other pages with meaningful relationships
4. **Structured**: uses markdown headers (##, ###) to organize sections
5. **Sourced**: attributes information to specific captures via `source_captures`
6. **Current**: includes dates for time-sensitive information ("As of 2026-04, ...")
7. **Concise**: stays under ~500 words; splits into sub-pages if growing longer

### Content Standards

- Write in clear, factual prose -- the wiki is a reference, not a journal
- Preserve existing content when updating -- add, don't replace (unless correcting errors)
- Synthesize and integrate knowledge -- do not copy capture content verbatim
- Include a "Sources" section at the bottom listing contributing captures
- For entity pages: include a brief summary paragraph at the top describing what/who the entity is

### What NOT to Include

- Trivial or purely transient information ("feeling tired today")
- Duplicate content already well-covered on another page
- Raw capture text without synthesis
- Deeply nested directory structures
- Pages with fewer than 2 cross-references (orphan pages)

---

## Bootstrap Pages

The wiki starts with pre-seeded domain overview pages and key entity pages. These provide structural anchors that wiki-ingest can link to when processing new captures.

### Domain Pages (in `domains/`)

| Page | Domain | Covers |
|------|--------|--------|
| work.md | Work | Consulting, enterprise IT, QSR/restaurant operations, clients |
| technology.md | Technology | AI, cloud, infrastructure, software development |
| personal.md | Personal | Family, health, finances, life management |
| amateur-radio.md | Amateur Radio | K4JDA, ARES, equipment, contacts, propagation |
| sailing.md | Sailing | PRO, race management, boats, regattas |
| making.md | Making | Electronics, microcontrollers, 3D printing, workshop |
| projects.md | Projects | Active project index, status tracking |
| reference.md | Reference | Research, documentation, guides, learning resources |

### Entity Bootstrap Pages (in `entities/`)

| Page | Entity | Why Bootstrapped |
|------|--------|-----------------|
| open-brain.md | Open Brain | This system -- meta-reference for self-knowledge |
| troy-davis.md | Troy Davis | The user -- central node for all personal knowledge |
| stratfield-consulting.md | Stratfield Consulting | Troy's consultancy -- links work and personal domains |

These bootstrap pages are templates. Wiki-ingest will refine and expand them as it processes captures.
