# Implementation Plan: Voice Capture Location

**Feature:** Add optional GPS location to voice captures from iOS Shortcut
**Date:** 2026-03-30
**Status:** PENDING
**Estimated effort:** Small (4 files, ~80 LOC, <30 min)
**Risk:** Low — no schema migration, no pipeline changes, JSONB handles new fields transparently

---

## Background

The iOS Shortcut captures voice memos from iPhone/Apple Watch and POSTs audio to the voice-capture service. Currently the capture stores device, duration, filename, and language in `source_metadata` (JSONB). GPS location is available on the iOS side via the "Get Current Location" Shortcut action but is not captured.

### Investigation Summary

Full data flow traced: iOS → voice-capture → core-api → Postgres → pipeline → search → web UI.

**Touch points that need changes:** voice-capture endpoint, CaptureDetail component, iOS docs, tests.

**Touch points verified as unaffected:** Database schema (JSONB accepts new fields), core-api capture creation (passes source_metadata transparently), all 4 pipeline stages (none read source_metadata), search service (returns full CaptureRecord), web UI types (`Record<string, unknown>` already accepts any shape), weekly brief (doesn't query source_metadata).

### Design Decisions

1. **Store in `source_metadata` JSONB** — not a dedicated column. Location is optional metadata about the capture source, not a first-class entity. JSONB is the right abstraction.
2. **Let iOS handle reverse geocoding** — the iOS Shortcut provides both coordinates AND a human-readable address via built-in geocoding. No server-side geocoding dependency needed.
3. **Validate at ingestion boundary** — coordinate range validation happens in voice-capture, before data enters the system.
4. **Fix CaptureDetail raw JSON dump** — existing UX debt where source_metadata renders as raw JSON. Fix as part of this work since it's the same rendering path and the root cause of why new metadata would look bad.

---

## Phase 1: Voice Capture Endpoint

**File:** `packages/voice-capture/src/server.ts`
**Status:** PENDING

### Items

- [ ] **1.1** Parse optional form fields: `latitude` (string→float), `longitude` (string→float), `location_name` (string), `location_accuracy` (string→float, meters)
- [ ] **1.2** Validate coordinate ranges: latitude -90 to +90, longitude -180 to +180. Reject with 400 if out of range. Require both lat+lng or neither (no partial coordinates).
- [ ] **1.3** Include in `source_metadata` when present:
  ```json
  {
    "device": "apple_watch",
    "duration_seconds": 54.8,
    "original_filename": "Audio Recording.wav",
    "language": "en",
    "location": {
      "latitude": 33.749,
      "longitude": -84.388,
      "name": "Atlanta, GA",
      "accuracy_meters": 10.5
    }
  }
  ```
- [ ] **1.4** Location fields are fully optional — omission is the normal case for captures without location. No change to existing behavior when fields are absent.

### Notes

- Nest location fields under a `location` key within source_metadata rather than as flat top-level fields. This keeps the JSONB structure organized and makes it easy to check `if (source_metadata.location)` downstream.
- `location_name` comes from iOS reverse geocoding — it's pre-formatted (e.g., "123 Main St, Atlanta, GA 30303" or "Atlanta, GA" depending on Shortcut config).
- `location_accuracy` is from iOS `CLLocation.horizontalAccuracy` — useful for knowing if the location is GPS-precise (5m) or cell-tower approximate (500m+).

---

## Phase 2: CaptureDetail Display

**File:** `packages/web/src/components/CaptureDetail.tsx`
**Status:** PENDING

### Items

- [ ] **2.1** Replace raw JSON dump of `source_metadata` with structured rendering. Parse known fields:
  - **Device:** icon + label (e.g., "Apple Watch")
  - **Duration:** formatted as "Xm Ys"
  - **Language:** language code or name
  - **Location:** pin icon + `location.name` if present, with coordinates as tooltip or secondary text
- [ ] **2.2** For unknown source_metadata keys (future-proofing), fall back to formatted key-value display rather than raw JSON.
- [ ] **2.3** If `location.latitude` and `location.longitude` are present, render the location name as a link to Google Maps: `https://maps.google.com/?q={lat},{lng}`

### Notes

- This fixes existing UX debt — currently ALL source_metadata (device, duration, filename, language) displays as an ugly JSON blob. The fix benefits all capture types, not just location-enhanced ones.
- Keep it simple: no map embed, no geocoding widget. A text line with an optional maps link.

---

## Phase 3: iOS Shortcut Documentation

**File:** `docs/ios-shortcut.md`
**Status:** PENDING

### Items

- [ ] **3.1** Add "Get Current Location" action between "Record Audio" and "Get Contents of URL" in the Shortcut steps.
- [ ] **3.2** Document 3 new form fields in the "Get Contents of URL" action:
  - `latitude` — from Location.Latitude
  - `longitude` — from Location.Longitude
  - `location_name` — from Location.Street + ", " + Location.City + ", " + Location.State (or whatever iOS provides)
- [ ] **3.3** Update the endpoint reference table with the new optional fields.
- [ ] **3.4** Add a note that location is optional — the Shortcut works without it, and users can omit the "Get Current Location" action if they prefer not to share location.

---

## Phase 4: Tests

**File:** `packages/voice-capture/src/__tests__/server.test.ts`
**Status:** PENDING

### Items

- [ ] **4.1** Test: POST with valid location fields → 200, source_metadata includes `location` object with lat/lng/name/accuracy
- [ ] **4.2** Test: POST without location fields → 200, source_metadata has no `location` key (backward compat)
- [ ] **4.3** Test: POST with latitude but no longitude → 400 validation error
- [ ] **4.4** Test: POST with latitude out of range (e.g., 999) → 400 validation error
- [ ] **4.5** Test: POST with non-numeric latitude string → 400 or ignored (decide: reject vs. skip)

### Decision for 4.5

**Reject with 400** — if the client sends a latitude field, it should be a valid number. Silent drops hide bugs in the iOS Shortcut configuration. Fail fast, fail loud.

---

## Out of Scope (Future)

These are natural follow-ons but explicitly NOT part of this plan:

- **Location-based search filtering** — "show me captures from Atlanta" requires SQL index on JSONB path, UI filter component. Add when there's enough location data to be useful.
- **Location on CaptureCard/Timeline** — pin icon on cards. Visual clutter risk for minimal value. CaptureDetail is sufficient for now.
- **Weekly brief location grouping** — "3 ideas at the office, 2 while commuting." Requires brief query to include source_metadata. Natural enhancement after location data accumulates.
- **Location on non-voice captures** — browser geolocation for web dashboard, Slack location. Different ingestion paths, different privacy considerations.
- **Map visualization** — dedicated map view showing captures geographically. Premature until there are 100+ located captures.

---

## Rollback

All changes are additive. Rollback is `git revert` of the commit(s). No migration to reverse, no data to clean up. Existing captures without location continue to work identically.
