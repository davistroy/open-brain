# Apply Migration 0030 — briefs table

## Apply

```bash
psql $DATABASE_URL -f packages/shared/drizzle/0030_briefs.sql
```

## Verify

```sql
\dt briefs
\d briefs
```

Expected: table `briefs` with 17 columns, 5 indexes, 1 trigger (`set_briefs_updated_at`).

## Rollback

```sql
DROP TABLE briefs CASCADE;
```
