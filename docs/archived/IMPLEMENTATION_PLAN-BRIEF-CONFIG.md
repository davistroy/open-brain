# Implementation Plan: Run Brief Configuration Panel

**Created:** 2026-04-03
**Status:** Complete
**Scope:** Add an inline configuration panel to the Briefs page "Run Now" button, allowing the user to choose a custom time window before triggering a weekly brief.

---

## Context

The weekly brief skill already accepts `windowDays` as an input override through the full backend chain:

```
POST /api/v1/skills/weekly-brief/trigger { windowDays: N }
  → skills.ts parses body into overrides (line 95-99)
    → BullMQ job { input: { windowDays: N } }
      → skill-execution.ts extracts windowDays (line 50)
        → WeeklyBriefSkill.execute({ windowDays: N }) (line 47)
```

The frontend currently sends an empty body (`{}`), so the backend always uses the 7-day default. This plan adds a UI panel that lets the user choose a window before triggering.

## Design Summary

- **Panel type:** Inline expanding panel (not modal) — matches existing BriefCard expand/collapse pattern
- **Presets:** This Week (last Sunday→today), This Month (1st→today), 7d, 14d, 30d, 60d
- **Custom input:** Numeric field for arbitrary day count
- **Date preview:** Live-computed "Mar 22 — Apr 3, 2026 (12 days)" line
- **Validation:** Min 1d, max 365d, integer only, warning at 90+d
- **Components used:** Existing shadcn `Button`, `Input`, `Separator` — no new dependencies

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Panel styling inconsistent with page | Low | Low | Uses identical Tailwind classes and shadcn components as rest of Briefs page |
| Edge case in "This Week" on Sunday | Low | Low | Returns 1 day (just today) — preview line makes this obvious |
| Backend rejects unexpected body fields | None | — | Backend already parses `body as Record<string, unknown>` and extracts known keys |

**Rollback:** Revert the single commit. No database, backend, or API changes involved.

## Scope Boundaries

**In scope:**
- RunBriefPanel component in Briefs.tsx
- skillsApi.trigger() signature update in api.ts
- All preset and custom window logic
- Input validation and date preview

**Out of scope:**
- Persisting the user's last-used window preference
- Backend validation of windowDays range
- Changes to the weekly-brief skill itself
- New shadcn components or npm dependencies

---

## Phase 1: Update skillsApi.trigger() signature

**Files:** `packages/web/src/lib/api.ts`

### Step 1.1: Add overrides parameter to skillsApi.trigger

**What:** Change `trigger(skillName: string)` to `trigger(skillName: string, overrides?: Record<string, unknown>)` and pass the overrides in the request body.

**Where:** `packages/web/src/lib/api.ts`, line 172-177

**Current code:**
```ts
trigger: (skillName: string) => {
  return request<{ job_id: string }>(`/skills/${skillName}/trigger`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
},
```

**New code:**
```ts
trigger: (skillName: string, overrides?: Record<string, unknown>) => {
  return request<{ job_id: string }>(`/skills/${skillName}/trigger`, {
    method: 'POST',
    body: JSON.stringify(overrides ?? {}),
  })
},
```

**Verification:** Existing callers pass no second argument → behavior unchanged (sends `{}`). New callers can pass `{ windowDays: 14 }`.

**Acceptance criteria:**
- [ ] `skillsApi.trigger('weekly-brief')` still sends `{}`
- [ ] `skillsApi.trigger('weekly-brief', { windowDays: 14 })` sends `{"windowDays":14}`
- [ ] TypeScript compiles cleanly

---

## Phase 2: Build RunBriefPanel component

**Files:** `packages/web/src/pages/Briefs.tsx`

### Step 2.1: Add date computation helpers

**What:** Add three pure functions at the top of `Briefs.tsx` (above the component definitions):

1. `computeWindowDays(preset: string): number` — returns the day count for "this-week" and "this-month" presets based on today's date
2. `formatDateRange(days: number): { from: string; to: string; label: string }` — computes the from/to dates and formats a human-readable label like "Mar 22 — Apr 3, 2026 (12 days)"
3. Constants: `PRESETS` array defining the six buttons with their `id`, `label`, and either fixed `days` or `'compute'` marker

**Date math details:**
- **This Week:** `dayOfWeek = today.getDay()` → `daysBack = dayOfWeek === 0 ? 1 : dayOfWeek + 1` (Sunday getDay()=0 means 1 day back = just today; Monday getDay()=1 means 2 days back = Sunday+Monday). Uses `Math.max(1, ...)` as floor.
- **This Month:** `today.getDate()` gives day-of-month directly (April 3 → 3 days).
- **Fixed presets:** 7, 14, 30, 60 — used as-is.

**Acceptance criteria:**
- [ ] "This Week" on Sunday = 1, Monday = 2, Saturday = 7
- [ ] "This Month" on the 1st = 1, on the 15th = 15
- [ ] `formatDateRange` returns correct from/to dates and human-readable label
- [ ] All functions are pure (no side effects, testable with fixed dates)

### Step 2.2: Build the RunBriefPanel component

**What:** A new component rendered inline in the Briefs page between the header and the brief list. Manages its own state for selected preset, custom value, and validation.

**Component structure:**
```
<div className="rounded-lg border bg-card p-4 space-y-4">
  <!-- Title row -->
  <div className="flex items-center justify-between">
    <h3 className="text-sm font-semibold">Generate Brief</h3>
    <span className="text-xs text-muted-foreground">
      {dateRangeLabel}   ← live preview
    </span>
  </div>

  <!-- Preset buttons row -->
  <div className="flex flex-wrap gap-2">
    {PRESETS.map(p => (
      <Button
        variant={selected === p.id ? 'default' : 'outline'}
        size="sm"
        onClick={() => selectPreset(p.id)}
      >
        {p.label}
      </Button>
    ))}
  </div>

  <!-- Custom input row -->
  <div className="flex items-center gap-3">
    <Separator className="flex-1" />
    <span className="text-xs text-muted-foreground">or</span>
    <Separator className="flex-1" />
  </div>
  <div className="flex items-center gap-2">
    <span className="text-sm text-muted-foreground">Custom:</span>
    <Input
      type="number"
      className="w-20"
      min={1} max={365}
      value={customValue}
      onChange={handleCustomChange}
    />
    <span className="text-sm text-muted-foreground">days</span>
  </div>

  <!-- Warning for 90+ days -->
  {effectiveDays >= 90 && (
    <div className="flex items-center gap-2 text-xs text-amber-600">
      <AlertTriangle className="h-3.5 w-3.5" />
      Large window — may take longer and use more AI tokens.
    </div>
  )}

  <!-- Validation error -->
  {validationError && (
    <p className="text-xs text-destructive">{validationError}</p>
  )}

  <!-- Action buttons -->
  <div className="flex items-center justify-end gap-2 pt-1">
    <Button variant="outline" size="sm" onClick={onCancel}>
      Cancel
    </Button>
    <Button size="sm" onClick={onGenerate} disabled={!!validationError || triggering}>
      <Play className="h-4 w-4 mr-1.5" />
      {triggering ? 'Queuing…' : 'Generate Brief'}
    </Button>
  </div>
</div>
```

**Props:**
```ts
interface RunBriefPanelProps {
  onTrigger: (windowDays: number) => Promise<void>
  onCancel: () => void
  triggering: boolean
}
```

**State:**
- `selectedPreset: string | null` — which preset button is active (default: `'7d'`)
- `customValue: string` — raw text in the custom input (empty = not in use)
- Derived: `effectiveDays` — computed from either the selected preset or parsed custom value
- Derived: `validationError` — null when valid, error message string when invalid

**Behavior:**
- Clicking a preset deselects custom (clears `customValue`), sets `selectedPreset`
- Typing in custom deselects preset (`selectedPreset = null`), sets `customValue`
- Mutually exclusive — one source of truth at a time
- `effectiveDays` is computed: `customValue ? parseInt(customValue) : computePresetDays(selectedPreset)`
- Validation runs on every change: `< 1` → "Must be at least 1 day", `> 365` → "Maximum 365 days", `NaN` (non-empty custom) → "Enter a valid number"
- Calendar icon + date range label updates live as effectiveDays changes

**Acceptance criteria:**
- [ ] Clicking a preset highlights it and deselects custom
- [ ] Typing a custom value deselects all presets
- [ ] Date preview updates live on every change
- [ ] Validation blocks Generate button when invalid
- [ ] Warning appears for 90+ day windows
- [ ] Cancel closes the panel
- [ ] Generate calls onTrigger with the computed windowDays

### Step 2.3: Wire RunBriefPanel into the Briefs page

**What:** Replace the direct `handleTrigger()` call with panel toggle logic.

**Changes to `Briefs()` component:**
1. Add state: `const [showPanel, setShowPanel] = useState(false)`
2. Change "Run Now" button `onClick` from `handleTrigger` to `() => setShowPanel(true)`
3. Update `handleTrigger` to accept `windowDays: number` parameter and pass it to `skillsApi.trigger('weekly-brief', { windowDays })`
4. On successful trigger or cancel: `setShowPanel(false)`
5. Render `{showPanel && <RunBriefPanel ... />}` between the header section and the Separator

**Acceptance criteria:**
- [ ] Clicking "Run Now" opens the panel (does not immediately trigger)
- [ ] Panel appears between header and brief list with slide-open animation
- [ ] Clicking "Generate Brief" triggers with the selected windowDays
- [ ] Clicking "Cancel" or successful trigger closes the panel
- [ ] "Run Now" button is disabled while panel is open
- [ ] Feedback messages (success/error) still display after panel closes
- [ ] Page remains fully functional when panel is closed (existing behavior preserved)

---

## Verification Checklist

After implementation, manually verify:

- [ ] Default flow: Open panel → "7d" pre-selected → Generate → triggers with `windowDays: 7`
- [ ] This Week preset: Correct day count for today's day-of-week, preview shows Sunday→today
- [ ] This Month preset: Correct day count, preview shows 1st→today
- [ ] Fixed presets (14d, 30d, 60d): Each sends correct windowDays
- [ ] Custom input: Type "21" → preview shows 21-day range → Generate sends `windowDays: 21`
- [ ] Preset↔Custom switching: Selecting preset clears custom; typing custom deselects preset
- [ ] Validation: 0 → error, -1 → error, 366 → error, 3.5 → rounds to 3, empty → falls back to preset
- [ ] Warning: 90+ days shows amber warning, button still enabled
- [ ] Cancel: Closes panel, no trigger fired
- [ ] Network: Browser DevTools confirms POST body contains `{"windowDays": N}`
- [ ] Responsive: Panel renders cleanly on narrow viewports (preset buttons wrap)
- [ ] TypeScript: `pnpm --filter @open-brain/web tsc --noEmit` passes
