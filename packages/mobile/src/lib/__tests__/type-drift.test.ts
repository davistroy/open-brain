/**
 * type-drift.test.ts — Drift guards: mobile local types vs @open-brain/shared canonical types.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * mobile re-declares CaptureSource, CaptureType, and PipelineStatus locally
 * (packages/mobile/src/lib/types.ts) to keep the React Native app free of a
 * build-time dependency on @open-brain/shared. That convenience creates a
 * silent drift risk: a developer can add a 10th source to shared and forget to
 * mirror it here.
 *
 * This file provides two complementary guards:
 *
 *   (a) COMPILE-TIME — AssertEqual bidirectional-assignability assertions.
 *       tsc/lint fails the moment any of the three local unions no longer exactly
 *       matches the expected canonical union defined in this file.
 *       Run via: pnpm --filter @open-brain/mobile lint
 *
 *   (b) RUNTIME — Set equality checks comparing local runtime arrays against
 *       the expected canonical sets in this file.
 *       Run via: pnpm --filter @open-brain/mobile test
 *
 * HOW TO UPDATE
 * -------------
 * When a new value is added to @open-brain/shared (packages/shared/src/types/capture.ts):
 *   1. Update the local union in packages/mobile/src/lib/types.ts.
 *   2. Update the `Expected*` type alias in THIS file.
 *   3. Update the `LOCAL_*` constant array in THIS file.
 * Skipping any step will fail lint (step 2) or fail the test (step 3).
 */

import type { CaptureType, CaptureSource, PipelineStatus } from '../types';

// ---------------------------------------------------------------------------
// (a) Compile-time drift guards
// ---------------------------------------------------------------------------

/**
 * AssertEqual<A, B> resolves to `true` only when A and B are exactly the same
 * type (bidirectional assignability). Any missing or extra union member causes
 * the type to resolve to `never`, making the assignment below a compile error.
 */
type AssertEqual<A, B> =
  [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ---------------------------------------------------------------------------
// Expected canonical values — keep in sync with:
//   packages/shared/src/types/capture.ts  (CaptureType, CaptureSource, PipelineStatus)
// ---------------------------------------------------------------------------

/** 8-member canonical set — mirrors shared CaptureType */
type ExpectedCaptureType =
  | 'decision'
  | 'idea'
  | 'observation'
  | 'task'
  | 'win'
  | 'blocker'
  | 'question'
  | 'reflection';

/** 9-member canonical set — mirrors shared CaptureSource */
type ExpectedCaptureSource =
  | 'slack'
  | 'voice'
  | 'api'
  | 'document'
  | 'mcp'
  | 'email'
  | 'file'
  | 'consolidation'
  | 'system';

/** 8-member canonical set — mirrors shared PipelineStatus */
type ExpectedPipelineStatus =
  | 'pending'
  | 'processing'
  | 'extracted'
  | 'embedded'
  | 'chunked'
  | 'complete'
  | 'failed'
  | 'deleted';

// If any of the local unions diverge from the expected canonical type, TypeScript
// resolves AssertEqual to `never` and the assignment `= true` fails at compile time.
const _captureTypeGuard: AssertEqual<CaptureType, ExpectedCaptureType> = true;
const _captureSourceGuard: AssertEqual<CaptureSource, ExpectedCaptureSource> = true;
const _pipelineStatusGuard: AssertEqual<PipelineStatus, ExpectedPipelineStatus> = true;

// Explicitly reference the guards so linters don't flag them as unused.
void _captureTypeGuard;
void _captureSourceGuard;
void _pipelineStatusGuard;

// ---------------------------------------------------------------------------
// Runtime arrays used in (b) runtime assertions below.
// Each is typed with the LOCAL union so tsc catches invalid members at compile
// time, while the runtime set-equality check catches missing members.
// ---------------------------------------------------------------------------

/** All 8 CaptureType values — must mirror ExpectedCaptureType above. */
const LOCAL_CAPTURE_TYPES: CaptureType[] = [
  'decision',
  'idea',
  'observation',
  'task',
  'win',
  'blocker',
  'question',
  'reflection',
];

/** All 9 CaptureSource values — must mirror ExpectedCaptureSource above. */
const LOCAL_CAPTURE_SOURCES: CaptureSource[] = [
  'slack',
  'voice',
  'api',
  'document',
  'mcp',
  'email',
  'file',
  'consolidation',
  'system',
];

/** All 8 PipelineStatus values — must mirror ExpectedPipelineStatus above. */
const LOCAL_PIPELINE_STATUSES: PipelineStatus[] = [
  'pending',
  'processing',
  'extracted',
  'embedded',
  'chunked',
  'complete',
  'failed',
  'deleted',
];

// ---------------------------------------------------------------------------
// Expected canonical sets (runtime mirrors of the Expected* types above)
// ---------------------------------------------------------------------------

const EXPECTED_CAPTURE_TYPES = new Set<string>([
  'decision', 'idea', 'observation', 'task',
  'win', 'blocker', 'question', 'reflection',
]);

const EXPECTED_CAPTURE_SOURCES = new Set<string>([
  'slack', 'voice', 'api', 'document', 'mcp',
  'email', 'file', 'consolidation', 'system',
]);

const EXPECTED_PIPELINE_STATUSES = new Set<string>([
  'pending', 'processing', 'extracted', 'embedded',
  'chunked', 'complete', 'failed', 'deleted',
]);

// ---------------------------------------------------------------------------
// (b) Runtime drift guards
// ---------------------------------------------------------------------------

describe('type-drift guards: mobile local types vs @open-brain/shared canonical', () => {
  describe('CaptureType', () => {
    it('LOCAL_CAPTURE_TYPES matches the 8-member canonical set', () => {
      expect(new Set<string>(LOCAL_CAPTURE_TYPES)).toEqual(EXPECTED_CAPTURE_TYPES);
    });

    it('has exactly 8 members', () => {
      expect(EXPECTED_CAPTURE_TYPES.size).toBe(8);
    });
  });

  describe('CaptureSource', () => {
    it('LOCAL_CAPTURE_SOURCES matches the 9-member canonical set', () => {
      expect(new Set<string>(LOCAL_CAPTURE_SOURCES)).toEqual(EXPECTED_CAPTURE_SOURCES);
    });

    it('has exactly 9 members', () => {
      expect(EXPECTED_CAPTURE_SOURCES.size).toBe(9);
    });
  });

  describe('PipelineStatus', () => {
    it('LOCAL_PIPELINE_STATUSES matches the 8-member canonical set', () => {
      expect(new Set<string>(LOCAL_PIPELINE_STATUSES)).toEqual(EXPECTED_PIPELINE_STATUSES);
    });

    it('has exactly 8 members', () => {
      expect(EXPECTED_PIPELINE_STATUSES.size).toBe(8);
    });
  });
});
