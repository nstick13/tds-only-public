# Scheduling the sync jobs

Four routes keep the app's data current. Nothing calls them on its own — you
have to point a scheduler at them.

| Route | Cadence | Tank01 calls | What breaks without it |
| --- | --- | --- | --- |
| `/api/cron/sync-players` | every 6h | ~12/day | The player pool goes stale; injury status is wrong |
| `/api/cron/sync-schedule` | every 12h | ~4–6/day | No kickoff times, so nothing ever locks; no bye weeks |
| `/api/cron/sync-scores` | every 30m | ~48/day floor, ~300 on a full Sunday | Scores don't move during games |
| `/api/cron/apply-locks` | every 5m | 0 (pure DB) | Rosters stay editable after kickoff |

All four take a `GET` or `POST` with:

```
Authorization: Bearer $CRON_SECRET
```

With `CRON_SECRET` unset they refuse to run at all (503) rather than running
unauthenticated — they hold the service-role key, so an open endpoint would let
anyone burn the whole instance's Tank01 budget.

The budget arithmetic behind those cadences is in the header of
`src/app/api/cron/_lib/cron.ts`. It does **not** grow with the number of
leagues: stats are keyed by NFL week and every league's live stages are deduped
to distinct weeks before any fetch.

---

## Option A — Vercel Cron (needs a Pro plan)

Add to `vercel.json`:

```json
"crons": [
  { "path": "/api/cron/sync-players",  "schedule": "0 */6 * * *" },
  { "path": "/api/cron/sync-schedule", "schedule": "30 */12 * * *" },
  { "path": "/api/cron/sync-scores",   "schedule": "*/30 * * * *" },
  { "path": "/api/cron/apply-locks",   "schedule": "*/5 * * * *" }
]
```

Vercel sends the `Authorization: Bearer $CRON_SECRET` header automatically.

**This does not work on Hobby.** Hobby allows at most 2 cron jobs and rejects
any expression that runs more than once a day — and it fails the *deployment*,
it does not silently degrade. That is why `vercel.json` ships without a `crons`
block.

## Option B — GitHub Actions (free)

`.github/workflows/sync.yml` in this repo hits the four routes on a schedule
using repository secrets. To use it, set two secrets under
**Settings → Secrets and variables → Actions**:

- `APP_URL` — e.g. `https://tds-only-public.vercel.app`
- `CRON_SECRET` — the same value as the Vercel environment variable

Caveats worth knowing before you rely on this for a live draft:

- GitHub delays scheduled workflows under load, sometimes by 10–30 minutes.
  For `sync-scores` that is survivable. For `apply-locks` it means rosters can
  stay editable past kickoff, which is a competitive problem, not a cosmetic
  one.
- Scheduled workflows are disabled automatically after 60 days without repo
  activity.

## Option C — any external scheduler

cron-job.org, EasyCron, a box you already own, `launchd`. Anything that can
send an HTTP request with a bearer token works. This is the most reliable
free option if you have somewhere to run it.
