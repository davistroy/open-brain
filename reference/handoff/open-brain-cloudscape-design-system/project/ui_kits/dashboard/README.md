# Open Brain dashboard — Cloudscape reimagining

Reimagined Open Brain web dashboard using the Cloudscape visual language. Replaces the shadcn/ui sidebar-driven layout with:

- **Top navigation** (fixed, near-black `colorGrey950`) — primary brand + global search + user menu
- **Side navigation** (light panel, 280px) — page tree grouped by function
- **Content layout** — 20px gutters, 16px radius containers, shadow-as-border cards
- **Flashbar stack** for pipeline health + admin banners (replaces inline banners)
- **Split panel** for capture detail preview (replaces drawer)
- **Data-dense Table** for the activity feed (replaces card list — Cloudscape favors tables)
- **KeyValue stats** + **Cards** grid for top metrics

## Files
- `index.html` — runnable click-through dashboard demo
- `TopNav.jsx`, `SideNav.jsx`, `Flashbar.jsx`, `StatsCards.jsx`, `ActivityTable.jsx`, `QuickCapture.jsx`, `OpenQuestions.jsx`, `Badge.jsx`, `Button.jsx` — factored components

## What changed vs. the original
| Original (shadcn) | Reimagined (Cloudscape) |
|---|---|
| Left sidebar with Lucide icons + label | Top navigation + side navigation (Cloudscape `AppLayout` pattern) |
| StatusStrip inline at top of main | Flashbar stack with typed flashes |
| 4 stat cards with bar charts inside | KeyValue pairs + header with supplemental chart container |
| Activity as stacked cards | Dense table with typed rows + split-panel preview |
| Pill-ish buttons via Tailwind | True Cloudscape pill (20px radius, 2px border) |
| "Quick Capture" text input row | `FormField` + `Input` + primary `Button` with helper text |
| Dark mode via Tailwind `.dark` | Same — driven by `[data-theme="dark"]` on root |
