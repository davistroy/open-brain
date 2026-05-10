# SPEC — Mobile Quick Page (`/quick`)

A mobile-first single-page app for Open Brain. Optimized for one-handed phone use while on the go.

**Audience:** Claude Design (or any UI builder) — feed this directly.
**Owner:** Troy Davis (single-user system, no multi-tenancy).
**Target host:** `https://brain.troy-davis.com/quick` (gated by Cloudflare Access — assume the user is already authenticated; the existing CF Access session cookie carries through).
**Stack:** Next.js 16 + React 19 + Tailwind + the existing Cloudscape-themed design tokens in `packages/web-next`. **Do not introduce new frameworks.** Reuse `lib/api/*.hooks.ts` (TanStack Query) for data calls.

**Decisions locked in (2026-05-09):**
- ✅ **No photo mode.** Photo capture is dropped from v1.
- ✅ **No shell chrome.** Route is `app/quick/page.tsx` (NOT under `(shell)`). Full-bleed mobile experience.
- ✅ **Voice routing path:** voice-capture is NOT exposed via the public tunnel (`config/cloudflare/tunnel.yaml` only routes `brain.troy-davis.com → web-next:3001`). A new core-api proxy route `POST /api/v1/voice-captures` will be added to forward multipart uploads internally to `voice-capture:3001/api/capture`. ~30 LOC of TS work.

---

## 1. Page summary

A single full-height page split vertically into two zones:

```
┌─────────────────────────────────────┐
│  ▼ QUICK CAPTURE  (sticky top)      │
│  • Text input (default)             │
│  • Voice file attach                │
│  • Live voice recording             │
├─────────────────────────────────────┤
│  ▼ SEARCH                           │
│  • Search input + clear             │
│  • Optional synthesis answer card   │
│  • Result cards (flat list)         │
│  • Pull-to-refresh                  │
└─────────────────────────────────────┘
```

The capture zone is **sticky** (stays at the top while the search results scroll). The capture zone collapses to a compact bar (~56px) when the user scrolls down, expands when tapped or pulled down.

Route: `/quick`. New file: `packages/web-next/app/quick/page.tsx` — outside the `(shell)` group, so the page renders **without** the global nav header. Full-bleed mobile experience.

---

## 2. Section 1 — Quick capture

Three input modes selected via segmented icon toggle:

| Mode | Icon | Default? | API |
|------|------|----------|-----|
| **Text** | `Type` | ✅ Yes | `POST /api/v1/captures` (JSON) |
| **Voice file** | `FileAudio` | | `POST /api/v1/voice-captures` (multipart, NEW core-api proxy → voice-capture) |
| **Live record** | `Mic` | | Same as Voice file, with audio captured via `MediaRecorder` Web API |

### 2.1 Mode selector

A segmented 3-button toggle below the page header. Each button is a 44×44px tap target with the icon. Active state: `book-cloth` underline (matches `SearchInput` toggle style).

When the mode changes, the input area below morphs but **typed text is NOT lost** (e.g., switching from Text → Voice file keeps the typed text in case the user switches back).

### 2.2 Text mode

- `<textarea>` autoexpanding (min 3 rows, max 8 rows visible — scrolls beyond).
- Placeholder: `"What's on your mind?"`
- Live char count bottom-right: `0 / 50,000` (matches schema `content` max).
- Below the textarea, a row with:
  - **Capture type** pill picker: `decision | idea | observation | task | win | blocker | question | reflection` (8 values from `CAPTURE_TYPES`). Default: `observation`. Shows current selection as a Pill; tap opens a bottom sheet picker.
  - **Brain view** pill picker: `career | personal | technical | work-internal | client` (5 values). Default: `personal`. Same bottom-sheet pattern.
  - **Submit** button right-aligned: `Capture` (book-cloth color, 48px tall, full-bleed width when keyboard is open). Disabled while empty.

On submit:
1. Disable button, show inline spinner.
2. `POST /api/v1/captures` with body:
   ```json
   {
     "content": "<textarea value>",
     "capture_type": "<selection>",
     "brain_view": "<selection>",
     "source": "api",
     "metadata": {
       "source_metadata": {
         "client": "mobile-quick",
         "captured_at_local": "<ISO timestamp>"
       }
     }
   }
   ```
3. On 201: clear textarea, flash a 1.5s toast `"Captured"`, focus input again.
4. On error: keep content, show inline error below button.

### 2.3 Voice file mode

`<input type="file" accept="audio/*">` — opens iOS Files / Android file picker for an audio file already on the device.

UX:
- Tap-target zone: `"Tap to choose an audio file"` + `FileAudio` icon.
- After selection: filename + duration (probed via `<audio>` metadata) + **X** to remove.
- Submit button: `Send for transcription`.
- Below: brain-view picker (no capture-type — voice-capture sets it via classification). Default: `personal`.

On submit:
1. POST multipart to `/api/v1/voice-captures` (the new core-api proxy — see §5). Field name: `file`. Optional fields: `brain_view`, `device: "mobile-web"`.
2. Show progress bar (XHR upload progress) — voice files can be 1–10 MB.
3. On success: capture details returned (content = transcription, capture_type from classification). Toast `"Voice captured"` + show the transcribed text inline for 3s before clearing.
4. On error: keep file selected, show error.

### 2.4 Live record mode

In-browser recording via `MediaRecorder` Web API.

UX states:

| State | Visual | Controls |
|-------|--------|----------|
| `idle` | Big circular `Mic` button (96×96px, book-cloth bg) | Tap to start. Shows `"Hold to record"` hint. |
| `requesting-permission` | Same button, slight pulse | Shows `"Allow microphone access…"` |
| `recording` | Button turns red, animated waveform across width (16–24 vertical bars driven by `AnalyserNode`). Timer above: `MM:SS` | **Stop** button (square icon) replaces the mic. Tap to stop. Auto-stop at 10:00 min. |
| `processing` | Spinner + `"Uploading…"` + percent | Cancel button optional. |
| `done` | Transcribed text shown for 3s, then clears | Auto-clears, ready for next. |
| `error` | Inline error message + retry button | |

Implementation:
- `navigator.mediaDevices.getUserMedia({ audio: true })`
- `new MediaRecorder(stream, { mimeType: 'audio/webm' })` — falls back to `audio/mp4` on Safari iOS.
- Collect chunks via `dataavailable` event; on `stop`, build a `Blob` and POST to `/api/v1/voice-captures` exactly like the Voice file mode.
- **iOS Safari quirks:**
  - `MediaRecorder` requires iOS 14.3+. Earlier: gracefully degrade to "Use Voice file mode instead" message.
  - Output mime is `audio/mp4` on Safari, not `audio/webm`. The `voice-capture` `SUPPORTED_FORMATS` set includes `m4a, wav, mp3, ogg` — verify it accepts `mp4`. If not, rename the blob's filename extension to `.m4a` before upload (the server uses extension to validate).
  - Page must be served HTTPS (it is, via brain.troy-davis.com).
- Permission handling: if the user denies mic, show an actionable error: `"Microphone blocked. Tap to open settings."` (deep-link to iOS settings is browser-restricted; show instructions instead).

---

## 3. Section 2 — Search (mobile-adapted)

Reuses logic from the existing `/search` page but with a mobile layout. Drives off `?q=` URL param like the desktop version.

### 3.1 Layout

- **Search input** (full-width, 48px tall on mobile): same component as desktop (`SearchInput` with debounce). Icon left, X clear right.
- **Synthesis answer card** (conditional): only when `isSynthesisRequest(query)` returns true. Card-style, full-width, no margin. Header: `Brain` icon + `"Synthesis"`. Body: response text. Loading state: shimmer + `Synthesizing…`.
- **Result cards** (flat list): one card per result. **No grouped/flat toggle on mobile** — always flat (the toggle in desktop is for power users).
- **No EntityFacets sidebar** on mobile (the desktop already has `hidden lg:block` on it — keep it hidden).

### 3.2 Result card (mobile layout)

```
┌──────────────────────────────────────┐
│ Voice · 2d ago        [observation] │  ← source + relative date · type pill (right)
│                                      │
│ The first ~120 chars of content...   │  ← body, 2 lines max, ellipsis
│                                      │
│ #tag1 #tag2 +3        score 0.87    │  ← bottom row: tags (truncated) · score
└──────────────────────────────────────┘
```

- 16px padding, `rounded-container`, `bg-bg-container`, `border-cloud-light`.
- Tap entire card → `/captures/<id>` (existing route; check it works on mobile).
- Long-press → context menu (copy ID, share, delete) — **defer to v2 if it adds complexity**.
- Visual weight: title-area (source + date + type) is `text-[11.5px] font-mono tracking-[0.04em] uppercase`. Body is `text-[13.5px] leading-relaxed`. Tags + score are `text-[10.5px] font-mono`.

### 3.3 Empty / loading / error states

- **Empty (no query):** centered icon + `"Search your brain"` + `"Type a keyword or ask a question. Pull down to refresh."`
- **Loading (after typing):** 4 skeleton cards (matches existing `ResultSkeletons` pattern in `SearchResults.tsx`).
- **Empty (query but no results):** centered illustration + `"No matches for '<query>'"` + `"Try fewer keywords or ask a question instead."`
- **Error:** inline red banner at top of result area + `Retry` link.

### 3.4 Pull-to-refresh

iOS Safari supports it natively if the page allows overscroll. Implement via `overscroll-behavior-y: auto` on the scrollable container + a subtle spinner that appears when the pull exceeds 60px. Re-runs the search query (TanStack Query `refetch()`).

### 3.5 Infinite scroll

The current core-api search returns up to 30 results in one page. **Skip pagination on mobile v1** — the top 20 results are usually sufficient. If this becomes a complaint, add cursor-based pagination later.

---

## 4. Mobile shell concerns

### 4.1 Viewport

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
```

(Confirm `user-scalable=no` is acceptable per accessibility guidelines — it's controversial. If accessibility is a hard requirement, drop it and accept that pinch-zoom may break the sticky layout briefly.)

### 4.2 Safe-area insets

iPhone notch + home indicator. Use Tailwind's `pt-[env(safe-area-inset-top)]` and `pb-[env(safe-area-inset-bottom)]` on:
- Page top (capture zone) — `padding-top: env(safe-area-inset-top)`
- Page bottom (last result card) — `padding-bottom: env(safe-area-inset-bottom)`

### 4.3 Status bar / theme color

```html
<meta name="theme-color" content="#FAF7F2"> <!-- ivory bg -->
<meta name="apple-mobile-web-app-status-bar-style" content="default">
```

### 4.4 Sticky header behavior

The capture zone uses `position: sticky; top: env(safe-area-inset-top); z-index: 10;`. When the user scrolls search results down, the capture zone stays. Two visual states:

- **Expanded** (top of page, no scroll): full capture UI visible.
- **Collapsed** (after 200px scroll): collapses to a 56px bar showing only the mode selector + a chevron-down hint. Tapping anywhere in the bar expands it back. Smooth transition (200ms).

### 4.5 Keyboard handling

When the textarea or search input is focused, iOS Safari shifts the viewport up. The page must avoid hidden content under the keyboard:
- The submit button must be visible above the keyboard. If sticky-bottom is needed (esp. for the long textarea), use `position: sticky; bottom: 0` on the action row.
- Avoid `100vh` — use `100dvh` (dynamic viewport height) which excludes the keyboard.

### 4.6 PWA / Add-to-home-screen

The site already ships `/manifest.json` and `/sw.js` (issue #198 fix). Add a deep link target so opening `/quick` from the home screen lands directly on this page instead of `/`.

In `manifest.json`, add a shortcut:
```json
{
  "shortcuts": [
    { "name": "Quick capture", "url": "/quick", "icons": [...] }
  ]
}
```

---

## 5. APIs reference (everything used by this page)

| Method | Endpoint | Purpose | Body / params | Response |
|--------|----------|---------|---------------|----------|
| POST | `/api/v1/captures` | Create text capture | JSON: `{content, capture_type, brain_view, source: "api", metadata}` | `{id, pipeline_status, created_at}` |
| POST | `/api/v1/voice-captures` | Submit audio (NEW route, see §5.1) | multipart: `file`, `brain_view?`, `device?` | `{capture: {...}, transcription: {text, duration}}` |
| GET | `/api/v1/search?q=...&limit=20&search_mode=hybrid` | Search captures | query params | `{ results: [{ capture, score }], total }` |
| POST | `/api/v1/synthesize` | LLM-synthesized answer card | JSON: `{query}` (limit defaults to 5 per ce1dcad) | `{response: string, capture_count: number}` |

All requests go through Next.js's `proxy.ts` which sets `X-Open-Brain-Caller: web-next-public` automatically. No client-side header changes needed.

Cloudflare Access cookie is set automatically when the user is logged in to brain.troy-davis.com — no JS handling needed.

### 5.1 New backend route: `POST /api/v1/voice-captures`

**Required prerequisite for this page.** The voice-capture container at `voice-capture:3001` is on the open-brain Docker network but is NOT exposed publicly via the Cloudflare tunnel (verified 2026-05-09: `config/cloudflare/tunnel.yaml` only routes `brain.troy-davis.com → web-next:3001`). Adding a tunnel rule + CF Access policy for a separate hostname would be ~3× the work of an internal proxy route.

**Implementation (~30 LOC of TS):**

New file: `packages/core-api/src/routes/voice-captures.ts`. Mounted in `index.ts` alongside other route registrations.

```ts
// POST /api/v1/voice-captures — multipart proxy to voice-capture:3001/api/capture
// Forwards the multipart payload verbatim, sets X-Open-Brain-Caller for bypass.
app.post('/api/v1/voice-captures', async (c) => {
  const upstream = process.env.VOICE_CAPTURE_URL ?? 'http://voice-capture:3001/api/capture'
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.startsWith('multipart/form-data')) {
    throw new ValidationError('Request must be multipart/form-data')
  }
  // Stream the body through — don't buffer to memory (audio can be ~10 MB)
  const body = c.req.raw.body
  const res = await fetch(upstream, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Open-Brain-Caller': 'web-next-public',  // already in BYPASS_CALLERS
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const text = await res.text()
  return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
})
```

Notes:
- `web-next-public` is already in `BYPASS_CALLERS` (per CLAUDE.md ops rules).
- `voice-capture` validates the audio format itself; this proxy stays dumb.
- `duplex: 'half'` is required by `fetch()` for streamed request bodies in Node 22.
- Multipart body size limit: voice-capture already enforces; the proxy doesn't need to.
- New env var: `VOICE_CAPTURE_URL` (default `http://voice-capture:3001/api/capture`) — add to `.env.template` and document in `deploy/.env.secrets.template`.
- Add a test in `packages/core-api/test/integration/voice-captures.test.ts` that mocks the upstream and verifies the body is passed through verbatim with the correct caller header.

---

## 6. Component breakdown (suggested file layout)

```
packages/web-next/
├─ app/quick/
│  └─ page.tsx                  ← RSC shell, NOT under (shell) group — full-bleed
└─ components/quick/
   ├─ CaptureZone.tsx           ← top section, sticky, mode selector + active mode
   ├─ ModeSelector.tsx          ← 3-icon segmented toggle (Type / FileAudio / Mic)
   ├─ TextCapture.tsx           ← textarea + type/view pickers + submit
   ├─ VoiceFileCapture.tsx      ← audio file input + submit
   ├─ LiveRecorder.tsx          ← MediaRecorder state machine + waveform
   ├─ Waveform.tsx              ← shared visualization (reuse mobile RN logic if portable)
   ├─ TypePicker.tsx            ← bottom-sheet capture-type picker
   ├─ ViewPicker.tsx            ← bottom-sheet brain-view picker
   ├─ MobileSearchBar.tsx       ← thin wrapper around existing SearchInput
   ├─ MobileResultCard.tsx      ← mobile-flavored result card
   └─ MobileResultsList.tsx     ← list + skeletons + empty states
```

**Reuse from existing code:**
- `lib/api/captures.hooks.ts`, `search.hooks.ts`, `synthesize.hooks.ts` (TanStack hooks from PRs #211–214).
- `lib/synthesis-detect.ts` (the `isSynthesisRequest` heuristic).
- `components/design-system/Pill.tsx`, `Eyebrow.tsx`.
- Token sets: book-cloth, ivory-dark, cloud-light, font-display, font-mono. Stay inside the existing palette.

---

## 7. Open questions for Troy (decide before/during build)

**Resolved 2026-05-09:**
- ~~Photo handling~~ — DROPPED from v1.
- ~~Voice tunnel exposure~~ — confirmed LAN-only. New core-api proxy route required (§5.1).
- ~~Shell chrome~~ — DROPPED. Full-bleed page at `app/quick/page.tsx`.

**Still open:**
1. **Pull-to-refresh on capture** — does the capture zone reset/refresh too, or only the search results below? Default: search only.
2. **Capture confirmation** — should the user see the capture content again after success (like the React Native `confirm.tsx` screen does), or just a toast? Default: toast (faster).
3. **Auth fallback** — what's the UX if the CF Access cookie is expired? Right now the user gets a CF Access redirect. Confirm this is acceptable (it is, for a single-user system) vs. needing a custom landing page.
4. **No-shell back navigation** — without the global nav, how does the user get *out* of `/quick`? Options: (a) one small "back to dashboard" link in a corner, (b) browser back button only, (c) tap-and-hold the page header as an escape. Default: option (a), tiny `text-[11px] font-mono` link top-right.

---

## 8. Acceptance criteria

The page is "done" when:

- [ ] Loading `/quick` on iOS Safari + Chrome Android renders the layout in <500ms (cold cache).
- [ ] Text capture posts and returns capture ID; toast confirms; textarea clears.
- [ ] Voice file capture uploads, transcribes, and shows the transcribed text within 30s for a 60-sec audio.
- [ ] Live recording: tap → permission → record (with waveform + timer) → tap to stop → upload → transcribe → done. <2s latency from tap-to-record-start.
- [ ] Search input debounces to URL `?q=`; results render; synthesis card appears for question-style queries.
- [ ] Capture zone sticks during scroll; collapses past 200px; expands on tap.
- [ ] Pull-to-refresh on the search area triggers re-fetch.
- [ ] Safe-area insets respected on iPhone notch/home indicator.
- [ ] Page is keyboard-friendly (textarea visible above iOS keyboard).
- [ ] Works offline-graceful: shows "Offline" banner when navigator.onLine is false, queues captures locally? (**v2 — defer.**)
- [ ] Lighthouse mobile score ≥85 (Performance + Accessibility).

---

## 9. Out of scope for v1

- **Photo / image capture** (deferred — no native image pipeline, F27 is "won't have" in PRD).
- Editing past captures from the search results (read-only).
- Entity facet filtering on mobile.
- Long-press context menu on result cards.
- Offline capture queue + sync.
- Apple Watch interaction (keep iOS Shortcut for that — separate path).
- Push notifications.

---

## 10. Out-of-band: a note about the existing iOS Shortcut

The user already has an iOS Shortcut that posts directly to voice-capture. This page **does not replace it** — the Shortcut is faster (no browser launch). Live record on this page is a fallback for when the Shortcut isn't convenient (e.g., user already has the browser open searching). They should coexist.
