---
name: open-brain-design
description: Use this skill to generate well-branded interfaces and assets for the Open Brain personal AI knowledge dashboard, either for production or throwaway prototypes/mocks/etc. Open Brain's design system is built on AWS Cloudscape (visual-refresh theme) — information-dense, enterprise-calm, cobalt-blue accent, Open Sans. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

Key files:
- `README.md` — full system overview, visual foundations, content fundamentals, iconography
- `colors_and_type.css` — drop-in CSS variables for colors, typography, spacing, radii, shadows, motion (light + dark)
- `assets/` — Open Brain logo, icon reference
- `ui_kits/dashboard/` — reimagined Open Brain dashboard in Cloudscape style; JSX components + `index.html` demo
- `preview/` — per-token and per-component preview cards

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy `colors_and_type.css` and any needed assets out, and create static HTML files for the user to view. Link Open Sans from Google Fonts and Lucide icons from the unpkg CDN. If working on production code for `packages/web`, use the tokens here directly or migrate to `@cloudscape-design/components` for full fidelity.

If the user invokes this skill without any other guidance, ask them what they want to build or design (dashboard page? new feature? marketing one-pager?), ask a few questions about scope and fidelity, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need. Preserve Open Brain's vocabulary verbatim: capture, brain view, capture type, pipeline, skill, Board, brief, entity graph, MCP.
