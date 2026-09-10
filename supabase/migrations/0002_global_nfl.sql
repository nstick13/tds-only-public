-- ============================================================================
-- 0002_global_nfl.sql
-- TD's Only (public) — the NFL data every league shares
--
-- Run AFTER 0001_identity.sql.
--
-- WHY THESE TABLES ARE NOT SCOPED TO A LEAGUE
-- ----------------------------------------------------------------------------
-- Who plays for which team, when a game kicks off, and how many touchdowns
-- someone scored in Week 5 are facts about the NFL, not about a league. Every
-- league's Week 5 reads the same numbers.
--
-- The single-league app keyed stats by `stage_id`, which was right when there
-- was exactly one set of stages. Here it would mean re-fetching and re-storing
-- an identical copy of every box score for every league on the instance —
-- N leagues x the same Tank01 calls. Tank01 Pro allows 1,000 calls/DAY, and
-- the cadences this app ships with are sized against that budget assuming ONE
-- fetch per NFL week. Per-league stats would blow through it at about two
-- leagues.
--
-- So stats are keyed by the NFL week itself — (season, season_type, week_num)
-- — and a league's stage carries those same three values (0004). Standings
-- join stage -> week -> stats. One sync serves every league on the instance,
-- and adding the 50th league costs zero extra API calls.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- players
-- The league-wide (instance-wide) player pool, synced from Tank01. `id` is
-- Tank01's playerID, kept as text.
-- ----------------------------------------------------------------------------
create table if not exists public.players (
  id text primary key,
  name text not null,
  position text not null check (position in ('QB', 'RB', 'WR', 'TE')),
  nfl_team text,
  nfl_team_id text,
  status text not null default 'Active',
  status_detail text,
  on_bye boolean not null default false,
  updated_at timestamptz not null default now(),
  last_synced_at timestamptz
);

comment on table public.players is
  'Instance-wide NFL player pool synced from Tank01. Shared by every league.';

create index if not exists players_position_idx on public.players (position);
create index if not exists players_name_idx on public.players (name);

-- ----------------------------------------------------------------------------
-- nfl_games
-- One row per NFL game, from Tank01 getNFLGamesForWeek. Two jobs need this:
-- sync-scores (which games to pull box scores for) and apply-locks (a stage
-- locks at its week's FIRST kickoff).
--
-- In the single-league app the kickoff lived on stages.first_kickoff_at. It
-- moves here because kickoff is a property of the NFL week, not of any one
-- league's copy of that week — otherwise every league stores the same
-- timestamp and they can drift apart.
-- ----------------------------------------------------------------------------
create table if not exists public.nfl_games (
  game_id text primary key,
  season smallint not null,
  season_type text not null,
  week_num smallint not null,
  home_team text,
  away_team text,
  kickoff_at timestamptz,
  game_status text,
  updated_at timestamptz not null default now()
);

comment on table public.nfl_games is
  'NFL schedule per week from Tank01. Backs score-sync targeting and the kickoff that locks a stage.';

create index if not exists nfl_games_week_idx
  on public.nfl_games (season, season_type, week_num);

-- ----------------------------------------------------------------------------
-- nfl_week_stats
-- Touchdowns per player per NFL week. `points` is generated in-DB from the
-- league scoring rule so it can never drift from src/lib/scoring.ts.
--
-- NOTE: scoring is fixed instance-wide (this IS the game — TDs only, pass 0.5
-- / rush 1.0 / rec 1.0). If per-league scoring is ever wanted, this generated
-- column is the thing that has to give, and points would have to be computed
-- per league at read time instead.
-- ----------------------------------------------------------------------------
create table if not exists public.nfl_week_stats (
  season smallint not null,
  season_type text not null,
  week_num smallint not null,
  player_id text not null references public.players (id) on delete cascade,
  pass_td smallint not null default 0,
  rush_td smallint not null default 0,
  rec_td smallint not null default 0,
  points numeric(5, 1) generated always as
    (pass_td * 0.5 + rush_td * 1.0 + rec_td * 1.0) stored,
  updated_at timestamptz not null default now(),
  primary key (season, season_type, week_num, player_id)
);

comment on table public.nfl_week_stats is
  'TD counts per player per NFL week, shared by every league. points is generated — keep in sync with src/lib/scoring.ts.';

-- player_id is the 4th column of the primary key, so the PK index does not
-- cover it. Without this, the `on delete cascade` from players has to seq-scan
-- the whole stats table for every player the sync retires.
create index if not exists nfl_week_stats_player_idx
  on public.nfl_week_stats (player_id);

-- ----------------------------------------------------------------------------
-- sync_log
-- Append-only log of sync job runs. Instance-wide: the jobs are instance-wide.
-- Backs the "last updated X ago" freshness line every league sees.
-- ----------------------------------------------------------------------------
create table if not exists public.sync_log (
  id bigserial primary key,
  source text not null check (source in ('players', 'schedule', 'scores', 'locks')),
  status text not null check (status in ('success', 'error')),
  message text,
  player_count int,
  ran_at timestamptz not null default now()
);

comment on table public.sync_log is
  'Append-only sync run log. Query the newest SUCCESSFUL row per source for staleness UI.';

create index if not exists sync_log_source_ran_at_idx
  on public.sync_log (source, ran_at desc);

-- ----------------------------------------------------------------------------
-- manual_sync_runs
-- Gates the "sync now" buttons. Deliberately INSTANCE-wide, not per league:
-- the thing being rationed is the shared Tank01 daily call budget, so one
-- league's commissioner mashing the button has to count against everyone's.
-- Writes go only through claim_manual_sync() (0005_functions.sql).
-- ----------------------------------------------------------------------------
create table if not exists public.manual_sync_runs (
  id bigserial primary key,
  source text not null check (source in ('players', 'schedule', 'scores', 'locks')),
  triggered_by uuid references public.profiles (id) on delete set null,
  triggered_at timestamptz not null default now()
);

comment on table public.manual_sync_runs is
  'Manual sync triggers. Newest row per source gates an instance-wide one-per-hour cooldown — see claim_manual_sync().';

create index if not exists manual_sync_runs_triggered_at_idx
  on public.manual_sync_runs (source, triggered_at desc);

-- Covers the triggered_by FK, whose `on delete set null` fires whenever a
-- profile is deleted.
create index if not exists manual_sync_runs_triggered_by_idx
  on public.manual_sync_runs (triggered_by);

-- ----------------------------------------------------------------------------
-- push_subscriptions
-- One row per browser a user has enabled notifications in. Global (per user),
-- NOT per league: a browser subscribes once and the sender decides what to
-- say. Endpoints are effectively bearer URLs — anyone holding one can push to
-- that device — so unlike everything else here they are never readable by
-- anyone but their owner.
-- ----------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_failure_at timestamptz
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

comment on table public.push_subscriptions is
  'Web Push endpoints per user per browser. Endpoints are secrets — readable only by their owner.';
