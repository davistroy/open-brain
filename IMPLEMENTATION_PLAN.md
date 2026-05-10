# IMPLEMENTATION_PLAN — Mobile SPA at `/mobile`

**Generated:** 2026-05-09 via `/personal-plugin:ultra-plan`
**Source spec:** [`docs/SPEC-mobile-quick.md`](docs/SPEC-mobile-quick.md) (renamed `/quick` → `/mobile` per user direction)
**Source design:** Claude Design handoff bundle (extracted to `/tmp/design-spec/mobile-spa/`)
**Total scope:** 5 phases, 1 PR per phase, ~3.5–4.5 hours focused work
**Sequencing:** Strict — each phase ships independently to homeserver before next begins

---

## Plan summary

A mobile-first SPA at `https://brain.troy-davis.com/mobile`. Sticky 3-mode capture zone (text / voice file / live record) on top, mobile-adapted search section below. Outside the `(shell)` route group — full-bleed.

| Phase | Scope | Effort | Touches |
|------|-------|--------|---------|
| **A** | Backend voice-captures proxy route | ~30 min | core-api |
| **B** | `/mobile` route shell | ~40 min | web-next (route + layout + state container) |
| **C** | Capture zone — text + voice file modes | ~90 min | web-next + new TanStack hooks |
| **D** | Capture zone — live record (MediaRecorder) | ~75 min | web-next |
| **E** | Search section + polish (toast, transcript echo, sticky-collapse, pull-to-refresh) | ~60 min | web-next |

---

## Pre-plan gates (constraints from CLAUDE.md)

✅ All design changes comply:

| Constraint | Compliance approach |
|---|---|
| LAB_NOTEBOOK.md entry MANDATORY before each commit touching app code | Each phase ends with a Lab Notebook entry as final acceptance item |
| pnpm-lock.yaml committed with package.json changes | No new dependencies planned; if any are added, lockfile is committed in same commit |
| No `extra_body` in OpenAI calls | N/A — no LLM calls in this plan |
| Drizzle pgEnum + migration lockstep | N/A — no schema changes |
| Internal services need `X-Open-Brain-Caller` + BYPASS_CALLERS | Public users via `web-next-public` (NOT in BYPASS — correctly subject to rate limits, 100 req/min) |
| Cost-tiering (T0→T1→T2→T3) | Voice transcription routes through existing voice-capture (faster-whisper, free), not new paid path |

---

## Architectural decision: multipart proxy strategy

**Decision:** Buffer-and-rebuild (parse `c.req.formData()` in core-api, copy fields into new FormData, fetch upstream).

**Rejected:** Raw streaming with `fetch({ duplex: 'half', body: c.req.raw.body })`.

**Rationale:**
1. Zero codebase precedent for streamed fetch — would require new pattern + tests for an edge case
2. Audio files bounded ≤10MB by voice-capture's existing checks — buffering is safe
3. Simpler to integration-test (FormData round-trip is straightforward)
4. Single-user Open Brain — concurrency is one upload at a time; peak memory is irrelevant

If multi-user volume ever arrives, revisit.

---

## Phase A — Backend voice-captures proxy

**Goal:** New route `POST /api/v1/voice-captures` in core-api that proxies multipart uploads to internal `voice-capture:3001/api/capture`.

**Status:** PENDING

**Files Affected:**
- `packages/core-api/src/routes/voice-captures.ts` (NEW, ~70 LOC)
- `packages/core-api/src/app.ts` (1 line: registration call)
- `packages/core-api/src/__tests__/integration/voice-captures.test.ts` (NEW)
- `LAB_NOTEBOOK.md` (Entry 158: Phase A)

### A.1 — Create the proxy route

**File:** `packages/core-api/src/routes/voice-captures.ts`

Implementation skeleton:
```ts
import type { Hono } from 'hono'
import { ValidationError, logger } from '@open-brain/shared'

const VOICE_CAPTURE_URL =
  process.env.VOICE_CAPTURE_URL ?? 'http://voice-capture:3001/api/capture'

export function registerVoiceCaptureRoutes(app: Hono): void {
  app.post('/api/v1/voice-captures', async (c) => {
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      throw new ValidationError('Request must be multipart/form-data')
    }

    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      throw new ValidationError('Missing required field: file')
    }

    // Forward all fields verbatim — voice-capture validates format/size
    const upstreamForm = new FormData()
    for (const [key, value] of formData.entries()) {
      upstreamForm.append(key, value)
    }

    const t0 = Date.now()
    let response: Response
    try {
      response = await fetch(VOICE_CAPTURE_URL, {
        method: 'POST',
        headers: { 'X-Open-Brain-Caller': 'web-next-public' },
        body: upstreamForm,
      })
    } catch (err) {
      logger.error({ err, url: VOICE_CAPTURE_URL }, '[voice-captures] upstream unreachable')
      return c.json({ error: 'voice-capture service unreachable', code: 'BAD_GATEWAY' }, 502)
    }

    const durationMs = Date.now() - t0
    const text = await response.text()
    logger.info(
      { upstreamStatus: response.status, durationMs, fileBytes: (file as File).size },
      '[voice-captures] proxied',
    )

    return new Response(text, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
    })
  })
}
```

### A.2 — Register the route

In `packages/core-api/src/app.ts`, after `registerDocumentRoutes(...)`:
```ts
import { registerVoiceCaptureRoutes } from './routes/voice-captures.js'
// ... after other registrations:
registerVoiceCaptureRoutes(app)
```

### A.3 — Integration test

**File:** `packages/core-api/src/__tests__/integration/voice-captures.test.ts`

Test cases (mock `fetch` for upstream):
- ✅ 201 path: upstream 201 → response body forwards verbatim
- ✅ 400 from upstream surfaces with status 400 + body
- ✅ Missing `file` field → 400 ValidationError
- ✅ Upstream unreachable (`fetch` throws) → 502 with `code: 'BAD_GATEWAY'`
- ✅ Multipart with optional fields (brain_view, device, latitude/longitude) — all forwarded

Pattern: model on `packages/core-api/src/__tests__/integration/captures.test.ts` for setup. Use `vi.spyOn(global, 'fetch').mockResolvedValue(...)`.

### A.4 — Documentation

- `.env.template` (if present) — document `VOICE_CAPTURE_URL` (default `http://voice-capture:3001/api/capture`)
- `CLAUDE.md` Operational Rules — append to **API / endpoints** section: brief note on the new proxy route + that it does NOT bypass rate-limit (public callers correctly throttled)

### A.5 — Lab Notebook entry

**File:** `LAB_NOTEBOOK.md`

Entry 158 — "Phase A: voice-captures proxy route in core-api". Cover: why proxy not direct CF tunnel exposure (cleaner, less infra), buffer-and-rebuild trade-off, test coverage.

### Acceptance criteria (Phase A)

- [ ] `pnpm --filter @open-brain/core-api exec tsc --noEmit` passes
- [ ] `pnpm --filter @open-brain/core-api test src/__tests__/integration/voice-captures.test.ts` — all 5 cases pass
- [ ] On homeserver after deploy: `docker exec open-brain-core-api curl -s -X POST -F file=@/tmp/test.m4a -H "X-Open-Brain-Caller: integration-test" http://localhost:3000/api/v1/voice-captures` returns 201 with capture + transcription fields
- [ ] CLAUDE.md updated with the new endpoint
- [ ] LAB_NOTEBOOK Entry 158 written
- [ ] Single PR merged to main; homeserver pulled + `docker compose up -d --build core-api`; smoke test passes

### Definition of Done (Runnable)
```bash
# 1. Local typecheck
pnpm --filter @open-brain/core-api exec tsc --noEmit

# 2. Local integration test
pnpm --filter @open-brain/core-api test src/__tests__/integration/voice-captures.test.ts

# 3. Production smoke (after deploy)
ssh claude@homeserver.k4jda.net 'docker exec open-brain-core-api curl -sf -X POST \
  -F "file=@/path/to/test.m4a" \
  -H "X-Open-Brain-Caller: integration-test" \
  http://localhost:3000/api/v1/voice-captures' | jq '.capture.id'
```

---

## Phase B — `/mobile` route shell

**Goal:** Empty `/mobile` page that renders correctly on iPhone with full-bleed layout (no shell chrome) and proper safe-area / viewport handling. Provides the shell + state container for subsequent phases.

**Status:** PENDING

**Depends on:** None (can run parallel to A but ships after for natural sequencing)

**Files Affected:**
- `packages/web-next/app/mobile/page.tsx` (NEW)
- `packages/web-next/app/mobile/layout.tsx` (NEW)
- `packages/web-next/app/mobile/viewport.ts` (NEW)
- `packages/web-next/components/mobile/MobileShell.tsx` (NEW, client)
- `LAB_NOTEBOOK.md` (Entry 159: Phase B)

### B.1 — Route files

**`app/mobile/layout.tsx`** (RSC):
```tsx
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-ivory-medium text-slate-medium font-sans">
      {children}
    </div>
  )
}
```

**`app/mobile/viewport.ts`**:
```ts
import type { Viewport } from 'next'
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#F0EEE6',
  userScalable: false,
}
```

**`app/mobile/page.tsx`** (RSC):
```tsx
import { MobileShell } from '@/components/mobile/MobileShell'

interface Props { searchParams: Promise<{ q?: string }> }

export default async function MobilePage({ searchParams }: Props) {
  const { q = '' } = await searchParams
  return <MobileShell initialQuery={q.trim()} />
}
```

### B.2 — Shell component

**`components/mobile/MobileShell.tsx`** (client):
- Holds top-level state: `mode` ('text'|'voice'|'live'), `captureType`, `brainView`, `bottomSheetKind`, `toastKind`, `transcriptEcho`
- Composes (placeholders for now):
  - `<div data-zone="capture">CaptureZone goes here</div>`
  - `<div data-zone="search">SearchSection goes here</div>`
- Renders the ivory-light background, the static eyebrow "QUICK CAPTURE / brain.troy-davis.com" header strip
- Inherits Providers (TanStack Query, etc.) from root layout — verified by investigation

### B.3 — Lab Notebook entry

Entry 159 — "Phase B: /mobile route shell". Cover: full-bleed layout pattern, viewport-fit:cover decision, why outside `(shell)` group (no nav, no onboarding redirect).

### Acceptance criteria (Phase B)

- [ ] `https://brain.troy-davis.com/mobile` returns the page (after deploy)
- [ ] No top-nav, no side-nav (full-bleed)
- [ ] Page background `#F0EEE6` ivory-medium
- [ ] iPhone safe-area respected: `env(safe-area-inset-top)` content shifts down past notch
- [ ] No layout shift on keyboard focus (uses `100dvh` not `100vh`)
- [ ] `pnpm --filter @open-brain/web-next exec tsc --noEmit` passes
- [ ] `pnpm --filter @open-brain/web-next build` succeeds
- [ ] LAB_NOTEBOOK Entry 159 written

### Definition of Done (Runnable)
```bash
pnpm --filter @open-brain/web-next exec tsc --noEmit
pnpm --filter @open-brain/web-next build

# Manual: visit /mobile in iOS Safari (DevTools mobile emulation OK as proxy)
# Verify: full-bleed, no nav, ivory background
```

---

## Phase C — Capture zone (text + voice file modes)

**Goal:** Functional sticky capture zone with the mode selector, text mode, and voice file mode wired to real APIs. Bottom sheet pickers for capture type + brain view. Submit creates real captures.

**Status:** PENDING

**Depends on:** A (voice-captures route), B (page shell)

**Files Affected:**
- `packages/web-next/components/mobile/CaptureZone.tsx` (NEW)
- `packages/web-next/components/mobile/ModeSelector.tsx` (NEW)
- `packages/web-next/components/mobile/TextMode.tsx` (NEW)
- `packages/web-next/components/mobile/VoiceFileMode.tsx` (NEW)
- `packages/web-next/components/mobile/BottomSheet.tsx` (NEW)
- `packages/web-next/components/mobile/TypePicker.tsx` (NEW)
- `packages/web-next/components/mobile/ViewPicker.tsx` (NEW)
- `packages/web-next/components/mobile/SubmitButton.tsx` (NEW)
- `packages/web-next/lib/api/voice-captures.ts` (NEW, mirrors `ingest.ts`)
- `packages/web-next/lib/api/voice-captures.hooks.ts` (NEW)
- `packages/web-next/components/mobile/MobileShell.tsx` (UPDATE — wire CaptureZone in)
- `LAB_NOTEBOOK.md` (Entry 160: Phase C)

### C.1 — TanStack mutation hook for voice-captures

**`lib/api/voice-captures.ts`** — mirrors existing `ingest.ts` pattern (manual fetch, FormData):
```ts
import { getApiBase } from './core'

export interface VoiceCaptureOptions {
  brain_view?: string
  device?: string
}

export interface VoiceCaptureResponse {
  ok: true
  capture: { id: string; pipeline_status: string; created_at: string }
  transcription: { text: string; duration: number; language?: string }
  classification: { template: string; confidence: number; brain_view: string }
}

export const voiceCapturesApi = {
  upload: async (file: File, opts: VoiceCaptureOptions = {}): Promise<VoiceCaptureResponse> => {
    const formData = new FormData()
    formData.append('file', file, file.name)
    if (opts.brain_view) formData.append('brain_view', opts.brain_view)
    if (opts.device) formData.append('device', opts.device)

    const url = `${getApiBase()}/voice-captures`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'web-ui' }, // proxy.ts overwrites to web-next-public
      body: formData, // do NOT set Content-Type — browser handles boundary
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Voice capture failed: ${response.status} ${text}`)
    }
    return response.json()
  },
}
```

**`lib/api/voice-captures.hooks.ts`**:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { voiceCapturesApi, VoiceCaptureOptions } from './voice-captures'

export function useVoiceCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, opts }: { file: File; opts?: VoiceCaptureOptions }) =>
      voiceCapturesApi.upload(file, opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['captures', 'list'] })
    },
  })
}
```

### C.2 — Mode selector + capture zone container

`CaptureZone.tsx`:
- Sticky `top-0`, `z-20`, white-on-ivory header strip
- Renders `<ModeSelector />` then conditionally `<TextMode/>` or `<VoiceFileMode/>` (LiveRecord stub for Phase D)
- Sticky-collapse logic deferred to Phase E

`ModeSelector.tsx`:
- 3-tab segmented toggle, full-width, 52px tall
- Icons: `Type`, `FileAudio`, `Mic` from lucide-react (already in deps)
- Active tab: book-cloth underline (2px), tab text + icon ink-dark
- Match design's `quick-capture.jsx:QModeSelector`

### C.3 — Text mode

`TextMode.tsx`:
- Auto-expanding `<textarea>` (min 88px, max 220px), placeholder "What's on your mind?"
- Char count bottom-right (`{count} / 50,000`, mono font)
- Two pills below: capture type + brain view (each opens its bottom sheet on tap)
- Capture button (book-cloth bg, white text, 48px, full-width). Disabled when textarea empty or while submitting.
- On submit: `useCreateCapture()` mutation with body `{ content, capture_type, brain_view, source: 'api', metadata: { source_metadata: { client: 'mobile-web', captured_at_local: new Date().toISOString() } } }`
- Success: clear textarea, fire toast (Phase E composes; for now just call a `setToast('captured')` on the shell state)

### C.4 — Voice file mode

`VoiceFileMode.tsx`:
- States: `empty` (placeholder zone) / `selected` (file metadata + Send button) / `uploading` (progress) / `error`
- Empty state: dashed-border tap zone, opens `<input type="file" accept="audio/*">`
- Selected state: file icon + filename + duration (probed via `<audio>` element loadedmetadata) + size + remove (X)
- Brain view pill (no capture-type pill — voice-capture's classifier sets it)
- Send button (40px, book-cloth)
- On submit: `useVoiceCapture().mutate({ file, opts: { brain_view, device: 'mobile-web' } })`
- During upload: progress bar (note: fetch doesn't expose upload progress natively; use XHR or `whatwg-streams` for upload progress reporting — defer optimization, for now show indeterminate spinner)

### C.5 — Bottom sheets

`BottomSheet.tsx` (shared primitive):
- Backdrop overlay (`fixed inset-0 bg-slate-dark/40 z-40`)
- Sheet (`fixed bottom-0 inset-x-0 bg-white z-41`, slides up from bottom)
- Drag handle (40×4px rounded gray bar)
- Title + meta row + scrollable items list

`TypePicker.tsx`:
- 8 capture types from `CAPTURE_TYPES` const
- Radio-button style; tapped item highlighted with book-cloth border + soft fill
- Calls `onSelect(type)` then closes

`ViewPicker.tsx`:
- 5 brain views; same UX pattern

### C.6 — Lab Notebook entry

Entry 160 — "Phase C: capture zone — text + voice file modes". Cover: mutation hook patterns, bottom sheet primitive, file picker UX on mobile.

### Acceptance criteria (Phase C)

- [ ] Mode selector switches between text/voice/live (live shows placeholder for now)
- [ ] Text capture: type 5 chars, tap Capture → real capture created in DB (verify via `GET /api/v1/captures?limit=1`)
- [ ] Voice file: pick a real `.m4a` ≤5MB, tap Send → upload completes, transcription returned
- [ ] Bottom sheets open on pill tap, close on backdrop tap, persist selection
- [ ] All file/component sizes/colors/fonts match design tokens visually (spot-check 3 components against `/tmp/design-spec/mobile-spa/project/quick-capture.jsx`)
- [ ] `pnpm --filter @open-brain/web-next exec tsc --noEmit` passes
- [ ] `pnpm --filter @open-brain/web-next build` succeeds
- [ ] LAB_NOTEBOOK Entry 160 written

### Definition of Done (Runnable)
```bash
pnpm --filter @open-brain/web-next exec tsc --noEmit
pnpm --filter @open-brain/web-next build

# Manual on homeserver after deploy:
# - Visit https://brain.troy-davis.com/mobile in iOS Safari
# - Type "spa test", tap Capture, verify capture appears in /search
# - Pick a test .m4a, tap Send, verify transcription returns
# - Tap each pill, verify bottom sheet, select option, verify pill updates
```

---

## Phase D — Live record mode

**Goal:** In-browser MediaRecorder integration. User taps mic, grants permission, records, taps stop, blob uploads via `/api/v1/voice-captures`.

**Status:** PENDING

**Depends on:** A, B, C (reuses `useVoiceCapture` from C)

**Files Affected:**
- `packages/web-next/components/mobile/LiveRecordMode.tsx` (NEW)
- `packages/web-next/components/mobile/Waveform.tsx` (NEW)
- `packages/web-next/hooks/useMediaRecorder.ts` (NEW)
- `packages/web-next/components/mobile/CaptureZone.tsx` (UPDATE — wire LiveRecordMode)
- `LAB_NOTEBOOK.md` (Entry 161: Phase D)

### D.1 — `useMediaRecorder` hook

```ts
type Phase = 'idle' | 'requesting-permission' | 'recording' | 'processing' | 'error'

export function useMediaRecorder() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const start = async () => {
    setPhase('requesting-permission')
    setErrorMsg(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Pick the best supported format. iOS Safari 14.3+ → audio/mp4. Chrome → audio/webm.
      const preferredMime = MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const finalBlob = new Blob(chunksRef.current, { type: recorder.mimeType })
        setBlob(finalBlob)
        setPhase('processing')
        // Tear down stream
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }

      // AnalyserNode for waveform
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const source = audioCtx.createMediaStreamSource(stream)
      const a = audioCtx.createAnalyser()
      a.fftSize = 256
      source.connect(a)
      setAnalyser(a)

      recorder.start(250) // emit chunks every 250ms
      setPhase('recording')
      const startedAt = Date.now()
      timerRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000)
        setElapsed(seconds)
        if (seconds >= 600) stop() // 10-min auto-stop
      }, 250)
    } catch (err) {
      setPhase('error')
      setErrorMsg(err instanceof Error ? err.message : 'Microphone unavailable')
    }
  }

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    recorderRef.current?.stop()
  }

  const reset = () => {
    setPhase('idle')
    setElapsed(0)
    setBlob(null)
    setAnalyser(null)
    setErrorMsg(null)
  }

  return { phase, elapsed, errorMsg, blob, analyser, start, stop, reset }
}
```

### D.2 — Live record component states

`LiveRecordMode.tsx` renders one of 5 visual states:
- **idle:** Big circular mic button (96px, book-cloth bg). Eyebrow "TAP TO RECORD". Meta "UP TO 10 MIN · AUTO-CLASSIFIED".
- **requesting-permission:** Spinning loader on the mic button with "Allow microphone access…"
- **recording:** Red pulse + "RECORDING" eyebrow + mono timer (`MM:SS`) + 32-bar waveform from AnalyserNode + Stop button (full-width red, 48px).
- **processing:** After stop, show "Uploading…" state. When `blob` set, immediately call `useVoiceCapture().mutate({ file: new File([blob], 'recording.m4a', { type: blob.type }), opts: { device: 'mobile-web' } })`.
- **error:** Mic-blocked banner (`Microphone blocked. Open Settings → Safari → Microphone…`). Try again button.

**Critical:** The blob is named `recording.m4a` regardless of the actual `mimeType` because voice-capture validates **by extension**, not by content-type. The faster-whisper transcriber inside voice-capture handles m4a/mp3/wav/ogg formats. iOS Safari's `audio/mp4` blob renamed `.m4a` will be accepted and processed correctly.

### D.3 — Waveform visualizer

`Waveform.tsx`:
- Takes `analyser: AnalyserNode | null` prop
- 32 bars, evenly spaced
- `requestAnimationFrame` loop: read `analyser.getByteFrequencyData()` → map first 32 bins → render bar heights
- When analyser is null, renders flat low-amplitude bars

### D.4 — Browser compat verification (resolves U1 from unknowns)

**Pre-flight test before merging:** Open Chrome Android dev console:
```js
MediaRecorder.isTypeSupported('audio/mp4')   // expect: true (Chrome 100+)
MediaRecorder.isTypeSupported('audio/webm')  // expect: true (always)
```

If `audio/mp4` is supported in Chrome Android (highly likely on modern Chrome), use it everywhere. Else: fallback path posts `recording.webm` and we add `webm` to voice-capture's `SUPPORTED_FORMATS` in a follow-up issue.

### D.5 — Lab Notebook entry

Entry 161 — "Phase D: live record mode (MediaRecorder)". Cover: cross-browser MediaRecorder fragmentation, m4a-extension-trick rationale, AnalyserNode for waveform, mic-permission UX.

### Acceptance criteria (Phase D)

- [ ] iOS Safari: tap mic → permission prompt → grant → record 5s → tap stop → upload → transcription returned
- [ ] Chrome Android: same flow works
- [ ] Mic permission denied: error UI shown; "Try again" button retries
- [ ] Auto-stop fires at 10:00 (`elapsed >= 600`)
- [ ] Waveform animates while recording (visible motion in 32 bars)
- [ ] Timer shows correct `MM:SS`
- [ ] Cleanup: stream tracks stopped after recording ends (no mic indicator left in browser tab)
- [ ] `pnpm --filter @open-brain/web-next exec tsc --noEmit` passes
- [ ] LAB_NOTEBOOK Entry 161 written

### Definition of Done (Runnable)
```bash
pnpm --filter @open-brain/web-next exec tsc --noEmit
pnpm --filter @open-brain/web-next build

# Manual on a real iPhone (simulator may not have mic):
# - Visit /mobile, tap mic, grant permission, record "test capture",
#   tap stop, verify transcription appears as a new capture.
# - Deny permission, verify error UI; tap "Try again", grant, verify recovery.
```

---

## Phase E — Search section + polish

**Goal:** Below the capture zone: mobile-adapted search bar, synthesis card (conditional), result cards, all empty/loading/no-match/error states, pull-to-refresh, sticky-collapse, toast confirmation, transcript echo.

**Status:** PENDING

**Depends on:** A (for any voice transcript echo), B (page shell), C (toast / transcript echo wiring), D (transcript echo on live record)

**Files Affected:**
- `packages/web-next/components/mobile/MobileSearchBar.tsx` (NEW)
- `packages/web-next/components/mobile/MobileResultCard.tsx` (NEW)
- `packages/web-next/components/mobile/MobileResultsList.tsx` (NEW)
- `packages/web-next/components/mobile/MobileSynthesisCard.tsx` (NEW)
- `packages/web-next/components/mobile/MobilePullSpinner.tsx` (NEW)
- `packages/web-next/components/mobile/MobileEmptyState.tsx` (NEW)
- `packages/web-next/components/mobile/MobileNoMatch.tsx` (NEW)
- `packages/web-next/components/mobile/Toast.tsx` (NEW)
- `packages/web-next/components/mobile/TranscriptEcho.tsx` (NEW)
- `packages/web-next/hooks/useStickyCollapse.ts` (NEW)
- `packages/web-next/hooks/usePullToRefresh.ts` (NEW)
- `packages/web-next/components/mobile/CaptureZone.tsx` (UPDATE — collapsed state)
- `packages/web-next/components/mobile/MobileShell.tsx` (UPDATE — compose Search section)
- `LAB_NOTEBOOK.md` (Entry 162: Phase E)

### E.1 — Search bar + URL state

`MobileSearchBar.tsx`:
- Reuses pattern from existing `SearchInput.tsx` (300ms debounce, push to `?q=`)
- Visual: 44px tall, full-width, search icon left, X clear right when value present
- Border: 1px cloud-medium normal, 2px book-cloth focused

### E.2 — Result cards + states

`MobileResultCard.tsx`:
- Top row: source label + "·" + relative date (mono uppercase) | capture-type pill (right)
- Body: 2-line clamp content preview
- Bottom row: tags (truncated, +N overflow) | score (mono right)
- Tap → `/captures/<id>` (existing route)

`MobileResultsList.tsx`:
- Calls `useSearch({ q: query, limit: 20, search_mode: 'hybrid' })`
- Renders states: empty (no query) / loading (4 skeletons) / no-match / results / error

`MobileSynthesisCard.tsx`:
- Calls `useSynthesizeQuery({ query }, { enabled: isSynthesisRequest(query) })`
- Renders only for question-style queries
- Header: book-cloth Brain icon + "SYNTHESIS · {capture_count} SOURCES" eyebrow + "Xs" timer (right)
- Body: response text, font-display 15px

### E.3 — Sticky-collapse hook

`hooks/useStickyCollapse.ts`:
- Throttled scroll listener on the inner scrollable container (or window)
- Returns `collapsed: boolean` based on `scrollY > 200`
- Re-expansion: tap on collapsed bar, OR scroll back near top

### E.4 — Pull-to-refresh hook

`hooks/usePullToRefresh.ts`:
- Touch events on scrollable container
- Detects pull-from-top gesture (only when `scrollTop === 0`)
- Threshold: 60px sustained pull → trigger `onRefresh` callback
- Returns `pullProgress: 0–1` for spinner reveal animation

`MobilePullSpinner.tsx`:
- Hidden by default, animates in on `pullProgress > 0`
- Spins continuously while `isRefetching` is true

### E.5 — Toast + transcript echo

`Toast.tsx`:
- Slate-dark background, white text, 1.5s auto-dismiss
- Shown after text capture success
- Slot: "OBSERVATION" / "DECISION" etc. mono right-side

`TranscriptEcho.tsx`:
- Larger card with green check-icon + "VOICE CAPTURED · {duration}" eyebrow + transcribed text
- 3s auto-dismiss
- Shown after voice file or live record success

### E.6 — Lab Notebook entry

Entry 162 — "Phase E: search + polish (sticky-collapse, pull-to-refresh, toast)". Cover: pull-to-refresh gesture detection, sticky-collapse trigger thresholds, transcript-echo dismissal timing.

### Acceptance criteria (Phase E)

- [ ] Search bar: type "test", URL updates to `?q=test` after 300ms debounce
- [ ] Question query like "what is X?" shows synthesis card
- [ ] Plain keyword query shows results without synthesis card
- [ ] No-match query shows empty state with the query text
- [ ] Pull down at top of results: spinner appears, refetch triggers
- [ ] Scroll past 200px: capture zone collapses to 56px bar
- [ ] Tap collapsed bar: re-expands smoothly
- [ ] Text capture success: toast appears + auto-dismisses in 1.5s
- [ ] Voice (file or live) capture success: transcript echo card appears + auto-dismisses in 3s
- [ ] `pnpm --filter @open-brain/web-next exec tsc --noEmit` passes
- [ ] `pnpm --filter @open-brain/web-next build` succeeds
- [ ] LAB_NOTEBOOK Entry 162 written
- [ ] Final E2E smoke on real iPhone: capture text → see toast; capture voice → see echo; search question → see synthesis; scroll → see collapse

### Definition of Done (Runnable)
```bash
pnpm --filter @open-brain/web-next exec tsc --noEmit
pnpm --filter @open-brain/web-next build

# Manual full E2E on real iPhone:
# 1. Open https://brain.troy-davis.com/mobile
# 2. Type "espresso decision", tap Capture, verify toast
# 3. Tap mic, record "what's my Q4 hiring plan", stop, verify echo
# 4. Type "what's my Q4 hiring plan?" in search, verify synthesis card
# 5. Scroll down, verify capture zone collapses; tap to re-expand; verify smooth
# 6. Pull down at top of results, verify refetch
```

---

## Risk + Rollback

| Phase | Risk | Severity | Rollback (≤3 min) |
|---|---|---|---|
| A | New route only; no impact on existing | Low | `git revert <sha> && docker compose up -d --build core-api` on homeserver |
| B | New route, no public ingress until C+D+E ship | Low | `git revert` + redeploy web-next |
| C | Net-new components; isolated to /mobile | Low | `git revert` + redeploy web-next |
| D | Cross-browser MediaRecorder fragmentation | **Medium** | `git revert` + redeploy. Live record button can be hidden via single component-level guard while keeping voice file mode functional. |
| E | Net-new components; sticky-collapse + pull-to-refresh interaction unproven | Low-Medium | `git revert` + redeploy. Each polish item can be feature-flagged independently if isolation needed. |

---

## Unknowns Register

| # | Unknown | Severity | Affects | Resolution strategy |
|---|---|---|---|---|
| U1 | Does Chrome Android `MediaRecorder` produce a voice-capture-accepted format? | High | D | Pre-flight in D.4: test `MediaRecorder.isTypeSupported('audio/mp4')`. If false on Chrome, fallback path naming blob `.webm` + filing follow-up to add webm to voice-capture's SUPPORTED_FORMATS. |
| U2 | Does voice-capture log/gate on `X-Open-Brain-Caller` from inside the proxy? | Medium | A | Verify in test that voice-capture accepts arbitrary caller header; bypass-check is one-way. |
| U3 | iOS Safari pull-to-refresh interaction with native `<html>` overscroll | Medium | E | `overscroll-behavior-y: contain` on inner scroll container; test on real iPhone (not simulator). |
| U4 | Sticky-collapse glitch when keyboard opens (textarea focused) | Low | E | Use `100dvh` (dynamic viewport) on outer container; test on iOS. |

---

## Scope boundaries

**In scope:**
- 5 phases above (backend route + 4 frontend phases)
- Production deploy after each phase merges to main

**Explicitly out of scope** (for follow-up if needed):
- Photo capture mode (deferred — no native image pipeline; F27 is "won't have")
- Apple Watch / iOS Shortcut interactions (existing Shortcut continues to work)
- Offline capture queue + sync
- Editing past captures from result cards (read-only)
- Long-press context menu on result cards
- Push notifications
- Entity facet filtering on mobile (kept hidden)
- Infinite scroll for search results (top 20 sufficient)
- Adding `/mobile` as PWA `start_url` (separate decision, simple change later)
- E2E test automation (manual smoke per phase only)

---

## Implementation sequence + verification points

```
Phase A → main → deploy core-api → smoke test /api/v1/voice-captures with curl
   ↓
Phase B → main → deploy web-next → visit /mobile in iOS Safari, see empty shell
   ↓
Phase C → main → deploy web-next → text capture + voice file capture both work
   ↓
Phase D → main → deploy web-next → live record on iOS + Android both work
   ↓
Phase E → main → deploy web-next → full E2E on real iPhone passes acceptance
```

Estimated total wall time: 3.5–4.5 hours focused, plus deploy + smoke between phases.

---

## Definition of Done — entire plan

- [ ] All 5 phases merged to main
- [ ] Homeserver running `4f2dfb9 + 5 new commits`, all 17 containers healthy
- [ ] Manual E2E on real iPhone passes Phase E acceptance criteria
- [ ] LAB_NOTEBOOK has Entries 158–162 inclusive
- [ ] No new `unhealthy` containers
- [ ] Rate-limit dashboard shows `/api/v1/voice-captures` traffic correctly attributed to `web-next-public` tier
- [ ] No new GitHub issues opened from new bugs introduced (any *new* findings that were follow-ups, not regressions, are filed but acceptable)
