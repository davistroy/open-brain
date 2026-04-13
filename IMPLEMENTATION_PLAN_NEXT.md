# Implementation Plan: Phases 0B + 1A + 0D

**Generated:** 2026-04-12
**Based On:** Ultra Plan analysis (ULTRA_PLAN_0B_1A_0D.md), codebase investigation of 12 LLM call sites, homeserver infrastructure reconnaissance, Pipecat container analysis
**Total Phases:** 4
**Estimated Total Effort:** ~300 LOC code changes + operational VM setup + 2-week manual soak test

---

## Executive Summary

This plan covers three items from the Open Brain v3 Master Plan:

1. **Phase 0B** — Create a KVM VM on the homeserver (`open-brain-vm`, 192.168.10.53) running Claude Code CLI for T2 batch synthesis at zero marginal cost
2. **Phase 1A** — Migrate all 10 production LLM call sites from legacy routing to `completeByTask()`, activating the Jetson T1 classification tier wired in Phase 0A
3. **Phase 0D** — Structured 2-week Pipecat voice soak test with go/no-go criteria

A critical discovery from investigation: **Pipecat (WebSocket conversation) and voice-capture (HTTP POST one-shot) are complementary, not redundant.** The soak test validates Pipecat quality but will likely NOT lead to full voice-capture removal. Voice-capture classification migration is deferred accordingly.

The 10 call site migrations split into two change sets: 4 trivial core-api changes (gateway already available) and 6 workers changes (requires creating a gateway instance in workers `main.ts` first). All use the same pattern: `complete(prompt, alias)` → `completeByTask(prompt, taskName)`.

---

## Plan Overview

| Phase | Focus | Key Deliverables | Dependencies | Est. Effort |
|-------|-------|------------------|--------------|-------------|
| 1 | Homeserver KVM VM (0B) | Ubuntu 24.04 VM, Claude Code CLI, Docker connectivity | None | Operational |
| 2 | Core-API Call Site Migration (1A-core) | 4 call sites → `completeByTask()` | Phase 0A (done) | S (~4 files, ~20 LOC) |
| 3 | Workers Call Site Migration (1A-workers) | Gateway instance in workers + 6 call site migrations | Phase 2 | M (~8 files, ~250 LOC) |
| 4 | Pipecat Voice Soak Test (0D) | 10+ conversations, latency/quality metrics, go/no-go | None | Manual, 2 weeks |

Phases 1 and 4 can start immediately in parallel. Phase 2 has no dependencies (Phase 0A already done). Phase 3 depends on Phase 2 learnings.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Docker containers can't reach VM at 192.168.10.53 | LOW | HIGH | Test connectivity before committing dispatch code; `--add-host` fallback |
| Claude Code auth expires on VM | LOW | MEDIUM | Set up persistent auth; add to monthly maintenance |
| Breaking synthesis or governance during migration | LOW | HIGH | Same `Promise<string>` interface; `completeByTask()` has legacy fallback |
| Breaking pipeline during workers migration | MEDIUM | HIGH | Migrate one skill at a time, test each individually |
| Deepgram key not configured for Pipecat | LOW | MEDIUM | Check `.env.secrets` before starting soak |

---

<!-- BEGIN PHASES -->

## Phase 1: Homeserver KVM VM Setup (0B)

**Estimated Complexity:** Operational (no application code changes)
**Dependencies:** None
**Parallelizable:** Yes — with Phases 2, 3, and 4

### Goals

- Create a lightweight KVM VM on the Unraid homeserver for running `claude --print` (T2 tier)
- Verify Docker containers can reach the VM
- Establish the dispatch pattern for future batch source pipelines

### Work Items

#### 1.1 Create KVM VM via Unraid UI

**Description:**
Create the VM through Unraid's VM Manager web UI (Settings → VM Manager → Add VM).

**VM Configuration:**

| Parameter | Value |
|-----------|-------|
| Name | `open-brain-vm` |
| OS Type | Linux (Ubuntu) |
| ISO | `/mnt/user/isos/ubuntu-24.04.2-desktop-amd64.iso` (use server ISO if available; download `ubuntu-24.04.2-live-server-amd64.iso` if not) |
| vCPUs | 2 (i7-9700 cores — Claude CLI is I/O-bound, not compute) |
| RAM | 4 GB (Claude Code ~1GB + OS ~500MB + headroom) |
| vDisk | 20 GB, raw, on array or cache |
| Network | br0 (bridged — must be reachable from Docker) |
| Graphics | VNC (for initial setup only) |
| Auto-Start | Yes (start with array) |

**Tasks:**
1. [ ] SSH to homeserver, check if Ubuntu Server ISO exists: `ls /mnt/user/isos/ | grep server`
2. [ ] If no server ISO: download `ubuntu-24.04.2-live-server-amd64.iso` to `/mnt/user/isos/`
3. [ ] Create VM via Unraid web UI with parameters above
4. [ ] Boot VM, complete Ubuntu Server minimal installation
5. [ ] Set static IP: `192.168.10.53` via netplan config
6. [ ] Set hostname: `open-brain-vm`
7. [ ] Install openssh-server: `sudo apt install openssh-server`

**Acceptance Criteria:**
- [ ] VM boots and is accessible via `ssh 192.168.10.53`
- [ ] Hostname is `open-brain-vm`
- [ ] VM auto-starts when Unraid array starts

---

#### 1.2 Configure SSH Access

**Description:**
Set up the `claude` user with SSH key auth matching the pattern used on all other machines.

**Tasks:**
1. [ ] Create claude user: `sudo adduser claude`
2. [ ] Copy SSH public key: `ssh-copy-id -i ~/.ssh/id_claude_code.pub claude@192.168.10.53` (from Troy's laptop)
3. [ ] Verify key auth: `ssh -i ~/.ssh/id_claude_code claude@192.168.10.53 'hostname'` → `open-brain-vm`
4. [ ] Grant passwordless sudo for maintenance: add `/etc/sudoers.d/claude` with needed commands

**Acceptance Criteria:**
- [ ] `ssh -i ~/.ssh/id_claude_code claude@192.168.10.53` works without password
- [ ] Key matches pattern used for bond, spark, jetson, homeserver

---

#### 1.3 Install Claude Code CLI

**Description:**
Install Claude Code and authenticate with the Max subscription.

**Tasks:**
1. [ ] Install Node.js 22 LTS: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
2. [ ] Install Claude Code: `sudo npm install -g @anthropic-ai/claude-code` (or native binary installer)
3. [ ] Authenticate: Troy runs `claude login` on the VM (one-time browser flow via VNC or SSH tunnel)
4. [ ] Verify: `claude --print "What is 2+2?"` returns `4` (or similar)
5. [ ] Create dispatch script: `/home/claude/t2-synthesize.sh`

**Dispatch script:**
```bash
#!/bin/bash
# T2 synthesis dispatch — called via SSH from workers or scripts
# Usage: echo "prompt" | ssh claude@192.168.10.53 bash t2-synthesize.sh
# Or:    ssh claude@192.168.10.53 bash t2-synthesize.sh "inline prompt"
if [ $# -gt 0 ]; then
  claude --print "$@"
else
  claude --print < /dev/stdin
fi
```

**Acceptance Criteria:**
- [ ] `claude --print` works on VM with Max subscription
- [ ] Script `/home/claude/t2-synthesize.sh` exists and is executable
- [ ] Round-trip time < 30s for a typical synthesis prompt

---

#### 1.4 Verify Docker → VM Connectivity

**Description:**
Confirm that Open Brain Docker containers can reach the VM.

**Tasks:**
1. [ ] From homeserver: `sudo docker exec open-brain-workers sh -c 'wget -qO- http://192.168.10.53:22 2>&1 | head -1 || echo "port 22 check"'` (or use `nc` if available)
2. [ ] If connectivity fails: try `--add-host open-brain-vm:192.168.10.53` in workers service in docker-compose.yml
3. [ ] If that fails: check if br0 subnet routing allows Docker bridge → br0 traffic
4. [ ] Install SSH client in workers container if needed: add `openssh-client` to Alpine `apk add` in Dockerfile
5. [ ] Full test: `sudo docker exec open-brain-workers ssh -i /path/to/key -o StrictHostKeyChecking=no claude@192.168.10.53 'echo ok'`

**Note:** Workers container currently has no SSH capability. For the immediate future (Phase 0B), the dispatch mechanism is validated externally. Workers-to-VM SSH dispatch will be built when the first batch source (Phase 3A) is implemented. The VM just needs to be running and reachable.

**Acceptance Criteria:**
- [ ] VM is reachable from homeserver Docker containers (verified via basic connectivity test)
- [ ] Path documented for SSH-based dispatch when needed

---

#### 1.5 Update Memory and Config

**Tasks:**
1. [ ] Add VM details to `~/.claude/projects/.../memory/` — IP, hostname, purpose, SSH pattern
2. [ ] Add to CLAUDE.md remote machine table: `open-brain-vm | ssh -i ~/.ssh/id_claude_code claude@192.168.10.53 | Ubuntu 24.04, x86_64, KVM on homeserver | T2 Claude CLI batch synthesis`

**Acceptance Criteria:**
- [ ] Memory file created with VM details
- [ ] CLAUDE.md remote machine table updated
- [ ] LAB_NOTEBOOK entry created with VM setup steps, connectivity results, and Claude Code auth verification

---

### Phase 1 Testing Requirements

- [ ] VM boots, auto-starts, accessible via SSH
- [ ] Claude Code CLI authenticated and functional
- [ ] Docker container can reach VM (basic test)
- [ ] Dispatch script runs a prompt successfully

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] LAB_NOTEBOOK.md entry created (hypothesis, setup steps, results, connectivity test)
- [ ] Decision Log updated if any decisions made
- [ ] Memory files updated

---

## Phase 2: Core-API Call Site Migration (1A-core)

**Estimated Complexity:** S (~4 files, ~20 LOC)
**Dependencies:** Phase 0A (done — Jetson tier wired in ai-routing.yaml and gateway)
**Parallelizable:** Yes — with Phases 1 and 4

### Goals

- Migrate 4 core-api call sites from `gateway.complete(alias)` to `gateway.completeByTask(taskName)`
- Activate the three-tier routing for synthesis, governance, confidence gating, and entity linking
- Verify via `ai_audit_log` that calls route to the correct tiers

### Work Items

#### 2.1 Migrate synthesize.ts

**Status:** Pending
**File:** `packages/core-api/src/routes/synthesize.ts`
**Line:** 71

**Change:**
```typescript
// BEFORE:
const response = await llmGateway.complete(prompt, 'synthesis', {
  captureId: undefined,
  sessionId: undefined,
})

// AFTER:
const response = await llmGateway.completeByTask(prompt, 'search_synthesis', {
  captureId: undefined,
  sessionId: undefined,
})
```

**Task mapping:** `search_synthesis` → `t1_fast` (Haiku API) — user-facing, needs quality

**Acceptance Criteria:**
- [ ] Search synthesis answers render correctly on the web dashboard
- [ ] `ai_audit_log` shows `task_type = 'search_synthesis'`, `client_used` matches expected tier

---

#### 2.2 Migrate governance-engine.ts

**Status:** Pending
**File:** `packages/core-api/src/services/governance-engine.ts`
**Line:** 229

**Change:**
```typescript
// BEFORE:
botMessage = await this.llmGateway.complete(prompt, 'governance', {
  sessionId,
})

// AFTER:
botMessage = await this.llmGateway.completeByTask(prompt, 'governance', {
  sessionId,
})
```

**Task mapping:** `governance` → `t2_quality` (Sonnet API) — complex multi-turn reasoning

**Acceptance Criteria:**
- [ ] Governance session works via Slack `!brain check`
- [ ] `ai_audit_log` shows `task_type = 'governance'`, `client_used = 'anthropic'`

---

#### 2.3 Migrate anti-vagueness.ts

**Status:** Pending
**File:** `packages/core-api/src/services/anti-vagueness.ts`
**Line:** 113

**Change:**
```typescript
// BEFORE:
const raw = await this.llmGateway.complete(prompt, 'fast', {
  temperature: 0,
  maxTokens: 128,
})

// AFTER:
const raw = await this.llmGateway.completeByTask(prompt, 'confidence_gating', {
  temperature: 0,
  maxTokens: 128,
})
```

**Task mapping:** `confidence_gating` → `t1_jetson` (Qwen 3.5 4B, free) — simple yes/no classification

**Acceptance Criteria:**
- [ ] Governance anti-vagueness gate still prevents infinite loops
- [ ] `ai_audit_log` shows `task_type = 'confidence_gating'`

---

#### 2.4 Migrate entity-resolution.ts

**Status:** Pending
**File:** `packages/core-api/src/services/entity-resolution.ts`
**Line:** 125 (approximate — verify)

**Change:**
```typescript
// BEFORE:
await this.llmGateway.complete(prompt, 'fast', {...})

// AFTER:
await this.llmGateway.completeByTask(prompt, 'entity_linking', {...})
```

**Task mapping:** `entity_linking` → `t1_fast` (Haiku API) — needs reasoning quality

**Acceptance Criteria:**
- [ ] Entity resolution still works for ambiguous mentions
- [ ] `ai_audit_log` shows `task_type = 'entity_linking'`

---

#### 2.5 Update Tests

**Description:**
Update any core-api tests that mock `gateway.complete()` for these 4 call sites to instead expect `gateway.completeByTask()`.

**Files:**
- `packages/core-api/src/__tests__/synthesize.test.ts` (if exists)
- `packages/core-api/src/__tests__/governance-engine.test.ts` (if exists)
- `packages/core-api/src/__tests__/anti-vagueness.test.ts` (if exists)
- `packages/core-api/src/__tests__/entity-resolution.test.ts` (if exists)

**Acceptance Criteria:**
- [ ] All 694 core-api tests pass
- [ ] No test is mocking `gateway.complete()` for the migrated call sites
- [ ] LAB_NOTEBOOK entry created with migration details, test results, and audit log verification

---

### Phase 2 Testing Requirements

- [ ] Full core-api test suite passes (694 tests)
- [ ] Manual: search query → synthesis answer → audit log shows correct tier
- [ ] Manual: governance session → audit log shows `t2_quality`

### Phase 2 Completion Checklist

- [ ] All 4 call sites migrated
- [ ] Tests updated
- [ ] LAB_NOTEBOOK.md entry created
- [ ] Action Items A18 updated

---

## Phase 3: Workers Call Site Migration (1A-workers)

**Estimated Complexity:** M (~8 files, ~250 LOC)
**Dependencies:** Phase 2 (learn from core-api migration pattern)
**Parallelizable:** No — sequential within phase (one skill at a time)

### Goals

- Create an `LLMGatewayService` instance in workers `main.ts`
- Migrate 6 worker call sites from `callClaude()` + litellm fallback to `gateway.completeByTask()`
- Pass gateway through skill-execution dispatcher to each skill

### Work Items

#### 3.1 Create LLMGatewayService in Workers main.ts

**Status:** Pending
**File:** `packages/workers/src/main.ts`

**Description:**
Workers already have all the dependencies: `db`, `configService`, `anthropicClient`, `ollamaClient`, and a litellm client can be created. Wire these into a `LLMGatewayService` instance and pass it to the skill-execution worker.

**Changes:**
1. Import `LLMGatewayService` from `@open-brain/core-api` — **wait, this creates a cross-package dependency.** Core-api imports shared; workers importing core-api creates a circular risk.

**Revised approach:** Move `LLMGatewayService` to `@open-brain/shared` is not ideal (shared shouldn't have Drizzle insert logic). Instead, **duplicate the gateway into workers** as a lightweight version, or better: **extract the gateway class to shared and have the audit log insert be a pluggable callback.**

**Simplest approach (recommended):** Create a `createLiteLLMClient()` in workers (already imported from shared), then instantiate `LLMGatewayService` directly. The gateway class file can be imported from core-api by path — but this violates monorepo boundaries.

**Best approach:** The `LLMGatewayService` class is already in `core-api/src/services/llm-gateway.ts`. It has one dependency on core-api: the `ai_audit_log` Drizzle table import from `@open-brain/shared`. The `ServiceUnavailableError`, `logger`, and `getModelEntry` are all from shared. **The gateway CAN be moved to shared** — its only non-shared dependency (`ai_audit_log`) is already in shared's schema.

**Decision: Move `LLMGatewayService` to `@open-brain/shared`.**

**Tasks:**
1. [ ] Move `packages/core-api/src/services/llm-gateway.ts` → `packages/shared/src/services/llm-gateway.ts`
2. [ ] Export from `packages/shared/src/index.ts`
3. [ ] Update `packages/core-api/src/index.ts` to import from `@open-brain/shared` instead of local path
4. [ ] Update core-api test imports
5. [ ] Rebuild shared: `pnpm --filter @open-brain/shared build`
6. [ ] Verify core-api builds and tests pass
7. [ ] In `packages/workers/src/main.ts`: create `LLMGatewayService` instance using existing `db`, `configService`, `anthropicClient`, `ollamaClient`
8. [ ] Create litellm client in workers: `const litellmClient = createLiteLLMClient({ timeout: 'standard' })` (already imported)
9. [ ] Pass gateway to `createSkillExecutionWorker()` via opts
10. [ ] Pass gateway to `createExtractEntitiesWorker()` via new param

**Acceptance Criteria:**
- [ ] `LLMGatewayService` importable from `@open-brain/shared`
- [ ] Core-api still works (imports updated)
- [ ] Workers `main.ts` creates gateway instance
- [ ] All existing tests pass in both packages

---

#### 3.2 Migrate extract-entities.ts

**Status:** Pending
**File:** `packages/workers/src/jobs/extract-entities.ts`
**Line:** ~129

**Description:**
Replace the `callClaude()` + litellm fallback pattern with `gateway.completeByTask('entity_extraction', prompt)`.

**Current pattern (lines ~120-145):**
```typescript
if (anthropicClient) {
  const claudeResult = await callClaude(anthropicClient, prompt, {
    model: synthesisModel,
    maxTokens: 1024,
    temperature: 0.1,
  })
  rawText = claudeResult.text
} else {
  const response = await litellmClient.chat.completions.create({...})
  rawText = response.choices[0]?.message?.content ?? ''
}
```

**After:**
```typescript
rawText = await llmGateway.completeByTask(prompt, 'entity_extraction', {
  temperature: 0.1,
  maxTokens: 1024,
  captureId,
})
```

**Task mapping:** `entity_extraction` → `t1_fast` (Haiku API)

**Changes:**
1. [ ] Add `llmGateway` param to `createExtractEntitiesWorker()` factory function
2. [ ] Replace dual `callClaude`/litellm block with single `gateway.completeByTask()` call
3. [ ] Remove unused `anthropicClient`, `litellmClient`, `synthesisModel` params (if no longer needed)
4. [ ] Update `main.ts` call to pass gateway

**Acceptance Criteria:**
- [ ] Entity extraction works on new captures
- [ ] `ai_audit_log` shows `task_type = 'entity_extraction'`
- [ ] Workers tests pass

---

#### 3.3 Migrate Skill: weekly-brief.ts

**Status:** Pending
**File:** `packages/workers/src/skills/weekly-brief.ts`
**Line:** ~101

**Change:** Replace `callClaude()` + litellm fallback with `gateway.completeByTask('weekly_brief', prompt)`.

**Task mapping:** `weekly_brief` → `t2_quality` (Sonnet API)

**Tasks:**
1. [ ] Add `llmGateway` param to `executeWeeklyBrief()`
2. [ ] Replace dual call pattern with `gateway.completeByTask()`
3. [ ] Update `skill-execution.ts` to pass gateway when calling `executeWeeklyBrief()`
4. [ ] Update tests

**Acceptance Criteria:**
- [ ] Manually trigger weekly-brief → produces output
- [ ] `ai_audit_log` shows `task_type = 'weekly_brief'`, `client_used = 'anthropic'`

---

#### 3.4 Migrate Skill: daily-sweep-skill.ts

**Status:** Pending
**File:** `packages/workers/src/skills/daily-sweep-skill.ts`
**Line:** ~382

**Task mapping:** `daily_sweep` → `t1_fast`

**Tasks:**
1. [ ] Add `llmGateway` param to `executeDailySweep()`
2. [ ] Replace dual call pattern
3. [ ] Update `skill-execution.ts` dispatch
4. [ ] Update tests

**Acceptance Criteria:**
- [ ] Daily sweep produces notification
- [ ] `ai_audit_log` shows `task_type = 'daily_sweep'`

---

#### 3.5 Migrate Skill: drift-monitor.ts

**Status:** Pending
**File:** `packages/workers/src/skills/drift-monitor.ts`
**Line:** ~183

**Task mapping:** `drift_monitoring` → `t2_quality`

**Tasks:**
1. [ ] Add `llmGateway` param to `executeDriftMonitor()`
2. [ ] Replace dual call pattern
3. [ ] Update `skill-execution.ts` dispatch
4. [ ] Update tests

**Acceptance Criteria:**
- [ ] Drift monitor produces output when triggered
- [ ] `ai_audit_log` shows `task_type = 'drift_monitoring'`

---

#### 3.6 Migrate Skill: daily-connections.ts

**Status:** Pending
**File:** `packages/workers/src/skills/daily-connections.ts`
**Line:** ~162

**Task mapping:** `daily_connections` → `t2_quality`

**Tasks:**
1. [ ] Add `llmGateway` param to `executeDailyConnections()`
2. [ ] Replace dual call pattern
3. [ ] Update `skill-execution.ts` dispatch
4. [ ] Update tests

**Acceptance Criteria:**
- [ ] Daily connections produces output when triggered
- [ ] `ai_audit_log` shows `task_type = 'daily_connections'`

---

#### 3.7 Migrate Skill: memory-consolidation.ts

**Status:** Pending
**File:** `packages/workers/src/skills/memory-consolidation.ts`
**Line:** ~399

**Task mapping:** `search_synthesis` → `t1_fast` (consolidation is synthesis-like)

**Tasks:**
1. [ ] Add `llmGateway` param to `executeMemoryConsolidation()`
2. [ ] Replace dual call pattern
3. [ ] Update `skill-execution.ts` dispatch
4. [ ] Update tests

**Acceptance Criteria:**
- [ ] Memory consolidation produces output when triggered
- [ ] `ai_audit_log` shows correct task type and tier

---

#### 3.8 Update skill-execution.ts Dispatcher

**Status:** Pending
**File:** `packages/workers/src/jobs/skill-execution.ts`

**Description:**
The skill-execution worker creates all skills via a switch statement. It needs to receive the gateway in its `opts` and pass it to each migrated skill.

**Changes:**
1. [ ] Add `llmGateway` to `opts` type in `createSkillExecutionWorker()`
2. [ ] Pass `opts.llmGateway` to each skill's execute function in the switch cases
3. [ ] Remove `synthesisModel` resolution (gateway handles model selection internally)

**Acceptance Criteria:**
- [ ] All skills receive the gateway
- [ ] `synthesisModel` removed from skill-execution (no longer needed)
- [ ] All workers tests pass (826 tests)
- [ ] LAB_NOTEBOOK entry created with migration details, test results, audit log analysis showing tier distribution

---

### Phase 3 Testing Requirements

- [ ] Full workers test suite passes (826 tests)
- [ ] `pnpm --filter @open-brain/shared build` succeeds (gateway moved here)
- [ ] `pnpm --filter @open-brain/core-api exec tsc --noEmit` clean
- [ ] `pnpm --filter @open-brain/workers exec tsc --noEmit` clean
- [ ] Manual: create capture → pipeline runs → audit log shows entity_extraction on t1_fast
- [ ] Manual: trigger daily-sweep → audit log shows daily_sweep tier
- [ ] Analyze `ai_audit_log` for tier distribution — confirm classification tasks going to Jetson tier

### Phase 3 Completion Checklist

- [ ] Gateway moved to shared
- [ ] All 6 worker call sites migrated
- [ ] skill-execution dispatcher updated
- [ ] All tests pass
- [ ] LAB_NOTEBOOK.md entry created
- [ ] Action Items A18 and A19 updated
- [ ] CLAUDE.md updated with any new operational rules

---

## Phase 4: Pipecat Voice Soak Test (0D)

**Estimated Complexity:** Manual, 2-week soak period
**Dependencies:** None (voice-pipecat already healthy on homeserver)
**Parallelizable:** Yes — runs in parallel with Phases 1-3

### Goals

- Validate Pipecat voice service for real-world conversational use over 2 weeks
- Measure latency, accuracy, reliability, and capture quality
- Produce go/no-go decision for Pipecat as primary conversational voice interface
- Determine future of legacy voice-capture service (keep for iOS Shortcut, or find alternative)

### Prerequisites

1. [ ] Verify `DEEPGRAM_API_KEY` in `.env.secrets` on homeserver: `sudo docker exec open-brain-voice-pipecat env | grep DEEPGRAM`
2. [ ] Verify `ANTHROPIC_API_KEY` in `.env.secrets`: `sudo docker exec open-brain-voice-pipecat env | grep ANTHROPIC`
3. [ ] Health check: `curl http://homeserver.k4jda.net:8766/health` returns healthy with all components

### Work Items

#### 4.1 Week 1: Basic Validation (Days 1-7)

**Days 1-3: Connection and basic quality**
- [ ] Connect via WebSocket client to `ws://homeserver.k4jda.net:8765`
- [ ] Complete 3 conversations per day (varied topics: personal, work, technical)
- [ ] Measure: connection time, first response latency, transcription accuracy
- [ ] Log each conversation: duration, turns, subjective quality (1-5), issues

**Days 4-7: Feature validation**
- [ ] Test tool usage: ask questions that require `search_brain()` or `get_entity()`
- [ ] Test capture extraction: verify post-session captures created in core-api
- [ ] Test interrupt handling: speak during TTS playback
- [ ] Test silence timeout: verify session ends after 30s silence
- [ ] Test multi-turn context: conversations with 10+ turns maintain coherence

#### 4.2 Week 2: Reliability and Edge Cases (Days 8-14)

**Days 8-10: Stress and reliability**
- [ ] Long conversation: 15+ minute session with 20+ turns
- [ ] Back-to-back sessions: end one, immediately start another
- [ ] Network resilience: what happens if WebSocket drops mid-conversation?
- [ ] Check memory: container stays under 4GB limit

**Days 11-14: Daily use evaluation**
- [ ] Use Pipecat as primary conversational interface (at least 2 conversations/day)
- [ ] Note any usability friction, latency spikes, or quality issues
- [ ] Final quality assessment

#### 4.3 Metrics Collection

For each conversation, log to LAB_NOTEBOOK:

| Metric | Target |
|--------|--------|
| Connection success rate | > 95% |
| First response latency (p50) | < 2s |
| First response latency (p95) | < 3s |
| Transcription accuracy (spot-check) | > 90% |
| Response quality (1-5 average) | > 3.5 |
| Capture extraction accuracy | > 90% |
| Session crashes | 0 in final week |
| Memory usage (steady state) | < 4GB |

#### 4.4 Go/No-Go Decision

After 2 weeks, document in LAB_NOTEBOOK:

**Decision criteria:**
- **GO:** All metrics meet targets → Pipecat is production-ready for conversational use
- **NO-GO:** Significant issues → document what needs fixing, re-soak after fixes

**Scope clarification (based on investigation finding):**
- Pipecat serves **real-time conversation** (WebSocket)
- Voice-capture serves **one-shot upload** (HTTP POST from iOS Shortcut)
- These are complementary — "GO" for Pipecat does NOT mean removing voice-capture
- Voice-capture removal is a separate decision based on whether Pipecat can handle HTTP uploads or the iOS Shortcut can be rewritten for WebSocket

**Acceptance Criteria:**
- [ ] 10+ conversations completed across 2 weeks
- [ ] All metrics documented with numbers
- [ ] Go/no-go decision documented with rationale
- [ ] Voice-capture future clearly decided: keep (complementary) or retire (if Pipecat can handle one-shot)
- [ ] LAB_NOTEBOOK entry created with all measurements, quality notes, and decision

---

### Phase 4 Completion Checklist

- [ ] All test conversations completed
- [ ] Metrics collected and analyzed
- [ ] Go/no-go decision made
- [ ] LAB_NOTEBOOK.md entry created (detailed measurements, quality samples, decision rationale)
- [ ] Action Items A14 and A15 updated
- [ ] IMPLEMENT_MASTER_PLAN.md Phase 1C updated based on decision

<!-- END PHASES -->

---

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (VM Setup) | Phases 2, 3, 4 | Independent infrastructure |
| Phase 2 (Core-API) | Phases 1, 4 | No dependency on VM |
| Phase 3 (Workers) | Phases 1, 4 | Depends on Phase 2 learnings |
| Phase 4 (Soak) | Phases 1, 2, 3 | Manual, fully independent |

**Recommended execution:**

```
Session 1 (now):     Phase 2 (Core-API migration — quick, low risk)
Session 2 (next):    Phase 3 (Workers migration — larger, depends on Phase 2)
Troy (parallel):     Phase 1 (VM setup — operational, Troy does via Unraid UI)
Troy (parallel):     Phase 4 (Soak test — manual, 2 weeks starting anytime)
```

---

## Scope Boundaries

**In scope:**
- KVM VM creation, Claude Code CLI setup, Docker connectivity verification
- 10 LLM call site migrations (4 core-api + 6 workers)
- Moving LLMGatewayService to shared package
- Workers gateway instance creation
- Pipecat soak test plan and execution
- Lab notebook entries for each phase

**Out of scope:**
- T2 dispatch code in workers (built when first batch source is implemented)
- Voice-capture classification migration (deferred pending soak outcome)
- Batch source pipelines (Phases 3A-3H in master plan)
- Voice-capture removal decision (Phase 1C in master plan, depends on 0D outcome)
- Any changes to voice-pipecat code

**Deferred items:**

| Item | Reason | When |
|------|--------|------|
| Voice-capture call site migration (#11-12) | Pending soak test outcome | After Phase 4 go/no-go |
| T2 BullMQ dispatch worker | No batch sources yet | Phase 3A (email pipeline) |
| Jetson endpoint production validation | Need to test from Docker containers | After Phase 3 deploy |

---

## Success Metrics

| Metric | Target | Phase |
|--------|--------|-------|
| VM accessible from Docker | Connectivity verified | Phase 1 |
| Claude CLI round-trip | < 30s | Phase 1 |
| Core-API tests | 694/694 pass | Phase 2 |
| Workers tests | 826/826 pass | Phase 3 |
| Audit log tier distribution | Classification → t1_jetson, complex → t2_quality | Phase 3 |
| Pipecat first response latency | < 2s p50 | Phase 4 |
| Pipecat session crashes | 0 in final week | Phase 4 |

---

*Implementation plan generated 2026-04-12 by Claude Code*
*Source: Ultra Plan analysis (ULTRA_PLAN_0B_1A_0D.md) → formal plan*
*Phases: 4 | Work Items: 18 | Estimated LOC: ~300 + operational*
