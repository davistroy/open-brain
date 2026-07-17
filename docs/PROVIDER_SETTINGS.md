# Open Brain — Data Classification & Provider Settings

**Applies to:** All running services (v1.6+)  
**Last reviewed:** 2026-06-30  
**Review cadence:** Quarterly (see §4)  
**Related:** `config/ai-routing.yaml`, `deploy/.env.secrets.template`, `docs/SECURITY.md`

---

## 1. Third-Party Provider Inventory

| Provider | Purpose | Data sent | Tier / cost | Secret — BWS item → env var | Privacy posture |
|----------|---------|-----------|-------------|----------------------------|-----------------|
| **OpenAI** (`api.openai.com/v1`) | Embeddings (`text-embedding-3-large`, 768-dim MRL) + inference (gpt-5.4 for classification, synthesis, search, TTS) | Capture `content` for embedding; prompt + context for inference; TTS brief text | Paid. Embedding: $0.00013/1K tokens. Inference: $0/1K (gpt-5.4 current pricing — verify). TTS: $0.015/1K chars | `open-brain-openai-api-key` → `OPENAI_API_KEY` | Consumer API. Data processed per [OpenAI API Terms](https://openai.com/policies/api-data-usage-policies). No training on API data by default (verify with current Enterprise vs. standard terms). Zero-retention option available under enterprise tier — not currently contracted. |
| **Anthropic** (`api.anthropic.com`) | Agent skills (wiki-ingest, wiki-lint via Haiku); quality synthesis (governance, weekly-brief, email-compose, monthly-reflection via Sonnet) | Prompt + context for each skill invocation; no raw capture bulk. Lab/insurance synthesis routes via `claude --print` (CLI, not this API key) | Paid. Haiku: $0.0008/$0.004 per 1K in/out. Sonnet: $0.003/$0.015 per 1K in/out | `OPENCLAW_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY` (shared with OpenClaw; BWS in `ai-work` project) | Consumer API. Same data-use concerns as OpenAI. Used only for `runAgent()` + tool-use (Anthropic SDK protocol; cannot route to local tiers). |
| **Deepgram** (`api.deepgram.com`) | Speech-to-text — **no longer used by open-brain.** The only consumer, the offline `scripts/deepgram-spike.py` benchmark, was **removed 2026-07-17 (Entry 240)** along with `scripts/requirements-deepgram.txt`; production transcription is self-hosted faster-whisper and the `voice-pipecat` consumer was removed (#298/D143). | None (no code path sends audio to Deepgram) | Paid — but open-brain issues zero calls | `OPENCLAW_DEEPGRAM_API_KEY` → `DEEPGRAM_API_KEY` (**shared with OpenClaw — do NOT revoke**; OpenClaw may still use it) | No open-brain audio path reaches Deepgram. The key is retained only because it is shared with the OpenClaw project. |
| **Cloudflare** | (a) Tunnel: public HTTPS ingress for `brain.troy-davis.com` via `cloudflared`. (b) Email Worker: inbound email (`brain@troy-davis.com`) relayed to core-api | Tunnel: all HTTP request/response metadata (headers, URLs) transits Cloudflare edge. Email Worker: full inbound email bodies (To/From/Subject/body) pass through CF Workers runtime before POST to core-api | Free tier for tunnel + Email Workers at this scale | `open-brain-cloudflare-tunnel-token` → `CLOUDFLARE_TUNNEL_TOKEN` | Email plaintext (including attachments as text) passes through Cloudflare Workers execution environment before relay. CF processes under its [Privacy Policy](https://www.cloudflare.com/privacypolicy/). No persistent CF storage of email body beyond execution window. |
| **Pushover** (`api.pushover.net`) | Push notifications to iOS/device: skill completions, pipeline-health alerts, budget warnings, secret-staleness alerts | Notification title + message string (not full capture content). Example: "Weekly brief ready" or "2 stale secrets" | Free tier; 10,000 messages/month included | `open-brain-pushover-app-token` → `PUSHOVER_APP_TOKEN`; `open-brain-pushover-user-key` → `PUSHOVER_USER_KEY` | Short message text only; no raw capture content. Pushover stores messages briefly for delivery; see [Pushover Privacy](https://pushover.net/privacy). |
| **Bitwarden Secrets Manager** (`vault.bitwarden.com`) | Secret storage and retrieval only. `bws` CLI pulls secrets at deploy/rotation time; `secret-rotation` skill audits key ages monthly | Secret key names + metadata (creation/revision dates). Secret values read locally by `bws` CLI and written to `.env.secrets` on disk; never sent to application containers directly | Free tier (single project) | `BWS_ACCESS_TOKEN` — not stored in BWS itself; set manually on homeserver | Bitwarden is the source of truth for all API keys and passwords. Values stored encrypted at rest and in transit. No application data or capture content ever reaches Bitwarden. |
| **SMTP relay** (Himalaya, configurable) | Outbound email drafts (email-compose skill → approve-and-send flow) | Email draft: To/Subject/body text (LLM-generated, user-approved) | Depends on configured provider (e.g., Google Workspace SMTP) | `open-brain-smtp-credentials` → `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email body exits the system to the external recipient and transits the configured SMTP relay. Treat as external data egress. |

### Free / local tiers (no external data flow)

| Tier | Host | Model | Purpose | Data leaves LAN? |
|------|------|-------|---------|-----------------|
| `t0_local` (Ollama) | `http://ollama:11434` — same Docker network | qwen3.5:2b | Trivial classification, routing decisions | No |
| `t1_jetson` | `http://192.168.10.58:8080/v1` — Tailscale/LAN | qwen3.5-4b | Fast classification (intent, capture type, brain view, voice, confidence, question detection, email) | No — Tailscale encrypted, LAN-only |
| `t1_spark` | `http://spark.k4jda.net:8000/v1` — Tailscale | Qwen3.6-35B-A3B (`spark-llm`) | Entity extraction, synthesis, wiki, daily ops | No — Tailscale encrypted, LAN-only |
| Claude CLI (`claude --print`) | `open-brain-vm` or local | Claude Max subscription | T2 batch synthesis: lab-report-synthesis.py, insurance-gap-analysis.py | Indirectly — `claude --print` invokes Claude API under the Max subscription. Prompt text (structured health/financial summary) is sent to Anthropic's API but billed at $0 marginal cost under the Max subscription. |

---

## 2. Data-Classification Matrix

### Classification levels

| Class | Description | Examples in this system |
|-------|-------------|------------------------|
| **Public** | No privacy sensitivity | Technical observations, project notes, architecture decisions |
| **Internal** | Personal but not sensitive | Daily work notes, ideas, Slack messages, task captures |
| **Personal** | PII or personal life details | Location data in voice captures, personal reflections, financial summaries |
| **Health** | Medical/health information | Lab results, lab trend summaries |
| **Financial** | Financial records / insurance | Insurance policy details, budget summaries, transaction records |

### Per-table data classification and provider flow

| Table | Class | Stored | Has embedding? | Providers that see content | Notes |
|-------|-------|--------|---------------|---------------------------|-------|
| `captures` | Internal–Personal (mixed) | Postgres | Yes — `embedding vector(768)` (pipeline stage `embed`) | OpenAI (embedding + inference during synthesis/classification) | All capture content flows to OpenAI for embedding. Inference context includes capture content snippets for search synthesis, governance, weekly-brief, entity extraction. |
| `lab_results` | **Health** | Postgres only | **No** — no `embedding` column; no pipeline stage targets this table | None directly | Populated by `scripts/lab-report-extract.py` (T0 Python/pdfplumber, no LLM). The structured rows never reach OpenAI or Anthropic directly. |
| `lab_results` synthesis capture | **Health** | `captures` table (source: `api`) | Yes — enters normal embedding pipeline | OpenAI (embedding); Anthropic/Spark (via `claude --print` T2 during synthesis) | `lab-report-synthesis.py` queries `lab_results`, builds a structured prompt, calls `claude --print` (Max subscription), and POSTs the narrative output as a capture. That capture is then embedded by EmbeddingService → OpenAI. **This is the primary external exposure of health data.** |
| `insurance_policies` | **Financial** | Postgres only | **No** — no embedding column; no pipeline stage targets this table | None directly | Populated by `scripts/insurance-policy-extract.py` (T0 Python, pdfplumber+regex, direct psycopg2). `raw_text` field holds full extracted PDF text but it stays in Postgres. |
| `insurance_policies` gap-analysis capture | **Financial** | `captures` table (source: `api`) | Yes — enters normal embedding pipeline | OpenAI (embedding); Claude CLI T2 (`claude --print`) | `insurance-gap-analysis.py` fetches policies via `GET /api/v1/insurance-policies`, applies T0 heuristics, calls `claude --print`, POSTs the gap-analysis narrative as a capture → embedded via OpenAI. **This is the primary external exposure of financial/insurance data.** |
| `briefs` | Internal | Postgres | No | OpenAI TTS (`tts-1`) when `/api/v1/briefs/:id/audio` is called — brief `content` sent for narration | Brief content is a synthesized summary of recent captures; may include health/financial context if those captures are top-ranked. |
| `entities` / `entity_links` | Internal | Postgres | Yes (`embedding` on `entities`) | OpenAI (embedding during entity extraction pipeline) | Entity names/descriptions extracted from captures. |
| `email_classifications` | Personal | Postgres | No | OpenAI inference (classification task routes to `t1_jetson` → Spark or OpenAI) | Subject lines and email category assignments. |
| `voice_sessions` | Personal | Postgres | No | **STALE — writer removed (#298/D143, 2026-07-16):** the `voice-pipecat` service that wrote this table was removed; no data flows here | (Historical) Audio transcription data formerly flowed to Deepgram during a voice-pipecat session. |
| `admin_audit` | Internal | Postgres | No | None | Audit trail; excluded from reset-data TRUNCATE. |

### Risk-acceptance statements

**Health data (lab_results synthesis captures) at OpenAI:**  
Structured health summaries (lab trend narratives) are posted as captures and embedded via OpenAI's API. This is a documented risk-acceptance for a single-user, self-hosted system. The operator (Troy Davis) is both the data subject and the system owner. OpenAI's standard API terms do not train on API input data. No clinical decision support is performed. The `lab_results` table itself (per-test rows with numeric values) is never sent to OpenAI — only the synthesized narrative. Mitigations: (1) use `--dry-run` / `--no-synthesis` flags on lab-report-synthesis.py to review before posting; (2) upgrade to OpenAI Enterprise zero-retention agreement if sensitivity concern escalates.

**Financial/insurance data (insurance_policies gap-analysis captures) at OpenAI:**  
Same posture as health data above. Policy summaries (not full raw_text) enter the synthesis prompt. The `insurance_policies.raw_text` field (full PDF text) stays in Postgres and is never directly embedded or sent to any external provider. The gap-analysis narrative is a structural summary (gap class, limit vs. exposure, recommendation) — not a verbatim policy dump.

**Email via Cloudflare:**  
All inbound email to `brain@troy-davis.com` transits Cloudflare Workers execution before relay to core-api. Email body plaintext is visible to the CF Workers runtime. This is a known architectural trade-off for the email ingest pipeline; Cloudflare does not persistently store email body beyond the execution window under its standard terms.

---

## 3. Secret Inventory Cross-Reference

Full canonical list is in `deploy/.env.secrets.template` and `scripts/lib/secrets-map.sh`. Below is the provider-to-secret mapping for quarterly audit.

| Provider | BWS item name | Env var | Notes |
|----------|--------------|---------|-------|
| OpenAI | `open-brain-openai-api-key` | `OPENAI_API_KEY` | Used by core-api, workers, slack-bot, voice-capture |
| Anthropic | `OPENCLAW_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Shared with OpenClaw project; used by agent skills |
| Deepgram | `OPENCLAW_DEEPGRAM_API_KEY` | `DEEPGRAM_API_KEY` | Shared with OpenClaw. **No longer used by open-brain** — the `deepgram-spike.py` consumer was removed 2026-07-17 (Entry 240). Retained for OpenClaw; do not revoke. |
| Cloudflare Tunnel | `open-brain-cloudflare-tunnel-token` | `CLOUDFLARE_TUNNEL_TOKEN` | Invalidate via CF dashboard if compromised |
| Pushover App | `open-brain-pushover-app-token` | `PUSHOVER_APP_TOKEN` | |
| Pushover User | `open-brain-pushover-user-key` | `PUSHOVER_USER_KEY` | |
| SMTP | `open-brain-smtp-credentials` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outbound email; rotate if SMTP provider credentials change |
| Gitea | `dev/open-brain/gitea-token` | `GITEA_TOKEN` | Self-hosted Gitea at `gitea.tale-mamba.ts.net` (LAN); lower risk |
| MCP API | `open-brain-mcp-api-key` | `MCP_API_KEY` | Bearer token for MCP endpoint and OpenClaw |
| Admin API | `open-brain-admin-api-key` | `ADMIN_API_KEY` | Admin endpoint auth |
| Mobile API | `dev/open-brain/mobile-api-key` | `MOBILE_API_KEY` | Operator-deferred until mobile testing |
| Voice capture | `dev/open-brain/voice-capture-secret` | `VOICE_CAPTURE_SECRET` | Operator-deferred until iOS Shortcut rollout |
| Postgres | `open-brain-postgres-password` | `POSTGRES_PASSWORD` | |
| Redis | `open-brain-redis-password` | `REDIS_PASSWORD` | 64-hex; requirepass enforced (SEC-08) |
| Grafana | `open-brain-grafana-admin-password` | `GRAFANA_ADMIN_PASSWORD` | Change from default on first login |
| rclone crypt | `open-brain-rclone-crypt-password` / `open-brain-rclone-crypt-salt` | rclone.conf (obscured) | Offsite backup encryption. Loss = undecryptable offsite data. |

The `secret-rotation` skill runs on the 1st of each month at 10:00 AM (`cron: 0 10 1 * *`). It calls `bws secret list`, checks `revisionDate` against a 90-day staleness threshold, and fires a Pushover alert if any secret is stale.

---

## 4. Quarterly Review Checklist

Perform this review every 90 days (aligns with the `secret-rotation` 90-day staleness threshold). No tooling is required beyond `bws` CLI and a browser.

### 4.1 Vendor list audit

- [ ] Confirm no new external HTTP calls added since last review (grep `fetch\|axios\|OpenAI\|Anthropic\|deepgram` in `packages/` for new callsites)
- [ ] Confirm `docker-compose.yml` services list matches §1 provider table — no new third-party image added without review
- [ ] Review `config/ai-routing.yaml` for any new `provider: anthropic` or `provider: openai` tier added

### 4.2 Data-flow verification

- [ ] Confirm `lab_results` table still has no `embedding` column (query: `\d lab_results` in psql — absence of `vector` type is the check)
- [ ] Confirm `insurance_policies` table still has no `embedding` column (same check)
- [ ] Confirm any new table added since last review is represented in the classification matrix above
- [ ] Verify that the synthesis scripts (`lab-report-synthesis.py`, `insurance-gap-analysis.py`) still route to `claude --print` (T2 CLI) not a direct API call

### 4.3 Secret rotation and access

- [ ] Run `bash scripts/verify-secrets.sh` — confirm all secrets present and hash matches
- [ ] Run `bws secret list` — confirm no secret `revisionDate` older than 90 days
- [ ] Review OpenAI usage dashboard for anomalous spend
- [ ] Review Anthropic console for anomalous spend (API key is shared; cross-check against `ai_audit_log`)
- [ ] Review Deepgram dashboard for usage against <$5/month target
- [ ] Rotate any secret that is stale or that has been exposed (see 3-step lockstep in `CLAUDE.md`)

### 4.4 Policy / terms review

- [ ] Check OpenAI API data-use policy for any changes since last review (training opt-out, retention)
- [ ] Check Anthropic API data-use policy for any changes
- [ ] Confirm Cloudflare Email Worker data-handling terms unchanged

### 4.5 Update this document

- [ ] Add any new provider rows to §1
- [ ] Update §2 matrix if new tables with sensitive data were added
- [ ] Update the "Last reviewed" date at the top of this file
