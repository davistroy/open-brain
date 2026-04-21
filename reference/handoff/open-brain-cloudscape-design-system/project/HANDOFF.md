# Open Brain — Handoff to Claude Code

This document turns the design prototype in this project into a buildable spec.
Hand this file to Claude Code along with the project zip and it should be able
to scaffold the production app without re-asking most questions.

---

## 1. What this is

**Open Brain** is a personal second-brain product. It ingests captures (voice
notes, emails, calendar events, Slack, Drive), runs extraction to build a
knowledge graph (entities, decisions, commitments, projects), and ships AI
drafted **briefs** on a schedule (daily / weekly / dossier / decision / project).

The prototype in this project is **design-only** — HTML + React via Babel,
inline. There is no backend and no real data. Treat it as a pixel-accurate
spec, not a codebase.

---

## 2. What has been designed & approved

13 desktop screens (1440 × 900, single breakpoint). All reviewed and approved.

| # | Screen | File |
|---|---|---|
| 01 | Dashboard | `screens/01-dashboard.html` |
| 02a | Search — flat results | `screens/02a-search-flat.html` |
| 02b | Search — grouped by entity | `screens/02b-search-grouped.html` |
| 03 | Timeline | `screens/03-timeline.html` |
| 04 | Ingest pipeline | `screens/04-ingest.html` |
| 05 | Entities — index | `screens/05-entities.html` |
| 06 | Entity detail (dossier) | `screens/06-entity-detail.html` |
| 07 | Briefs — library | `screens/07-briefs.html` |
| 08 | Brief — reader | `screens/08-brief-detail.html` |
| 09 | Board (decisions/commitments) | `screens/09-board.html` |
| 10 | Capture detail (voice) | `screens/10-capture-detail.html` |
| 11 | Settings — sources | `screens/11-settings.html` |
| 12 | Empty states showcase | `screens/12-empty-states.html` |
| 13 | First-run / onboarding | `screens/13-onboarding.html` |

The design canvas at **`index.html`** presents all 13 in one pan/zoom document.

---

## 3. Design system

### Tokens (`colors_and_type.css`)

Source of truth. Do not re-derive colors from screenshots.

**Palette** (anchors):
- `--color-ivory-medium` `#F0EEE6` — page canvas
- `--color-ivory-dark` `#E8E6DB` — subtle fills
- `--color-slate-dark` `#141413` — top nav & strongest ink
- `--color-slate-medium` `#262624` — body ink
- `--color-book-cloth` `#CC785C` — **primary accent** (terracotta). Used for
  CTAs, active rails, underline markers, links.
- `--color-book-cloth-50` `#EFE6D8` — soft-wash fill (see below)
- `--color-book-cloth-100` `#DACDB6` — slightly deeper wash
- `--color-moss` `#7A8471`, `--color-clay` `#6B4A3A`, `--color-kraft` `#D4A27F`
  — secondary earth tones used on brief category covers

**Wash** (`data-wash` attribute on `<html>`): default is **parchment**
(`#EFE6D8` / `#DACDB6`). Alternatives `kraft`, `moss`, `peach` are defined but
parchment is the approved shipping default. Leave the attribute off to fall
through to peach if you ever need the original.

**Typography**:
- Display: **Space Grotesk** (300–700). Used for H1/H2, hero numbers, brief
  titles. Tight letter-spacing (`-0.02em` typical).
- Body: **Inter** (200–700). 13–14.5px base, weight 300 for secondary copy.
- Mono: **JetBrains Mono** (400–500). ALL-CAPS eyebrows (10–11px,
  `letter-spacing: 0.08em`) and metadata labels.
- Fonts ship locally from `fonts/*.woff2`. No CDN dependency.

**Shape & motion**:
- Hard corners. `border-radius: 0` everywhere. No soft pill shapes.
- 1-px borders, `--color-cloud-light` (#E4E2DC) for dividers, `--color-cloud-medium`
  (#C2C0B6) for controls.
- Transitions 120ms ease for hover; 180ms for drag settles. No bounce easing.

**Voice & tone** (see `screens/12-empty-states.html`):
- Editorial, dry, literate. Never chirpy.
- Eyebrow labels in mono + all-caps; body sentences in Inter.
- Empty states: name the silence, offer one action, keep the voice.

### Components

Prototype components live in `screens/_shell.jsx` (`Shell`, `SCard`, `SBtn`,
`SInput`, `Pill`, `MetaLine`, `Eyebrow`, `EmptyState`) and
`ui_kits/dashboard/` (`TopNav`, `SideNav`, `Button`, `Badge`, `Container`).

**Don't port these files literally** — they're inline-Babel scaffolding. Rebuild
as proper React components in your target framework, matching the visual
contract defined by the screens. Treat `_shell.jsx` as the reference
implementation for spacing, padding, and breadcrumb/title patterns.

### Information architecture

Left nav is grouped by mental model, not by technical domain:

```
WORKSPACE
  — workspace switcher
CAPTURE
  Dashboard · Search · Timeline
  Ingest · Voice capture · Email bridge
KNOWLEDGE
  Entities · Wiki · Briefs · Intelligence
GOVERNANCE
  Board · Financial · Investments
SYSTEM
  System status · Settings
```

---

## 4. Data model (inferred from designs)

The screens imply these entities. Types are suggestive; finalize in your DB.

```ts
Capture { id, kind: 'voice'|'email'|'calendar'|'slack'|'drive'|'manual',
          capturedAt, source, rawBody?, transcript?, audioUrl?, durationMs?,
          status: 'ingesting'|'indexed'|'archived'|'skipped',
          entities: EntityRef[], decisions: DecisionRef[] }
Entity  { id, kind: 'person'|'project'|'topic'|'org'|'location'|'decision',
          name, aliases[], firstSeen, lastSeen, captureCount, summary,
          facts: Fact[], relations: EntityRef[] }
Brief   { id, kind: 'daily'|'weekly'|'dossier'|'decision'|'project',
          title, generatedAt, scheduledFor, sections[], citations[CaptureRef],
          readAt? }
Decision { id, title, state: 'open'|'made'|'stalled', pros[], cons[],
           candidates[], owner, due?, relatedCaptures[] }
Commitment { id, text, owner, due, source: CaptureRef, state: 'open'|'done'|'dropped' }
Source  { id, kind, config (scoped), authStatus: 'healthy'|'degraded'|'error',
          lastSyncAt, counters }
```

Key invariants:
- Everything traces back to a Capture (no orphan facts).
- Entities are append-only — deletion = archive.
- Briefs are snapshots, not live views. Regenerating creates a new Brief.

---

## 5. Build recommendations

- **Framework**: Next.js (App Router) or Remix. SSR the reader surfaces
  (Brief detail, Entity detail) for shareability.
- **State**: Server actions + React Query. No Redux.
- **Storage**: Postgres for entities/briefs/captures; object storage for audio.
- **Search**: Typesense or Postgres `pg_trgm` + `pgvector` — screens 02a/02b
  imply hybrid lexical + semantic.
- **Extraction pipeline**: background workers, OpenAI/Anthropic API for
  entity extraction + brief drafting. Rate-limit per source.
- **Auth**: magic link + passkey. Single-user for v1 (the product is personal).

---

## 6. Phasing

**Milestone 1 — read-only shell** (1–2 weeks)
- Tokens + typography + layout primitives (TopNav, SideNav, Shell)
- Dashboard, Briefs list, Brief reader, Entity list, Entity detail
- Mock data only

**Milestone 2 — capture in** (2–3 weeks)
- Ingest pipeline, Capture detail, Timeline
- Gmail + Calendar + manual capture sources
- Basic entity extraction

**Milestone 3 — briefs drafted** (2 weeks)
- Brief generator (daily + dossier kinds first)
- Board + Settings
- Onboarding flow

**Milestone 4 — polish** (1 week)
- Empty states across all surfaces
- Search refinement (both variants)
- Wash preference in user settings

---

## 7. Open questions for the team

These came up during design but were not resolved — flag for product before
starting code.

1. **Brief scheduling scope** — user-defined cadence, or fixed daily/weekly
   only? Settings shows "Schedule" button but UI wasn't fully designed.
2. **Multi-workspace**: left-nav has a workspace switcher pattern, but all
   screens are single-workspace. Is v1 single-user-single-workspace?
3. **Editing captures**: screens are read-only. Does the user edit transcripts
   to correct entity extraction, or only add annotations?
4. **Brief export**: PDF, email-to-self, Readwise? Implied by "Listen · 4 min"
   on the hero but playback UI wasn't specified.
5. **Board states**: "open / made / stalled" inferred from screen 09 but
   transition rules (who closes a decision, how) weren't designed.

---

## 8. Repo layout suggestion

```
/app                   # next.js routes
  /dashboard
  /briefs/[id]
  /entities/[id]
  /board
  /settings
/components
  /design-system       # Button, Pill, Card — rebuilds of screens/_shell.jsx
  /nav                 # TopNav, SideNav
  /brief               # BriefHero, BriefReader, BriefCard
  /entity              # EntityHeader, FactList, RelationGraph
/lib
  /extraction          # entity + decision extractors
  /sources             # gmail, calendar, slack adapters
/styles
  tokens.css           # port of colors_and_type.css
```

---

## 9. Deliverables checklist for Claude Code

- [ ] Port `colors_and_type.css` → `tokens.css` (strip legacy aliases)
- [ ] Rebuild primitives (Button, Pill, Card, Shell) in target framework
- [ ] Scaffold routes for all 13 screens with mock data
- [ ] Implement data model + migrations
- [ ] Gmail + Calendar adapters, manual capture form
- [ ] Entity extraction pipeline
- [ ] Brief generator (daily + dossier)
- [ ] Empty states matched to the 6 in screen 12
- [ ] Onboarding flow from screen 13 (4 steps)
- [ ] Parchment wash as default; user setting to override

Ship it.
