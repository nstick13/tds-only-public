# TD's Only

A fantasy football league where **only touchdowns count** and **you redraft
your entire roster every single week**.

No season-long teams. No waiver wire. No trades. Every week — and every
playoff round — all eight managers wipe their rosters and draft again from
scratch, live, watching each other pick in real time. A player can only be on
one roster per week, so the pool empties fast and last place drafts first.

**Scoring** — passing TD `0.5`, rushing TD `1.0`, receiving TD `1.0`.
Yards are worth nothing. A quarterback who throws for 400 yards and no
touchdowns scores zero.

**Roster** — 2 QB, 2 RB, 2 WR, 1 TE. Seven picks, seven rounds, snake order.

**The draft order is the whole game.** Round 1 runs worst-to-first from last
week's standings, so a terrible week is rewarded with the first pick at the
best remaining player. Then it snakes — meaning last week's winner picks 8th
and 9th back to back, and spends the whole draft watching the good ones go.

---

## Run your own league

This is a hosted app: one instance runs many independent leagues. Sign in
with Google, create a league, and share the invite link with seven friends.
The first eight people to accept fill the seats.

Whoever creates the league is its commissioner: they open the season, manage
seats, fix rosters after a bad sync, and finalize each week — which
automatically computes standings and opens the next week's draft with the
order seeded from those standings.

Nothing below this line is needed to play. It is for running your own copy.

---

## Running your own instance

You need three accounts, all of which have a usable free tier except Tank01:
**Supabase** (database, auth, and the cron that drives the sync jobs),
**Vercel** (hosting), and **RapidAPI** for the Tank01 NFL stats feed.

### 1. Supabase

Create a project, then open the **SQL Editor** and run the files in
`supabase/migrations/` **in numeric order**, each as one paste-and-run:

```
0001_identity.sql
0002_global_nfl.sql
0003_leagues.sql
0004_league_tables.sql
0005_functions.sql
0006_rls.sql
0007_realtime.sql
```

Then, once the app is deployed and you know its URL, run
`0008_cron.sql` — it schedules the sync jobs and needs two lines edited
first. See [`docs/SCHEDULING.md`](docs/SCHEDULING.md).

Order matters — each depends on the ones before it, and `0006` in particular
calls authorization helpers defined in `0005`. Every file is safe to re-run.

`supabase/tests/rls_smoke.sql` exercises the whole authorization model
against a live database and cleans up after itself. Running it once after
setup is a good way to confirm you pasted everything.

### 2. Sign in with Google

Auth is Google OAuth only — no passwords, no email confirmation step.

1. Supabase → **Authentication → Providers → Google**, toggle on. Copy the
   **Callback URL** it shows you.
2. [Google Cloud Console](https://console.cloud.google.com/) → **APIs &
   Services → Credentials → Create Credentials → OAuth client ID → Web
   application**. Paste the Supabase callback URL under **Authorized redirect
   URIs**. Save, copy the **Client ID** and **Client secret**.
3. Paste those two values back into the Supabase Google provider form.
4. Supabase → **Authentication → URL Configuration**:
   - **Site URL**: your deployed app, e.g. `https://your-app.vercel.app`
   - **Redirect URLs**: add **wildcard** entries, not bare paths:
     ```
     https://your-app.vercel.app/**
     http://localhost:3000/**
     ```

That last step is what stops sign-in from bouncing people to `localhost`.
Supabase only honours redirect targets on this list.

**Use the wildcards.** The app does not send a bare
`/auth/callback` — an invite link has to survive the OAuth round trip, so it
signs in with `/auth/callback?next=/join/<code>`. A Redirect URL entry without
a wildcard may not match a URL carrying a query string, and the failure is
nasty to diagnose: ordinary sign-in works fine, and *only* invite links break,
which is the one flow you cannot test without a second person.

### 3. Tank01 (stats)

Subscribe to **Tank01 NFL Live In-Game Real Time Statistics** on RapidAPI and
copy your key. The sync cadences are sized against the Pro plan's
1,000 calls/day.

One key serves the entire instance. Stats are fetched **per NFL week, not per
league**, so the fiftieth league costs exactly as many API calls as the first.

### 4. Vercel

Import the repo, then set these environment variables (see `.env.example` for
the full annotated list) for **every** environment you deploy:

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → Data API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Safe to expose — RLS protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret.** Bypasses RLS across every league |
| `RAPIDAPI_KEY` | Tank01 |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Optional — Web Push |
| `VAPID_PRIVATE_KEY` | Optional — Web Push |
| `VAPID_SUBJECT` | Optional — e.g. `mailto:you@example.com` |

`NEXT_PUBLIC_*` values are compiled into the build, so **editing them in
Vercel does nothing until you redeploy.**

> **Scheduling is separate.** Vercel Cron needs a Pro plan (Hobby rejects any
> schedule running more than once a day, and fails the deployment). This repo
> schedules the sync jobs from Postgres instead — run
> `supabase/migrations/0008_cron.sql` once your app is deployed. See
> [`docs/SCHEDULING.md`](docs/SCHEDULING.md).

### 5. Web Push (optional)

```bash
npx web-push generate-vapid-keys
```

Omit the three VAPID variables and the app simply doesn't offer
notifications. On iOS, Web Push only works for a site added to the home
screen — that's an Apple restriction, not a bug here.

---

## Local development

```bash
npm install
cp .env.example .env.local   # fill in real values
npm run dev
```

Other scripts: `npm run build`, `npm run lint`, `npm run typecheck`.

---

## For developers

**Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first.** It is the
contract between the parts of this app, and the single most important thing
in it is the split between three groups of tables:

- **identity** (`profiles`) — readable only by its owner
- **league-scoped** (`leagues`, `league_members`, `stages`, `draft_order`,
  `roster_picks`, …) — every query must be scoped to a league
- **global NFL data** (`players`, `nfl_games`, `nfl_week_stats`) — shared by
  every league on the instance

A few things that are easy to get wrong:

- **`league_members` is the authorization root.** There is no global
  "is commissioner" flag; the question is always *of which league*.
- **Never set `league_id` yourself** on `draft_order` / `roster_picks` /
  `weekly_results`. A trigger derives it from `stage_id`, which is what stops
  a client smuggling in a league it doesn't belong to.
- **Stats are keyed by NFL week**, not by stage. Go through
  `src/lib/db/stats.ts`.
- **RLS is the authorization boundary**, not the UI and not the server
  actions. Add policies, not checks. Use the `is_league_member` /
  `is_league_commissioner` helpers rather than re-deriving them inline.
- **Rules constants have one home each**: `src/lib/scoring.ts` (points),
  `src/lib/roster.ts` (roster shape), `src/lib/league.ts` (league size, slugs,
  season). The database mirrors all three — change them together.
- **Build UI from `src/components/ui/`** primitives and the retro Tailwind
  tokens. Zero border radius, hard shadows, Press Start 2P + VT323.

This app is a multi-tenant fork of a private single-league app. The bottom of
`docs/ARCHITECTURE.md` has a table of exactly what changed and why, which is
the fastest way in if you have seen that codebase.
