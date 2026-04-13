# Ultra Plan — Phases 0B, 1A, 0D

**Generated:** 2026-04-12
**Items:** 3 (VM setup, LLM call site migration, Pipecat voice soak)
**Investigation Depth:** Full code trace of 12 LLM call sites, homeserver infrastructure recon, Pipecat container analysis

---

## Phase 1 — Investigation Findings

### Item 1: Phase 0B — Homeserver Ubuntu VM for Claude Code CLI (T2 Tier)

| Field | Finding |
|-------|---------|
| **Item** | Set up a KVM VM on the Unraid homeserver to run `claude --print` for batch LLM synthesis |
| **Root cause** | No T2 tier exists yet. All LLM calls hit T3 (paid API). Batch tasks (daily sweep synthesis, weekly brief, wiki ingestion) burn API tokens for work that could use the Max subscription via CLI. |
| **Blast radius** | New infrastructure only — no existing code changes required for the VM itself. Future phases (3A-3H batch sources) depend on T2 being available. Workers need a dispatch mechanism (SSH or exec). |
| **Current behavior** | All LLM calls go through OpenAI API (T3) or Anthropic API (T3). No subscription-covered batch path exists. |
| **Expected behavior** | Workers can dispatch batch synthesis prompts to a VM running `claude --print`, getting LLM responses at zero marginal cost. |
| **Preserved assumptions** | Workers container is on Docker bridge network. VM must be reachable from Docker containers. No changes to existing Docker networking. |
| **Risk** | VM not reachable from Docker containers (network isolation). Claude Code auth expires. VM consumes too much RAM. |

**Key infrastructure findings:**
- **Unraid 7.2.3**, kernel 6.12.54, KVM VM manager plugin installed
- **Ubuntu 24.04 desktop ISO already on server** at `/mnt/user/isos/` (use server variant for minimal footprint — may need to download)
- **86GB RAM available** (39GB used by 48 containers) — 4GB VM allocation is trivial
- **Network interfaces:** `br0` (main bridge), `virbr0` (KVM default), Docker bridges, `tailscale1`
- **Existing VMs running** (`vnet0`, `vnet1`) — KVM works
- **User-specified config:** IP `192.168.10.53`, hostname `open-brain-vm`
- **Workers container** is on Docker bridge `open-brain_open-brain` — needs to reach `192.168.10.53` via host routing or macvlan

**Docker → VM connectivity path:**
Docker containers can reach the host's `br0` bridge IPs via the default gateway. A VM on `br0` with IP `192.168.10.53` should be reachable from containers as long as:
1. The VM is on `br0` (not `virbr0` which is NAT-isolated)
2. Docker's default bridge allows outbound to the LAN subnet
3. Workers container's Alpine image has `ssh` (or we use `curl` + a simple HTTP dispatch wrapper)

---

### Item 2: Phase 1A — Switch Worker Call Sites to `completeByTask()`

| Field | Finding |
|-------|---------|
| **Item** | Migrate all 12 production LLM call sites from legacy routing to task-based tier routing |
| **Root cause** | `completeByTask()` exists in the LLM gateway with full fallback chain support, but no production code calls it. All call sites use either `gateway.complete(prompt, alias)` (core-api) or `callClaude()` + litellm fallback (workers, voice-capture). The Jetson T1 tier config from Phase 0A is wired but unreachable because nothing uses the task dispatch path. |
| **Blast radius** | 12 files across 4 packages. All LLM-dependent features affected. |
| **Current behavior** | Every LLM call goes to either Anthropic API (Claude Sonnet) or OpenAI API, ignoring the three-tier routing entirely. |
| **Expected behavior** | Classification tasks route to Jetson (free, 0.67s). Complex synthesis routes to Anthropic. All calls go through `completeByTask()` with automatic fallback. Audit log records which tier served each request. |
| **Preserved assumptions** | `callClaude()` helper in shared package continues to exist (used by voice-pipecat Python code independently). Template-based prompts continue to work. BullMQ retry logic unchanged. |
| **Risk** | Breaking a call site during migration → pipeline stops processing. Skills stop generating output. Voice classification fails. |

**12 production call sites found:**

| # | File | Task Name | Current Method | Priority |
|---|------|-----------|---------------|----------|
| 1 | `core-api/routes/synthesize.ts:71` | `search_synthesis` | `gateway.complete('synthesis')` | HIGH (user-facing) |
| 2 | `core-api/services/governance-engine.ts:229` | `governance` | `gateway.complete('governance')` | HIGH (interactive) |
| 3 | `core-api/services/anti-vagueness.ts:113` | `confidence_gating` | `gateway.complete('fast')` | MEDIUM |
| 4 | `core-api/services/entity-resolution.ts:125` | `entity_linking` | `gateway.complete('fast')` | MEDIUM |
| 5 | `workers/jobs/extract-entities.ts:129` | `entity_extraction` | `callClaude()` + litellm fallback | MEDIUM (pipeline) |
| 6 | `workers/skills/weekly-brief.ts:101` | `weekly_brief` | `callClaude()` + litellm fallback | MEDIUM (scheduled) |
| 7 | `workers/skills/daily-sweep-skill.ts:382` | `daily_sweep` | `callClaude()` + litellm fallback | MEDIUM (scheduled) |
| 8 | `workers/skills/drift-monitor.ts:183` | `drift_monitoring` | `callClaude()` + litellm fallback | LOW (scheduled) |
| 9 | `workers/skills/daily-connections.ts:162` | `daily_connections` | `callClaude()` + litellm fallback | LOW (scheduled) |
| 10 | `workers/skills/memory-consolidation.ts:399` | `search_synthesis` | `callClaude()` + litellm fallback | LOW (scheduled) |
| 11 | `voice-capture/services/classification.ts:96` | `voice_classification` | `callClaude()` + litellm fallback | HIGH (real-time) |
| 12 | `voice-capture/services/classification.ts:103` | `voice_classification` | `client.chat.completions.create` (fallback) | HIGH (real-time) |

**Critical architectural issue:** Workers package does NOT have access to `LLMGatewayService`. The gateway lives in `core-api`. Workers create their own `anthropicClient` and `litellmClient` directly. Migrating workers to `completeByTask()` requires either:
- **Option A:** Workers create their own `LLMGatewayService` instance (needs db, configService, templateCache)
- **Option B:** Workers call core-api's `/api/v1/internal/llm` endpoint (new HTTP API)
- **Option C:** Extract gateway to `@open-brain/shared` so both packages can use it

Voice-capture has the same problem — it's a separate package with its own clients.

---

### Item 3: Phase 0D — Pipecat Voice Soak Test

| Field | Finding |
|-------|---------|
| **Item** | Validate Pipecat voice service over 2 weeks of daily use before promoting it and removing legacy voice services |
| **Root cause** | Pipecat was deployed (Entry 029) but not validated with real multi-turn conversations at production quality. Legacy voice-capture + faster-whisper (16GB RAM combined) still running as fallback. |
| **Blast radius** | Eventually removes 2 containers + 1 Docker volume, freeing ~9GB RAM. But premature promotion could break voice capture workflow from iOS. |
| **Current behavior** | voice-pipecat: healthy, port 8765 (WebSocket) + 8766 (health). Legacy voice-capture: healthy, port 3001 (HTTP). Both running in parallel. |
| **Expected behavior** | After soak: Pipecat handles all voice interactions reliably. Legacy services removed. |
| **Preserved assumptions** | iOS Shortcut still sends audio to port 3001 (voice-capture). Pipecat uses WebSocket on 8765. These are different protocols — Pipecat is for real-time conversation, voice-capture is for one-shot transcription. They may NOT be replacements for each other. |
| **Risk** | **Critical finding:** Pipecat (WebSocket, real-time conversation) and voice-capture (HTTP POST, one-shot transcription) serve different use cases. Removing voice-capture would break the iOS Shortcut workflow unless Pipecat also supports HTTP upload or the Shortcut is rewritten. |

**Pipecat details:**
- **Stack:** Python, pipecat-ai, Deepgram (STT), Anthropic Claude (LLM), Deepgram or Kokoro/Piper (TTS)
- **Requires:** `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY` in `.env.secrets`
- **Protocol:** WebSocket on port 8765 for streaming audio
- **Features:** Multi-turn conversation, VAD (Silero), session state in Redis, captures saved to core-api
- **DB table:** `voice_sessions` (id, session_id, started_at, ended_at, turns, captures_created, metadata)

**Legacy voice-capture details:**
- **Stack:** Node.js, Hono, faster-whisper (local STT), OpenAI/Anthropic (classification)
- **Protocol:** HTTP POST multipart on port 3001 — iOS Shortcut uploads audio file
- **Features:** One-shot transcription → classification → capture creation → Pushover notification
- **No conversation:** Single audio file in, capture out

**Key insight:** These are complementary, not redundant. The soak test should validate Pipecat for its conversational use case. Voice-capture removal should be evaluated separately based on whether Pipecat can also handle one-shot uploads.

---

## Phase 2 — Interaction Mapping

### 2a. Item-to-Item Interactions

```
0B (VM Setup) ←──────── no code dependency ────────→ 1A (Call Site Migration)
     │                                                      │
     │  VM enables T2 batch dispatch                        │  Migration enables T1 Jetson routing
     │  (future phases 3A-3H)                               │  (immediate cost savings)
     │                                                      │
     └──── both are prerequisites for ─────────────────────→ batch source pipelines
                                                            
0D (Pipecat Soak) ←── independent ──→ 0B and 1A
     │
     │  voice-capture call site (#11-12) is in 1A's scope
     │  but should NOT be migrated until soak validates
     │  whether voice-capture is being retired
     └── CONSTRAINT: do NOT migrate voice-capture/classification.ts
         until 0D determines voice-capture's future
```

### 2b. Change-to-System Interactions

**Phase 0B (VM):**
- Upstream: None (new infrastructure)
- Downstream: Workers need dispatch mechanism; all batch source phases depend on this
- Contracts: SSH key auth, `claude --print` CLI interface
- State: VM must auto-start with Unraid

**Phase 1A (Call Site Migration):**
- Upstream: `LLMGatewayService` in core-api, `ConfigService` loading `ai-routing.yaml`
- Downstream: All LLM-dependent features (pipeline, skills, governance, search, voice)
- Contracts: `completeByTask(prompt, taskName, options)` returns string; same as `complete()`
- Shared state: `ai_audit_log` table, `ai-routing.yaml` config
- **Critical dependency:** Workers package needs access to gateway. Currently has direct client instances only.

**Phase 0D (Pipecat Soak):**
- Upstream: Deepgram API, Anthropic API, Redis, core-api
- Downstream: Decision on voice-capture/faster-whisper retirement
- Contracts: WebSocket protocol, `voice_sessions` table, core-api capture endpoint
- State: Container healthy, env secrets configured

### 2c. Grouping — Change Sets

**Change Set A: Infrastructure (0B)**
- Create VM, install Claude Code, verify connectivity
- Independent of all code changes
- Blocking: future batch source phases

**Change Set B: Core-API Call Site Migration (1A-core)**
- Sites #1-4: `synthesize.ts`, `governance-engine.ts`, `anti-vagueness.ts`, `entity-resolution.ts`
- All use `gateway.complete()` → change to `gateway.completeByTask()`
- Simple, low-risk — gateway is already available in these files
- Can be done atomically

**Change Set C: Workers Call Site Migration (1A-workers)**
- Sites #5-10: `extract-entities.ts`, all 5 skill files
- Requires solving the "workers has no gateway" problem first
- Must decide: create gateway instance in workers, or HTTP dispatch, or move gateway to shared
- Higher risk — needs architectural decision

**Change Set D: Voice-Capture Call Site Migration (1A-voice)**
- Sites #11-12: `classification.ts`
- **DEFERRED** until Phase 0D determines voice-capture's future
- If voice-capture is being retired, no point migrating it

**Change Set E: Pipecat Soak (0D)**
- Manual testing over 2 weeks
- No code changes
- Produces go/no-go decision document

---

## Phase 3 — Solution Design

### Change Set A: Homeserver KVM VM (Phase 0B)

**Approach:** Create Ubuntu 24.04 Server VM via Unraid's VM Manager UI.

**VM Spec:**
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Name | `open-brain-vm` | User-specified |
| OS | Ubuntu 24.04 Server (minimal) | No GUI needed, small footprint |
| vCPUs | 2 | Claude CLI is I/O bound (API calls), not compute bound |
| RAM | 4 GB | Claude Code can use ~1GB; OS needs ~500MB; 2.5GB headroom |
| vDisk | 20 GB | OS ~4GB + Claude Code ~2GB + workspace + room |
| Network | br0 (bridged) | Must be reachable from Docker containers |
| IP | 192.168.10.53 (static) | User-specified |
| Hostname | open-brain-vm | User-specified |
| Boot | Auto-start with Unraid | Array start triggers VM start |

**Post-Install:**
1. Install Claude Code CLI: `npm install -g @anthropic-ai/claude-code` (or native binary)
2. Authenticate: `claude login` (one-time browser flow from Troy's laptop)
3. Set up SSH key: copy `id_claude_code.pub` to `~claude/.ssh/authorized_keys`
4. Install `openssh-server` (if not default)
5. Verify: `ssh claude@192.168.10.53 'claude --print "test"'` from homeserver

**Docker → VM Connectivity:**
- Docker containers on `open-brain_open-brain` bridge reach host via default gateway
- Host's `br0` bridge routes to VM at `192.168.10.53`
- Test: `docker exec open-brain-workers ping 192.168.10.53` (Alpine needs `apk add iputils` or use `wget`)
- If blocked: add `--add-host open-brain-vm:192.168.10.53` to workers in docker-compose.yml

**Dispatch Script (on VM):**
```bash
#!/bin/bash
# /home/claude/t2-synthesize.sh
# Usage: echo "prompt text" | ssh claude@192.168.10.53 bash t2-synthesize.sh
claude --print --model sonnet "$@" < /dev/stdin
```

**Workers side (future — not in this change set):**
Workers will eventually have a T2 BullMQ worker that SSHs to the VM. For now, the VM just needs to be running and reachable. Batch sources (Phase 3A+) will add the dispatch code.

**Rollback:** Delete VM from Unraid UI. No other changes to revert.

**Alternatives considered:**
- Bond (remote Ubuntu): More isolation but adds network latency and another machine to maintain
- Docker container: Claude Code auth is painful in headless Docker (no browser for OAuth)
- LXC: Not supported on Unraid 7.x
- Run on Unraid host: Clutters the minimal Slackware base OS

---

### Change Set B: Core-API Call Site Migration

**Approach:** Direct 1:1 replacement of `gateway.complete(prompt, alias)` with `gateway.completeByTask(prompt, taskName)`. The gateway object is already available in all 4 files.

**Changes:**

| File | Line | Before | After |
|------|------|--------|-------|
| `routes/synthesize.ts` | 71 | `llmGateway.complete(prompt, 'synthesis', {...})` | `llmGateway.completeByTask(prompt, 'search_synthesis', {...})` |
| `services/governance-engine.ts` | 229 | `this.llmGateway.complete(prompt, 'governance', {...})` | `this.llmGateway.completeByTask(prompt, 'governance', {...})` |
| `services/anti-vagueness.ts` | 113 | `this.llmGateway.complete(prompt, 'fast', {...})` | `this.llmGateway.completeByTask(prompt, 'confidence_gating', {...})` |
| `services/entity-resolution.ts` | 125 | `this.llmGateway.complete(prompt, 'fast', {...})` | `this.llmGateway.completeByTask(prompt, 'entity_linking', {...})` |

**Risk:** LOW. Same interface (`Promise<string>`), same gateway object. `completeByTask()` has a legacy fallback if tier routing is misconfigured. Tests mock the gateway, so mock calls need updating.

**Verification:**
- All core-api unit tests pass
- Manual test: search query triggers synthesis → audit log shows correct tier
- Manual test: governance session works → audit log shows `t2_quality`

---

### Change Set C: Workers Call Site Migration

**Approach:** Create a `LLMGatewayService` instance inside the workers `main.ts`, same as core-api does. Workers already have `db`, `configService`, and `litellmClient` — they just need to wire them into a gateway instance and pass it to skills/jobs.

**Architectural decision:** Option A (workers create their own gateway instance) is the right choice because:
- Workers already have all the dependencies (db, configService, anthropicClient, ollamaClient, litellmClient)
- The gateway is stateless (just dispatch logic + audit logging) — no shared state concerns
- Moving gateway to `@open-brain/shared` would require shared to depend on `drizzle` for audit logging — creates circular dependency risk
- HTTP dispatch (Option B) adds latency and failure modes for internal calls

**Changes:**

1. **`packages/workers/src/main.ts`** — create `LLMGatewayService` instance, pass to skill/job factories
2. **`packages/workers/src/jobs/extract-entities.ts`** — accept gateway param, replace `callClaude()`/litellm with `gateway.completeByTask('entity_extraction', ...)`
3. **`packages/workers/src/skills/weekly-brief.ts`** — same pattern, task: `weekly_brief`
4. **`packages/workers/src/skills/daily-sweep-skill.ts`** — task: `daily_sweep`
5. **`packages/workers/src/skills/drift-monitor.ts`** — task: `drift_monitoring`
6. **`packages/workers/src/skills/daily-connections.ts`** — task: `daily_connections`
7. **`packages/workers/src/skills/memory-consolidation.ts`** — task: `search_synthesis`

**Pattern for each skill migration:**
```typescript
// BEFORE (all skills follow this pattern):
if (anthropicClient) {
  const result = await callClaude(anthropicClient, prompt, { model: synthesisModel, maxTokens, temperature })
  raw = result.text
} else {
  const response = await litellmClient.chat.completions.create({...})
  raw = response.choices[0]?.message?.content ?? ''
}

// AFTER:
raw = await llmGateway.completeByTask(prompt, 'task_name', { temperature, maxTokens })
```

Each skill's constructor/factory needs to accept the gateway. Skill execution dispatcher in `skill-execution.ts` passes it through.

**Risk:** MEDIUM. Changing 7 files in the hot pipeline path. Mitigated by:
- Each skill can be migrated and tested independently
- `completeByTask()` has legacy fallback
- Existing tests verify skill behavior (mock the gateway)

**Verification:**
- All 826 workers unit tests pass
- Manual test: create a capture → extract-entities fires → audit log shows `entity_extraction` on `t1_fast`
- Manual test: trigger daily-sweep → audit log shows `daily_sweep` on `t1_fast`

---

### Change Set D: Voice-Capture Call Site Migration — DEFERRED

**Reason:** Phase 0D (Pipecat soak) must determine whether voice-capture is being retired. If it is, migrating its classification code is wasted work. If it isn't (because Pipecat serves a different use case — real-time conversation vs. one-shot upload), then voice-capture's classification should be migrated.

**Decision point:** After Phase 0D, if voice-capture stays → migrate classification.ts to use gateway. If voice-capture is retired → skip.

---

### Change Set E: Pipecat Voice Soak Test

**Approach:** Structured manual testing over 2 weeks with documented results.

**Prerequisites:**
- `DEEPGRAM_API_KEY` in `.env.secrets` (check if configured)
- `ANTHROPIC_API_KEY` in `.env.secrets` (confirmed configured per Entry 029)
- voice-pipecat container healthy (confirmed: up 23 hours, healthy)

**Test Plan:**

| Day | Test | What to Measure |
|-----|------|-----------------|
| 1-3 | Basic conversations (3/day) | Connection reliability, transcription accuracy, response quality |
| 4-7 | Topic diversity: personal, work, technical, brainstorming | Brain view classification, capture quality, entity extraction |
| 8-10 | Stress tests: long conversations (10+ turns), rapid back-to-back | Session stability, memory usage, Redis session state |
| 11-14 | Daily use as primary voice interface | Latency consistency, overall satisfaction, edge cases |

**Measurements per conversation:**
- Connection time (WebSocket handshake)
- First response latency (audio in → audio out)
- Transcription accuracy (spot-check against recording)
- Response quality (1-5 subjective rating)
- Capture created correctly (content, type, brain view)
- Any errors or disconnects

**Go/No-Go Criteria:**
- Connection success rate > 95%
- First response latency < 2s median
- Transcription accuracy > 90%
- No session crashes in final week
- Captures created correctly > 95% of the time

**Critical finding to validate:**
- Can Pipecat handle one-shot audio upload (HTTP POST) or is it WebSocket-only?
- If WebSocket-only, voice-capture must stay for iOS Shortcut workflow
- This determines whether Phase 1C (voice promotion) means "remove legacy" or "keep both"

**Rollback:** N/A — this is a read-only evaluation.

---

## Phase 4 — Summary Report

### Investigation Findings

| Item | Key Discovery |
|------|--------------|
| 0B (VM) | Ubuntu 24.04 ISO already on server. KVM works (existing VMs). 86GB RAM available. `br0` bridge enables Docker→VM connectivity. |
| 1A (Migration) | 12 call sites across 4 packages. Workers and voice-capture don't have gateway access — workers needs its own instance. Core-api migration is trivial (4 lines). |
| 0D (Pipecat) | **Pipecat (WebSocket conversation) and voice-capture (HTTP upload) are complementary, not redundant.** Soak validates Pipecat quality but may not lead to voice-capture removal. |

### Interaction Map

- **0B → 1A:** No direct dependency. 0B enables T2 batch dispatch (future). 1A enables T1 Jetson routing (immediate).
- **0B → 3A-3H:** 0B is blocking prerequisite for all batch source pipelines.
- **1A → cost savings:** Migration makes Jetson routing live, reducing API costs immediately.
- **0D → 1C:** Soak test result determines voice promotion scope.
- **1A sites #11-12 → 0D:** Voice-capture migration deferred pending soak outcome.

### Change Set Groupings

| Set | Items | Rationale | Risk |
|-----|-------|-----------|------|
| A (VM) | 0B | Independent infrastructure | LOW |
| B (Core-API) | 1A sites #1-4 | Same package, same pattern, gateway already available | LOW |
| C (Workers) | 1A sites #5-10 | Workers needs gateway instance; all skills follow same pattern | MEDIUM |
| D (Voice) | 1A sites #11-12 | Deferred pending 0D result | N/A |
| E (Soak) | 0D | Manual testing, no code | LOW |

### Risk Assessment

| Change Set | Risk | Mitigation | Rollback |
|------------|------|------------|----------|
| A (VM) | Docker→VM network blocked | Test connectivity before committing to dispatch code | Delete VM |
| B (Core-API) | Breaking synthesis or governance | Same interface, legacy fallback in gateway | Revert 4 lines |
| C (Workers) | Breaking pipeline or skills | Migrate one skill at a time, test each | Revert individual files |
| D (Voice) | Deferred | — | — |
| E (Soak) | Deepgram key not configured | Check before starting | N/A |

### Implementation Sequence

```
Parallel Track 1:          Parallel Track 2:          Parallel Track 3:
─────────────────          ─────────────────          ─────────────────
Set A: VM Setup            Set B: Core-API Migration  Set E: Pipecat Soak
  (operational)              (code, LOW risk)           (manual, 2 weeks)
       │                          │                          │
       │                    Set C: Workers Migration         │
       │                      (code, MEDIUM risk)            │
       │                          │                          │
       └──── All complete ────────┤                    Decision on
             enables future       │                    voice-capture
             batch sources   Set D: Voice Migration    (Set D)
                               (if voice-capture stays)
```

Sets A, B, and E can start in parallel. Set C depends on learning from Set B. Set D waits for Set E's outcome.

### Scope Boundaries

**In scope:**
- VM creation, Claude Code install, connectivity verification
- All 10 non-voice LLM call site migrations to `completeByTask()`
- Workers package gateway instance creation
- Pipecat soak test plan and execution
- Lab notebook entries for all work

**Out of scope:**
- T2 dispatch code in workers (future — when batch sources are built)
- Voice-capture classification migration (pending soak outcome)
- Actual batch source pipelines (Phases 3A-3H)
- Gateway extraction to shared package (not needed — workers create own instance)
- Docker image changes (no new containers)

**Recommended follow-up:**
- After 1A: Analyze `ai_audit_log` to measure cost savings from Jetson routing
- After 0D: Decide voice-capture fate → migrate or remove
- After 0B: Build T2 dispatch worker for first batch source (Phase 3A)
