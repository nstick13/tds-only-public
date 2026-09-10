# Architecture

This document is the contract between the parts of this app. Read it before
adding tables, routes, or conventions of your own.

`tds-only-public` runs **one instance** that hosts **many independent
leagues** of the same game: TD-only scoring, weekly full redraft, 8 managers,
QB2/RB2/WR2/TE1. It is a multi-tenant fork of the private single-league app
`tds-only-league`. If you are coming from that codebase, the section
"What changed from the single-league app" at the bottom is the fastest way in.

---

## The three data groups

Knowing which group a table belongs to is the single most important thing to
get right when writing a query.

### 1. Identity — `profiles`

One row per authenticated account. **Identity only** — no roles, no seats.

`profiles` is readable **only by its owner**. It holds email addresses, and on
an instance anyone can sign up to, a permissive read policy would let any new
account enumerate every user's email. Leaguemates' names come from
`league_members.display_name`, which is copied from the profile at join time.

> Do not try to join `profiles` to render a member list. It will come back
> empty for everyone but yourself, and the failure looks like missing data
> rather than a permission error.

### 2. League-scoped — `leagues`, `league_members`, `league_invites`, `stages`, `draft_order`, `roster_picks`, `weekly_results`

Every one of these carries a `league_id`. **Every query against them must be
scoped to a league.** RLS enforces it, but a missing filter yields an empty
result rather than an error — which is a confusing way to discover the bug.

`league_members` is the **authorization root**. There is no global
`is_commissioner` anywhere; the question is always "…of *which* league".

### 3. Global NFL data — `players`, `nfl_games`, `nfl_week_stats`, `sync_log`

Shared by every league on the instance. Who plays for which team, when a game
kicks off, and how many touchdowns someone scored in Week 5 are facts about
the NFL, not about a league.

**`nfl_week_stats` is keyed by `(season, season_type, week_num, player_id)`,
not by stage.** This is the most important schema difference from the
single-league app, and it is what makes the instance scale: one sync run
serves every league, and adding the fiftieth league costs zero extra Tank01
calls. A league's `stages` row carries those same three addressing columns, so
standings join **stage → (season, season_type, week_num) → nfl_week_stats**.

| Table | Group | Notes |
| --- | --- | --- |
| `profiles` | identity | Owner-readable only. |
| `leagues` | league | `slug` is the URL key. `season` = NFL season year. |
| `league_members` | league | `seat` 1–8 (null = spectator), `is_player`, `is_commissioner`, `display_name`. |
| `league_invites` | league | Codes are credentials — commissioner-readable only. |
| `stages` | league | 22 per league. `id` is a **uuid**, not a small int. Address as `(league_id, ordinal)`. |
| `draft_order` | league | 56 picks = 8 × `ROSTER_SIZE`. |
| `roster_picks` | league | `unique(stage_id, player_id)` ⇒ exclusive pool *per league per stage*. |
| `weekly_results` | league | Written at finalize time; not computed live. |
| `players` | global | Tank01 `playerID` as `id`. |
| `nfl_games` | global | Schedule + kickoff. A stage locks at its week's first kickoff. |
| `nfl_week_stats` | global | TDs per player per **NFL week**. `points` is generated in-DB. |
| `sync_log` | global | Backs the "last updated X ago" line. |
| `manual_sync_runs` | global | Instance-wide sync cooldown — the Tank01 budget is shared. |
| `push_subscriptions` | global | Per user per browser. Endpoints are secrets. |

---

## Authorization

RLS is **the** authorization boundary (`supabase/migrations/0006_rls.sql`).
Server actions re-check things only so they can return a friendly message
instead of a raw policy denial — never as the actual control.

Two security-definer helpers back every league policy. Use them in new
policies rather than re-deriving the check inline:

```sql
public.is_league_member(uid uuid, lid uuid) returns boolean
public.is_league_commissioner(uid uuid, lid uuid) returns boolean
```

A `using (true)` policy is a bug unless the table is one of the global NFL
tables.

### Things that only happen through `security definer` functions

There is no client INSERT policy on `leagues`, `league_members`, or
`league_invites`. Membership and league creation flow exclusively through:

| Function | What it guarantees |
| --- | --- |
| `create_league(name, slug, season)` | League + 22 stages + creator seated as commissioner + first invite, **atomically**. A league with no stages or no commissioner is not a reachable state. |
| `accept_invite(code)` | Validates the code and claims the lowest free seat under an advisory lock, so two people opening the same link at once can't both take seat 4. Idempotent. Joins as a spectator (`seat = null`) when all 8 are taken rather than rejecting someone who clicked a link they were given. |
| `get_invite_preview(code)` | What `/join/<code>` shows *before* joining — league name and seat count only. The viewer isn't a member yet, so they cannot read `leagues` directly. |
| `leave_league(id)` | Refuses to strand a league with no commissioner. |
| `create_league_invite(...)` | Commissioner-only minting. |
| `replace_roster_pick(...)` | Atomic swap preserving manager, slot and `pick_number`. |
| `claim_manual_sync(source)` / `release_manual_sync(id)` | Instance-wide one-per-hour sync cooldown. |

Two triggers do authorization work and are easy to miss:

- **`set_league_id_from_stage()`** derives `league_id` from `stage_id` on
  every insert/update of `draft_order`, `roster_picks`, `weekly_results`.
  **Application code must never set `league_id` on those tables.** Postgres
  runs BEFORE-row triggers before RLS `WITH CHECK`, so a client cannot smuggle
  in a `league_id` it isn't a member of.
- **`guard_league_member_self_update()`** lets a member edit only their own
  `display_name`. Without it the "own row" UPDATE policy would let anyone set
  their own `is_commissioner = true` — a row-level `WITH CHECK` cannot stop a
  column change.

---

## Routing

```
/                          signed out: what this is. signed in: your leagues + "create a league"
/login                     Google OAuth (sign-in and sign-up are the same action)
/auth/callback             PKCE exchange
/leagues/new               create a league
/join/[code]               invite preview -> accept -> redirected into the league
/l/[slug]                  league home: this week, season standings, past weeks
/l/[slug]/draft            the live draft room
/l/[slug]/settings         display name + notifications for this league
/l/[slug]/commish          commissioner console
/api/cron/[job]            sync jobs (see below)
```

`src/app/l/[slug]/layout.tsx` resolves the slug to a `LeagueContext`
(`{ league, membership }`), calls `notFound()` for non-members, and renders
the nav. **Pages under it can trust `membership` is non-null** — that is the
whole point of resolving it in the layout.

`middleware.ts` does session refresh only. Membership is enforced in the
layout and in RLS, not in the matcher.

---

## Conventions

- **All persistent state flows through Supabase.** No `localStorage` as a
  source of truth for league data. Fine for pure UI state (an open modal),
  never for anything shared between managers or that must survive a refresh.
- **File layout**: App Router pages under `src/app/`; shared React UI in
  `src/components/` (`src/components/ui/` = generic retro primitives, feature
  components get a subfolder); non-component logic in `src/lib/`.
- **Naming**: SQL is `snake_case`, TypeScript `camelCase`/`PascalCase`.
  Migrations are numbered and self-contained (`NNNN_description.sql`) so a
  whole file can be pasted into the Supabase SQL editor and run top-to-bottom.
  Keep that property: guard `create table` with `if not exists`, precede
  `create trigger` with `drop trigger if exists`, etc.
- **Constants have one home.** `src/lib/scoring.ts` (point values),
  `src/lib/roster.ts` (`ROSTER_SHAPE`, `ROSTER_SIZE`), `src/lib/league.ts`
  (`LEAGUE_SIZE`, `DRAFT_PICK_COUNT`, slug rules, `currentNflSeason`). The DB
  mirrors these in the `nfl_week_stats.points` generated column, the
  `enforce_roster_limits()` trigger, and the `seat` / `pick_number` CHECK
  constraints. **If a rule changes, all of those move together.**
- **Stage list is DB-driven.** Query `stages` filtered by `league_id`, ordered
  by `ordinal`. Never hardcode a stage list.
- **Types**: import row shapes from `src/lib/types.ts`. Don't re-declare them
  against `any` query results.
- **Design system**: build from `src/components/ui/` (`PixelButton`,
  `PixelPanel`, `Badge`, `ScoreDisplay`) and the `retro.*` / `field.*` Tailwind
  tokens. Zero border radius, `shadow-pixel`, `font-pixel` / `font-mono`. Add
  new primitives to that folder when a pattern repeats; don't introduce ad-hoc
  styling.

### Realtime

Channel name is `draft:{stageId}`. Stage ids are uuids and therefore globally
unique across leagues, so the league id does not need to be in the channel
name. Subscriptions filter Postgres Changes on `roster_picks` and
`draft_order` by `stage_id=eq.{uuid}`.

Both tables are in the `supabase_realtime` publication with
`replica identity full` (`0007_realtime.sql`) — the latter is required, not a
nicety: without it a DELETE's old record carries only the primary key, so the
`stage_id` filter drops it and undone picks never reach other screens while
ordinary picks do.

---

## Sync jobs

The single-league app ran these as Supabase Deno Edge Functions scheduled by
`pg_cron` inside its own project. For a shared instance that is the wrong
seam, so they are **Next.js route handlers on the Node runtime**, scheduled
once by **Vercel Cron**:

```
POST/GET /api/cron/sync-players    the global player pool
         /api/cron/sync-schedule   nfl_games + kickoff times
         /api/cron/sync-scores     nfl_week_stats
         /api/cron/apply-locks     flips due draft_open stages to locked, every league
```

Contract every job follows:

1. **Auth**: require `Authorization: Bearer $CRON_SECRET`. With `CRON_SECRET`
   unset, refuse to run — never fall back to running unauthenticated.
2. **Client**: service role (bypasses RLS). These jobs write global tables and
   read across every league.
3. **Log**: write exactly one `sync_log` row per run, success *or* error. The
   freshness line in the UI depends on it.
4. **Never throw out to the framework** — catch, log, return JSON with a
   sensible status.

The first three jobs know **nothing about leagues**. They resolve which NFL
weeks to fetch from the distinct `(season, season_type, week_num)` of stages
that are currently `draft_open` or `locked` **across all leagues**, then write
global tables. `apply-locks` is the only league-aware job: for each
`draft_open` stage whose week's first `nfl_games.kickoff_at` has passed, flip
it to `locked`.

**Unaddressed stages are skipped, not guessed at.** The four postseason stages
ship with `season_type`/`week_num` NULL because Tank01's playoff numbering was
never confirmed against a real response. A job must check
`isAddressable(stage)` and log a skip rather than sending `week=null`, which
would return an empty result and read as "no games this week".

Tank01 Pro is **1,000 calls/day** and the cadences in `vercel.json` are sized
against it. Because stats are per-NFL-week rather than per-league, that budget
does not shrink as leagues are added.

---

## What changed from the single-league app

| `tds-only-league` | here |
| --- | --- |
| `profiles.is_commissioner` / `is_player` / `manager_slot` | `league_members.is_commissioner` / `is_player` / `seat` |
| `handle_new_user()` hands the first 8 signups a seat | `handle_new_user()` only creates the profile; `accept_invite()` claims seats |
| `stages.id` is `smallserial`, 22 rows globally | `stages.id` is a uuid, 22 rows **per league** |
| `player_stage_stats(stage_id, player_id)` | `nfl_week_stats(season, season_type, week_num, player_id)` |
| `stages.first_kickoff_at` | `nfl_games.kickoff_at` (a property of the week, not of a league's copy of it) |
| Routes at `/`, `/draft`, `/commish` | `/l/[slug]`, `/l/[slug]/draft`, `/l/[slug]/commish` |
| Deno Edge Functions + `pg_cron` | Next route handlers + Vercel Cron |
| `select ... using (true)` on everything | `is_league_member(auth.uid(), league_id)` |
| Commissioner promoted by hand in Supabase Studio | League creator is commissioner automatically |
