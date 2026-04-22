# Open Brain × Cloudscape Design System

A reimagined design system for the **Open Brain** personal AI knowledge dashboard, built on the foundations of **AWS Cloudscape Design System** (visual-refresh theme).

The user explicitly asked for the existing shadcn/ui-based Open Brain dashboard to be re-imagined using Cloudscape's visual language — so this system takes Cloudscape's tokens, components, and information-dense patterns as the source of truth, while carrying over Open Brain's domain concepts (captures, brain views, pipeline health, activity feed, entity graph, governance, briefs).

## Sources

| Source | URL | What we pulled |
|---|---|---|
| Open Brain (product) | https://github.com/davistroy/open-brain | Product context, domain model (captures, brain views, skills, MCP), dashboard structure (`packages/web/`), page routes, copy tone from README and in-app strings |
| Cloudscape Components | https://github.com/cloudscape-design/components | Design tokens (colors, typography, spacing, shadows, borders, motion) from `style-dictionary/visual-refresh/` and `style-dictionary/core/color-palette.ts`; component API patterns |
| Cloudscape documentation | https://cloudscape.design | Component usage, information-density guidance, content/tone guidelines |

Both repos are public. All tokens below are derived from Cloudscape's `visual-refresh` theme unless otherwise noted.

---

## Product context: Open Brain

Open Brain is a **self-hosted personal AI knowledge system** running on an Unraid home server. It ingests voice memos (iOS Shortcut), Slack messages, and documents; classifies them into 5 brain views (`career`, `personal`, `technical`, `work-internal`, `client`) and 8 capture types (`decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`); provides hybrid semantic search with spreading activation over an entity graph; runs scheduled AI skills (weekly briefs, governance sessions, memory consolidation); and exposes itself to Claude/ChatGPT as an MCP server.

**Surfaces we design for:**
- **Web dashboard** (`packages/web`, Vite + React) — the primary surface; currently shadcn/ui-based, being re-imagined with Cloudscape
- Slack bot and MCP endpoint — CLI/text surfaces, not a design target here

**Primary dashboard pages:** Dashboard, Search, Timeline, Ingest, Entities, Wiki, Briefs, Board (governance), Intelligence, Voice, Email, Financial, Investments, System, Help, Settings.

---

## Index — files in this system

| File | Purpose |
|---|---|
| `README.md` | This file |
| `SKILL.md` | Agent-skill manifest — drop into `~/.claude/skills/` |
| `colors_and_type.css` | CSS variables: colors, type scale, spacing, radii, shadows, motion |
| `fonts/` | Open Sans webfont (Google Fonts import, also referenced in CSS) |
| `assets/` | Logos, icons, brand imagery |
| `preview/` | Design-system cards registered in the Design System tab |
| `ui_kits/dashboard/` | Reimagined Open Brain dashboard in Cloudscape style (JSX + index.html) |

---

## Visual foundations

**Overall vibe.** Enterprise-calm, information-dense, screen-first. Cloudscape optimizes for operators who live in the UI all day; every pixel is accountable. No gratuitous gradients, no marketing polish, no playful flourishes. Whitespace is deliberate and tight. The product should feel like a cockpit, not a brochure.

**Color.** Neutral grey canvas with a single cobalt-blue accent (`#006ce0`, `colorBlue600`) as the only interactive highlight. Status colors are narrow and semantic: green `#00802f` (success), red `#db0000` (error), yellow `#fbd332` (warning), blue `#006ce0` (info). Dark mode flips neutrals to `colorGrey850` surfaces on `colorGrey950` canvas, and brightens primary blue to `colorBlue400` for contrast. No bluish-purple gradients anywhere — the purple in Cloudscape is reserved exclusively for the **GenAI label** and the avatar GenAi gradient.

**Typography.** `Open Sans` is the single font family; `Monaco/Menlo/Consolas` for monospace. Headings are **700 weight** with **negative letter-spacing** that tightens as size increases (Display L: `-0.03em`; H1: `-0.02em`; H2: `-0.015em`). Body is 14px/20px. Body-small is 12px/16px. Nothing in between.

**Spacing.** 4-px base grid: `2, 4, 8, 12, 16, 20, 24, 32, 40`. `xs (8)` and `s (12)` carry 80% of the layout. Containers use `l (20)` horizontal padding.

**Backgrounds.** Flat. Solid surfaces. No hand-drawn illustrations, no textures, no repeating patterns. One exception: `colorBackgroundHomeHeader` uses the near-black `colorGrey950` for a "dark header" strip on landing-style pages, and the AWS Squid Ink `#232f3e` shows up on the classic home header.

**Gradients.** Used sparingly and *only* for GenAI: `colorBackgroundAvatarGenAi` is a radial gradient `#b8e7ff → #0099ff → #5c7fff → #8575ff → #962eff`; `colorBackgroundLoadingBarGenAi` is the linear variant. If it's not an AI-generated thing, don't use a gradient.

**Animation.** Short and utilitarian. Durations: `45ms / 90ms / 135ms / 180ms / 270ms`. Easing: `cubic-bezier(0, 0, 0, 1)` responsive; `cubic-bezier(1, 0, 0.83, 1)` sticky; `cubic-bezier(0.84, 0, 0.16, 1)` expressive. Fades and small scales only — no bounces, no springs, no parallax.

**Hover / press states.** Buttons: hover darkens to `colorPrimary900` (light) / lightens to `colorPrimary300` (dark). Normal buttons fill with `colorPrimary50`. List rows hover at `colorNeutral200`. Press states reuse the same darker token — no scale transforms.

**Borders.** Containers have a near-invisible 1px "faux border" via shadow (`0 0 1px 1px #e9ebed`). Buttons are **2px** bordered (pill, 20px radius). Inputs are **1px** at `colorBorderInputDefault`, thickening to 2px and shifting to primary blue on focus. Selected items get a 2px primary-blue border.

**Shadow system.** One elevation vocabulary:
- `shadowCard: none` — cards are flat by default
- `shadowContainer: 0 0 1px 1px #e9ebed, 0 1px 8px 2px rgba(0,7,22,.12)` — subtle ambient lift
- `shadowDropdown / shadowModal / shadowPopover: 0 4px 20px 1px rgba(0,7,22,.10)` — overlays
- `shadowPanel: 0 0 0 1px #b6bec9` — 1px solid outline for side panels
No inner shadows. Shadows are never decorative — they denote elevation.

**Corner radii.** `button: 20px` (pill), `container: 16px`, `input/item/tiles: 8px`, `badge: 4px`, `flashbar/dropzone: 12px`. Cards inherit `container`.

**Cards.** White surface (`colorBackgroundContainerContent`) on grey canvas. `16px` radius. Shadow-as-border (no explicit border). `20px` horizontal padding, `16px` vertical. Header row separated by a `colorBorderDividerDefault` rule.

**Transparency & blur.** Almost never. Modal overlays use `colorGreyOpaque70` (`rgba(35,43,55,0.7)` light; `rgba(15,20,26,0.7)` dark) over content — no backdrop blur. If you're reaching for `backdrop-filter`, you're off-system.

**Layout rules.** App shell = top navigation (fixed, dark or light) + optional side navigation + main content area + optional tools/help drawer (right side). Main content has a max width and a fixed `spaceLayoutContentHorizontal` (`xxl`) gutter. Cards flow full-width inside the content column.

**Imagery vibe.** Cloudscape itself ships almost no imagery — it's a component library, not a marketing system. When Open Brain needs imagery (avatars, empty states), use neutral product-ui illustrations or simple monochrome glyphs, never stock photography.

---

## Content fundamentals

Cloudscape has explicit content guidelines that map one-to-one onto how Open Brain copy should read.

**Voice.** Direct, literal, third-person-neutral. The UI describes *what happens*, not what the user is *about to do emotionally*. No marketing language. No exclamation marks except in errors that merit urgency.

**Point of view.** Use **"you"** to address the user. Never "I" from the product's voice. Open Brain breaks this mildly in its shadcn incarnation ("*Captured successfully — pipeline will classify and embed shortly.*") — that tone is fine; it's the passive, explanatory register Cloudscape prefers.

**Casing.** **Sentence case** everywhere — buttons, headings, labels, menu items. Title case only for proper nouns ("Open Brain", "Brain Views", "Slack"). Examples from the current codebase that align: `Quick Capture`, `Activity Feed`, `Load more`, `Clear filters`, `View all`.

**Buttons.** **Verb-first**, specific. `Save changes`, not `OK`. `Capture`, `Load more`, `Refresh`, `Clear filters`. For destructive actions use the explicit verb: `Delete`, `Archive`, not `Confirm`.

**Empty states.** A short factual sentence, then a secondary sentence explaining *why* it's empty or *what to do*. Current Open Brain copy: *"No activity yet. Activity will appear here as captures, skills, and pipeline events occur."* — a good template.

**Errors.** State the problem, then the next step. Cloudscape flashbars use `error`, `warning`, `info`, `success` levels. Don't apologize. `Failed to load dashboard data. Is the Core API running?` — the existing app nails this.

**Status text.** Terse, lowercase where possible inside badges (`pending`, `processing`, `extracted`, `embedded`). Use past-participle for complete states, gerund for in-progress.

**Numbers.** Localize (`feedTotal.toLocaleString()`), pluralize. Prefer `3 captures` to `3 items`. Counters go in parentheses after the label: `Activity Feed (1,247 total)`.

**Emoji.** **Never** in UI chrome. Zero tolerance. If an icon is needed, use the icon system.

**Open Brain–specific vocabulary.** Preserve these terms verbatim — they're domain-defining:
- **Capture** (noun/verb) — the unit of ingested content
- **Brain view** — one of `career`, `personal`, `technical`, `work-internal`, `client`
- **Capture type** — one of `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`
- **Pipeline** — the async classify/embed/extract chain
- **Skill** — a scheduled AI job (weekly brief, governance, consolidation)
- **Board / Governance** — the LLM-driven board meeting surface
- **Brief** — an AI-generated weekly or ad-hoc summary
- **Entity graph** — extracted people/projects/topics and their relationships
- **MCP** — Model Context Protocol endpoint at `/mcp`

---

## Iconography

**System used.** Cloudscape ships **its own SVG icon library** (`@cloudscape-design/components` `<Icon name="..." />`) with ~150 icons in a consistent 16px and 20px stroke style. Open Brain today uses **Lucide React** (`lucide-react`) throughout `packages/web/src/components/*.tsx` — confirmed in `Layout.tsx` and `Dashboard.tsx`.

**In this design system.** We use **Lucide** from CDN as a drop-in proxy for Cloudscape icons because:
1. The existing codebase already standardizes on Lucide.
2. Lucide's 2px stroke, 24px grid, and neutral geometric style are the closest free, CDN-available match to Cloudscape's in-house SVGs.
3. Copying Cloudscape's SVG icon files requires transpiling its React wrappers — out of scope for a design-reference kit.

**Flag to user:** If you want pixel-exact Cloudscape icons in downstream designs, install `@cloudscape-design/components` and use `<Icon>` directly. The Lucide substitution covers ~90% of what Cloudscape provides with a near-identical visual weight. See `assets/icons.md` for the mapping table.

**Emoji / unicode chars as icons.** Never used. Cloudscape has no precedent for it and Open Brain doesn't either.

**Logos.** Open Brain uses the Lucide `Brain` glyph as its wordmark accent (see `Layout.tsx`). We've captured this in `assets/open-brain-logo.svg`.

---

## Caveats and substitutions

- **Open Sans** is pulled from Google Fonts rather than bundled as `.ttf` files. This matches how most Cloudscape consumers load it and keeps the repo small. If you need offline/self-hosted fonts, download the Open Sans family from https://fonts.google.com/specimen/Open+Sans.
- **Icons are Lucide, not Cloudscape's in-house SVG set.** See Iconography section above.
- **Chart tokens** — Cloudscape has a deep `color-charts` token set (~100+ tokens). We captured only a representative subset under `--color-chart-*`. If you need full chart theming, pull `style-dictionary/visual-refresh/color-charts.ts` from the Cloudscape repo.
- **Density tokens** — Cloudscape supports a `compact` density variant. We default to `comfortable`. All spacing vars are the comfortable values.

## Next steps for iteration

The dashboard reimagining in `ui_kits/dashboard/` is a **first pass** — the key unknown is how far you want to push the Cloudscape aesthetic. Options:

1. **Pure Cloudscape.** Adopt `@cloudscape-design/components` wholesale and rewrite `packages/web/src/*.tsx` against it. Highest fidelity, biggest migration.
2. **Cloudscape-styled Tailwind.** Keep shadcn/ui components but restyle them with the token set here. What this kit demonstrates.
3. **Hybrid.** Use real Cloudscape for shell (`AppLayout`, `TopNavigation`, `SideNavigation`, `Cards`, `Table`) and keep custom React for Open Brain-specific widgets (entity graph, financial donut, SSE activity feed).

See `ui_kits/dashboard/README.md` for notes on which dashboard patterns changed and why.
