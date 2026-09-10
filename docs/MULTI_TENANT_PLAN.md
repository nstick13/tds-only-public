# tds-only-public — multi-tenant plan

`tds-only-league` is a single, private, 8-manager league baked into one
Supabase project. `tds-only-public` runs **one** instance that hosts **many**
independent leagues of the same game. Anyone can sign in, spin up a league,
and share an invite link; the first 8 people to accept fill seats 1–8.

This repo starts as a straight copy of `tds-only-league` (commit 1) and is
refactored into the multi-tenant shape described here.

---

## What stays the same

The *game* does not change:

- TD-only scoring (`src/lib/scoring.ts`) — pass 0.5, rush 1.0, rec 1.0.
- Roster shape (`src/lib/roster.ts`) — QB2 / RB2 / WR2 / TE1, 7 players.
- Weekly redraft, snake order seeded by last week's standings, last place
  picks first (`src/lib/draftOrder.ts`).
- 22 stages: Weeks 1–18 + 4 postseason rounds.
- Retro Tecmo/NES design system, all `src/components/ui/` primitives.
- Realtime draft board, Web Push, Tank01 as the stat source.
- Google OAuth, no passwords.

The pure-logic modules (`scoring`, `roster`, `draftOrder`, `standings`,
`components/draft/draftLogic`) are reused **unchanged**.

---

## The core model change

### New tables

| Table | Purpose |
| --- | --- |
| `leagues` | One row per league. `id`, `slug` (URL key), `name`, `season` (year), `created_by`, `status` (`setup` → `active` → `complete`), timestamps. |
| `league_members` | `(league_id, user_id)` → membership. Carries `seat` (1–8, null = spectator/waitlist), `is_commissioner`, `is_player`, `display_name` (per-league override). **This is where the roles model moves** — off the global `profiles` row. |
| `league_invites` | `code` (random, URL-safe), `league_id`, `created_by`, `expires_at`, `max_uses`, `uses`. Accepting one claims the lowest free seat. |

### Tables that gain a `league_id`

`stages`, `draft_order`, `roster_picks`, `weekly_results`,
`push_subscriptions`. Each league gets its own 22 `stages` rows seeded on
creation, its own draft state, its own standings. `stages.id` stops being a
global `smallserial` the app can assume — always query by
`(league_id, ordinal)`.

### Tables that stay GLOBAL (shared by every league)

| Table | Why |
| --- | --- |
| `profiles` | Still one row per auth user — identity only. `is_commissioner` / `is_player` / `manager_slot` columns are **dropped** (moved to `league_members`). |
| `players` | The NFL player pool is universal. One `sync-players` run serves every league. |
| `nfl_week_stats` | **Renamed + re-keyed `player_stage_stats`.** Keyed by `(season, season_type, week_num, player_id)` instead of `stage_id`. NFL box-score TDs are the same for everyone — storing them per-stage would re-fetch and duplicate identical data for every league and blow the Tank01 daily budget once there are more than ~2 leagues. Standings join `stages → (season, season_type, week_num) → nfl_week_stats`. |
| `sync_log` | Instance-wide. The sync jobs are instance-level now (see below). |
| `nfl_games` | New: `getNFLGamesForWeek` results cached per `(season, season_type, week_num)` incl. `first_kickoff_at`, so `apply-locks` and the schedule sync don't refetch per league. |

`manual_sync_runs` stays global (the Tank01 cooldown is an instance
resource, not a per-league one — see "Sync" below).

---

## Routing

```
/                         marketing + "your leagues" list + "create a league"
/leagues/new              create a league (server action → row + 22 stages + first invite)
/join/[code]              accept an invite → claim a seat → redirect into the league
/l/[slug]                 the league home page (was /)
/l/[slug]/draft           the live draft room (was /draft)
/l/[slug]/settings        per-league display name + notifications (was /settings)
/l/[slug]/commish         commissioner console (was /commish)
/login, /auth/*           unchanged
```

`src/app/(app)/` → `src/app/l/[slug]/`. A new `src/app/l/[slug]/layout.tsx`
resolves the slug to a league, checks `league_members` for the signed-in
user, 404s non-members, and passes a `LeagueContext` (league row + the
caller's membership) down. Every `db/*` helper gains a `leagueId` argument.

`middleware.ts` keeps doing only session refresh. Membership is enforced in
the layout + RLS, not the matcher.

---

## RLS

Replace the two global helpers with league-scoped ones:

```sql
public.is_league_member(uid uuid, lid uuid) returns boolean
public.is_league_commissioner(uid uuid, lid uuid) returns boolean
```

Policy shape per league-scoped table:

- **SELECT**: `is_league_member(auth.uid(), league_id)` — league data is
  private to that league now, not just "any authenticated user".
- **roster_picks INSERT/DELETE**: own pick (`manager_id = auth.uid()`),
  stage `draft_open`, **and** membership.
- **stages / draft_order / weekly_results write**:
  `is_league_commissioner(auth.uid(), league_id)`.
- **leagues INSERT**: any authenticated user. **UPDATE**: commissioner of
  that league.
- **league_members**: a user reads rows of leagues they belong to; a
  commissioner writes seats/roles for their league; the join flow inserts
  the caller's own row via a `security definer` `accept_invite(code)`.

Global tables (`players`, `nfl_week_stats`, `nfl_games`, `sync_log`):
SELECT to any authenticated user, writes only via service role (sync jobs).

`handle_new_user()` shrinks to: insert the `profiles` row, nothing else.
Seat assignment happens in `accept_invite()`.

---

## Sync jobs — move off per-project SQL cron, onto the instance

`tds-only-league` scheduled Tank01 pulls with `pg_cron` + `pg_net` inside its
Supabase project (`0004_cron.sql`) and ran the fetch logic as Deno Edge
Functions (`supabase/functions/`). For one shared instance that's the wrong
seam. Instead:

- Port `supabase/functions/_shared/*` (Tank01 client, parsing, game-fetch
  gating) and the four jobs to **Next.js route handlers** under
  `src/app/api/cron/{sync-players,sync-schedule,sync-scores,apply-locks}`,
  Node runtime, guarded by a `CRON_SECRET` bearer check.
- Schedule them with **Vercel Cron** (`vercel.json` `crons`), once for the
  whole instance.
- `sync-players` / `sync-schedule` / `sync-scores` write the **global**
  `players` / `nfl_games` / `nfl_week_stats` — they don't know about
  leagues at all. They resolve which NFL weeks to pull from the set of
  `(season, season_type, week_num)` that any active league currently has a
  `draft_open` / `locked` stage for.
- `apply-locks` iterates every league: for each `draft_open` stage whose
  mapped `nfl_games.first_kickoff_at` has passed, flip to `locked`.
- Tank01 key: one `RAPIDAPI_KEY` env var on the instance. Budget math from
  `0004_cron.sql` still holds because the jobs are instance-level, not
  per-league.
- `supabase/functions/` is **deleted** after the port.

The Commish page's manual "sync now" buttons stay, still rate-limited by
`claim_manual_sync` (global), now calling the internal route instead of an
Edge Function.

---

## Migrations

Fresh, renumbered `0001`–`00NN` written for a brand-new Supabase project
(nobody is upgrading an existing `tds-only-public` DB — there isn't one).
Same "paste one file at a time into the SQL editor" property. Planned split:

1. `0001_identity.sql` — `profiles` (identity only) + `handle_new_user`.
2. `0002_leagues.sql` — `leagues`, `league_members`, `league_invites`,
   `create_league`, `accept_invite`.
3. `0003_league_tables.sql` — `stages`, `draft_order`, `roster_picks`,
   `weekly_results` (all `league_id`-scoped) + roster/draft triggers.
4. `0004_global_nfl.sql` — `players`, `nfl_games`, `nfl_week_stats`,
   `sync_log`, `manual_sync_runs`.
5. `0005_rls.sql` — every policy.
6. `0006_realtime.sql` — publication + replica identity for the draft tables.
7. `0007_seed_stages_fn.sql` — `seed_league_stages(league_id, season)` used
   by `create_league`.

Setup docs (`README.md`) get rewritten for an instance operator: one
Supabase project, one Google OAuth client, one Vercel project, the env vars,
and Vercel Cron.

---

## Phasing

- **Phase 1 — schema.** Write all migrations + regenerate `src/lib/types.ts`.
  No app code yet. *(you can review the data model here before the refactor)*
- **Phase 2 — league lifecycle.** `/`, `/leagues/new`, `/join/[code]`,
  the `l/[slug]` layout + `LeagueContext`, membership guard.
- **Phase 3 — port the app.** Move `(app)/*` under `l/[slug]/`, thread
  `leagueId` through every `db/*` helper and server action, fix realtime
  channel names (`draft:{leagueId}:{stageId}`).
- **Phase 4 — sync.** Port `_shared` + the four jobs to route handlers,
  `vercel.json` crons, delete `supabase/functions/`.
- **Phase 5 — commish + polish.** Per-league manager admin (seat/role
  management replaces the Supabase-Studio step), invite management UI,
  README rewrite, deploy.

Open defaults taken (say if any is wrong):

- League size fixed at 8 (the game is defined that way). Not configurable.
- One shared Supabase project; `nfl_week_stats` global (not per-league).
- Vercel Cron + internal route handlers instead of Supabase Edge Functions.
- Leagues are private — only members can read league data.
- Invite links: any commissioner can mint them, default 7-day expiry, seat
  claimed on accept.
