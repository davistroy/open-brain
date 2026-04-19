# Runbook: LLM Budget Alerts

**Alerts:** `BudgetAt80Percent` (warning), `BudgetHardCap` (critical)
**Metric:** `openbrain_budget_spent_usd` (gauge, refreshed from `ai_audit_log` per Prometheus scrape)
**Rule file:** `config/prometheus/alerts/budget.yml`

---

## Alert conditions

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `BudgetAt80Percent` | `>= $28` (80% of $35 hard cap) for 5 minutes | warning |
| `BudgetHardCap` | `>= $35` for 1 minute | critical |

---

## Diagnosis

### 1. Check current month spend by model

```sql
-- On homeserver: docker compose exec postgres psql -U openbrain -d openbrain
SELECT
  model,
  COUNT(*) AS calls,
  ROUND(SUM(cost_usd)::numeric, 4) AS total_usd
FROM ai_audit_log
WHERE created_at >= date_trunc('month', now())
GROUP BY model
ORDER BY total_usd DESC;
```

### 2. Check Prometheus gauge value

```bash
curl -s "http://localhost:9090/api/v1/query?query=openbrain_budget_spent_usd"
```

### 3. Check for runaway bulk operations

```sql
-- High-cost calls in the last 24h
SELECT
  created_at,
  model,
  input_tokens,
  output_tokens,
  cost_usd,
  LEFT(prompt_hash, 16) AS prompt
FROM ai_audit_log
WHERE created_at >= now() - interval '24 hours'
  AND cost_usd > 0.05
ORDER BY cost_usd DESC
LIMIT 20;
```

---

## Mitigation

### Immediate (warning level)

1. **Verify routing is correct.** Open `config/ai-routing.yaml` and confirm:
   - Routine tasks (entity extraction, classification) route to `t1_spark` (Qwen 35B, free) or `t1_jetson` (free)
   - Only governance, weekly brief, and synthesis route to OpenAI

2. **Check for overnight batch operations** — file ingestion, wiki synthesis, or email pipeline hitting paid tiers.
   Per CLAUDE.md: paid tiers should only run for real-time requests (user actively waiting).

### Immediate (critical level)

3. **The circuit breaker may have already fired.** Check `budget-check` skill output:
   ```bash
   # On homeserver
   docker compose exec postgres psql -U openbrain -d openbrain \
     -c "SELECT output_summary, created_at FROM skills_log WHERE skill_name='budget-check' ORDER BY created_at DESC LIMIT 5;"
   ```

4. **If budget is legitimately exceeded,** wait for monthly reset (1st of next month). No manual reset is available — the circuit breaker is time-based.

5. **If budget was hit by accident** (runaway batch operation), stop the operation, check `ai_audit_log` for the responsible model, and correct the routing in `ai-routing.yaml`.

---

## Prevention

- All batch/async operations MUST use T0 (Python), T1 (local LLM), or T2 (Claude CLI) per CLAUDE.md cost-tiered processing rules.
- T3 (OpenAI API) is for real-time requests only (user actively waiting: MCP, Slack, voice, governance).
- Run `scripts/benchmark-search.mjs` before deploying new bulk pipelines to estimate cost.

---

## Related

- `docs/runbooks/pipeline-alert.md` — if high spend correlates with stuck queue
- `config/ai-routing.yaml` — routing decisions
- `packages/workers/src/skills/budget-check.ts` — application-level budget enforcement
