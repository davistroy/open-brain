# Runbook: Outbound Dependency Failing

**Alerts:** `OutboundProviderFailing` (warning), `OutboundProviderTotallyFailing` (critical)
**Metric:** `openbrain_outbound_requests_total{provider, operation, status_class}`
**Rule file:** `config/prometheus/alerts/outbound.yml`
**Recorded by:** `timeOutboundCall()` at 4 sites — `llm-gateway.ts` (openai-compatible `chat`, anthropic `chat`) and `embedding.ts` (`embedding`, `embedding_batch`)
**Delivery:** Alertmanager → **Pushover** (critical = priority 1/repeat 1h, warning = priority 0/repeat 4h). These rules **do page**.
**Deployed from:** `/mnt/user/appdata/observability/config/prometheus/alerts/` — **NOT** from this repo (see Gaps).

---

## Alert conditions

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `OutboundProviderFailing` | >50% of calls to a `{provider, operation}` failing, sustained 30m | warning |
| `OutboundProviderTotallyFailing` | 100% failing (zero successes) with real traffic, sustained 15m | critical |

**Why this exists (#289):** the Jetson T1 tier returned `401 Invalid API Key` on **100% of calls for two weeks** (#283) and nothing surfaced it. Every other safeguard behaved *correctly* and none could see it:

- **The tier fallback deliberately does not fire on 401.** `shouldAttemptFallback` matches only transient errors (`429|5xx|timeout|ECONNREFUSED`). An auth error is a permanent misconfiguration, so failing fast is right — it is exactly what stopped 461 calls silently escalating to paid Claude (the 2026-04-15 $100 incident shape). Correct, but silent.
- **Budget alerts never fired**, because a **free** tier failing costs **$0**.
- **`ai_audit_log` recorded all 461 errors** — but nothing reads it for alerting.

**A totally-failing free tier is indistinguishable from an idle one.** This rule is the missing watcher.

**Why a ratio, not a count:** it fires on sustained *total* failure regardless of call volume, and an idle tier yields `0/0` (no series) instead of a false alarm. A raw count would page on a burst of retries yet stay quiet on a low-volume tier that is 100% broken — backwards for this failure mode.

---

## Triage

1. **Identify the provider/operation** from the alert labels. `provider=openai_compat` means a local tier (Jetson `t1_jetson` or Spark `t1_spark`); `openai`/`anthropic` are paid.

2. **Get the actual error text** — the metric only carries a `status_class`. The detail is in the DB:
   ```sql
   SELECT model, task_type, left(error, 80) AS err, COUNT(*), MAX(created_at)
   FROM ai_audit_log
   WHERE error IS NOT NULL AND created_at > now() - interval '1 hour'
   GROUP BY 1,2,3 ORDER BY 4 DESC;
   ```

3. **If `4xx` on a local tier — suspect auth first.** This is the #283 signature.
   > ⚠️ **`GET /v1/models` still answers `200` unauthenticated while `/chat/completions` 401s.** A "the endpoint is up" probe proves nothing. Test a real completion:
   ```bash
   # 401 without the key, 200 with it → the key is the problem, not the endpoint
   docker exec open-brain-workers node -e '
     fetch("http://192.168.10.58:8080/v1/chat/completions", {
       method: "POST",
       headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.JETSON_API_KEY },
       body: JSON.stringify({ model: "qwen3.5-4b", messages: [{role:"user",content:"say ok"}], max_completion_tokens: 8 }),
     }).then(async r => console.log(r.status, (await r.text()).slice(0,80)))'
   ```
   Then verify the wiring, which has three links — check each, do not assume:
   ```bash
   # 1. does the container SEE api_key_env? (config/ is BIND-MOUNTED — the image is not enough)
   docker exec open-brain-workers grep -c api_key_env /app/config/ai-routing.yaml
   # 2. is the env var actually set in the process?
   docker exec open-brain-workers sh -c 'test -n "$JETSON_API_KEY" && echo SET || echo MISSING'
   # 3. (above) does a real completion succeed with it?
   ```
   **Use `grep -c`, not `grep -A N`** — a too-small window has twice produced a wrong answer here (Entries 205/206).

4. **If `5xx`/`error` on a local tier — it is an outage, not a misconfiguration.** The fallback chain (`t1_jetson → t1_spark → t1_fast → t2_quality`) *does* fire on these, so work should still be completing via Spark. Confirm the box is up; expect `t1_fast` (paid Haiku) to start costing money if Spark is down too — watch `openbrain_budget_spent_usd`.

5. **If `4xx` on `openai`/`anthropic`** — expired/revoked key or quota. Check the provider dashboard; `429` should be self-healing via fallback.

---

## Fixing

- **Stale/missing tier key:** the value lives in Bitwarden (`dev/jetson/llm-api-key` → `JETSON_API_KEY`). Add it to `.env.secrets` (back it up first; **Unraid has no python3** — use bash/jq), then `docker compose up -d --force-recreate --no-deps workers core-api`.
- **Config change:** `config/ai-routing.yaml` is **bind-mounted into 5 services**, so a new image is *not* enough — update the host copy with `git checkout origin/main -- config/ai-routing.yaml` **as root** (as `claude` the fetch fails locking root-owned refs and silently leaves the OLD file in place).
- After the fix, confirm recovery in the data, not by eye:
  ```sql
  SELECT model, COUNT(*) FILTER (WHERE error IS NOT NULL) AS errors, COUNT(*) AS calls
  FROM ai_audit_log WHERE created_at > now() - interval '30 minutes' GROUP BY 1;
  ```
  `errors = 0` is the DoD.

---

## Gaps (known)

- **This repo is not the deployment source (#292).** The running Prometheus reads
  `/mnt/user/appdata/observability/config/prometheus/alerts/` — the standalone
  observability project's own, non-git-managed directory (ADR-0004). A rule added
  to `config/prometheus/alerts/` here does **nothing** until it is copied there and
  Prometheus is reloaded (`wget --post-data='' http://127.0.0.1:9090/-/reload`).
  These two rules were installed there manually on 2026-07-15 and are confirmed
  loaded via `/api/v1/rules`.
- **Workers' outbound metrics piggyback** on `container-health` (15m) / `pipeline-health` (6h) pushes — they are not exported on their own schedule. If both skills stop running, this metric goes stale silently; `workers-staleness.yml` is the backstop for that.
- **The metric is in-process.** A workers restart resets the histogram, so a short post-restart window can under-report.
