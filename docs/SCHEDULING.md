# Scheduling the sync jobs

Four routes keep the app's data current. Nothing calls them on its own — a
scheduler has to.

| Route | Cadence | Tank01 calls | What breaks without it |
| --- | --- | --- | --- |
| `/api/cron/sync-players` | every 6h | ~12/day | Player pool goes stale; injury status wrong |
| `/api/cron/sync-schedule` | every 12h | ~4–6/day | No kickoff times, so nothing ever locks; no bye weeks |
| `/api/cron/sync-scores` | every 30m | ~48/day floor, ~300 on a full Sunday | Scores don't move during games |
| `/api/cron/apply-locks` | every 5m | 0 (pure DB) | Rosters stay editable after kickoff |

All four accept `GET` or `POST` with:

```
Authorization: Bearer $CRON_SECRET
```

With `CRON_SECRET` unset they refuse to run at all (503) rather than running
unauthenticated — they hold the service-role key, so an open endpoint would let
anyone burn the whole instance's Tank01 budget.

The budget arithmetic behind those cadences lives in the header of
`src/app/api/cron/_lib/cron.ts`. It does **not** grow with the number of
leagues: stats are keyed by NFL week, and every league's live stages are
deduped to distinct weeks before any fetch. The fiftieth league costs nothing.

---

## What this instance uses: Supabase `pg_cron`

Run [`supabase/migrations/0008_cron.sql`](../supabase/migrations/0008_cron.sql)
after deploying, with two lines edited (your app's URL and your `CRON_SECRET`).
It schedules all four routes with `pg_cron` + `pg_net`.

This is the recommended option:

- `pg_cron` is on Supabase's **free tier** and fires on time.
- No third service to own or monitor.
- The database is already a hard dependency, so it adds no new failure mode.

Two things to know:

- **The token is stored in the job's command text.** Never
  `select command from cron.job` in the SQL editor — it would print the token
  into the results pane. The verification queries at the bottom of `0008` are
  written to avoid it.
- **Free-tier Supabase projects pause after ~7 days with no requests**, and a
  paused project runs no cron. In-season traffic keeps it awake; over the
  offseason it will pause, which is fine — just expect to un-pause it before
  Week 1.

Check what actually happened — one row per run, written by the routes
themselves:

```sql
select source, status, ran_at, message
  from public.sync_log order by ran_at desc limit 20;
```

## Alternative: Vercel Cron (Pro plan only)

Put a `crons` block in `vercel.json` — the exact block is kept in the header of
`src/app/api/cron/_lib/cron.ts`. Vercel sends the `Authorization` header
automatically.

**This does not work on Hobby.** Hobby allows at most 2 cron jobs and rejects
any expression running more than once a day — and it fails the *deployment*, so
you find out by not being able to ship. That is why `vercel.json` has no
`crons` block.

## Alternative: anything else that can make an HTTP request

cron-job.org, a box you own, `launchd`, a GitHub Actions workflow. The contract
is just the bearer token. If you use GitHub Actions, know that it delays
scheduled runs by 10–30 minutes under load and disables them after 60 days of
repo inactivity — survivable for `sync-scores`, a real problem for
`apply-locks`, which is what stops people editing rosters after kickoff.
