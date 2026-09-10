-- ============================================================================
-- 0004_league_tables.sql
-- TD's Only (public) — per-league game state
--
-- Run AFTER 0003_leagues.sql.
--
-- Every table here carries `league_id`. On stages that is the real parent; on
-- the rest it is denormalized from the stage, because RLS reads it on every
-- single row and a policy that had to sub-select through stages for each row
-- of a draft board is the kind of thing that is fine at 8 rows and miserable
-- at 56 x N leagues. A trigger (0005_functions.sql) keeps the denormalized
-- copy honest, so application code never sets it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- stages
-- One league's draftable stages: Weeks 1-18 then the four postseason rounds,
-- seeded by seed_league_stages() when the league is created. Unlike the
-- single-league app these are NOT globally seeded and `id` is not a small
-- integer anyone can guess — always address a stage as (league_id, ordinal).
--
-- season / season_type / week_num address the NFL week this stage scores,
-- and are the join key into nfl_week_stats and nfl_games (0002).
--
-- POSTSEASON ROWS SHIP UNADDRESSED (season_type / week_num NULL) — carried
-- over deliberately from the single-league app. Tank01's playoff seasonType
-- value and week numbering were never confirmed against a real response, and
-- guessing would make four January stages silently sync the wrong games.
-- Sync jobs skip an unaddressed stage and say so in sync_log.
-- ----------------------------------------------------------------------------
create table if not exists public.stages (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  name text not null,
  ordinal smallint not null check (ordinal between 1 and 22),
  season smallint not null,
  season_type text,
  week_num smallint,
  status text not null default 'upcoming'
    check (status in ('upcoming', 'draft_open', 'locked', 'finalized')),
  created_at timestamptz not null default now(),
  constraint stages_league_ordinal_unique unique (league_id, ordinal),
  -- Half-addressed would send week=NULL to Tank01 and read as "no games this
  -- week" rather than "never configured".
  constraint stages_addressing_complete
    check ((season_type is null) = (week_num is null)),
  constraint stages_week_num_sane
    check (week_num is null or week_num between 1 and 22)
);

comment on table public.stages is
  'Per-league draftable stages (18 weeks + 4 postseason). Address as (league_id, ordinal); (season, season_type, week_num) joins to the shared NFL data.';

create index if not exists stages_league_ordinal_idx
  on public.stages (league_id, ordinal);
create index if not exists stages_week_idx
  on public.stages (season, season_type, week_num);
-- Partial index: apply-locks and the sync jobs both ask "which stages are
-- live right now", across every league at once.
create index if not exists stages_active_idx
  on public.stages (status)
  where status in ('draft_open', 'locked');

-- ----------------------------------------------------------------------------
-- draft_order
-- The snake order for one stage: 8 managers x ROSTER_SIZE (7) rounds = 56
-- picks. Generation lives in src/lib/draftOrder.ts; this table stores the
-- result.
-- ----------------------------------------------------------------------------
create table if not exists public.draft_order (
  league_id uuid not null references public.leagues (id) on delete cascade,
  stage_id uuid not null references public.stages (id) on delete cascade,
  pick_number smallint not null check (pick_number between 1 and 56),
  manager_id uuid references public.profiles (id) on delete set null,
  primary key (stage_id, pick_number)
);

comment on table public.draft_order is
  'Snake draft order per stage (56 picks = 8 managers x 7 rounds). league_id is set by trigger from stage_id.';

create index if not exists draft_order_league_idx on public.draft_order (league_id);
-- Covers the manager_id FK; also the "which picks are mine" lookup.
create index if not exists draft_order_manager_idx on public.draft_order (manager_id);

-- ----------------------------------------------------------------------------
-- roster_picks
-- The drafted rosters. unique(stage_id, player_id) is what makes the player
-- pool exclusive — and because stages belong to exactly one league, that
-- exclusivity is correctly scoped PER LEAGUE. Two different leagues can and
-- should both roster the same quarterback in Week 5.
-- ----------------------------------------------------------------------------
create table if not exists public.roster_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  stage_id uuid not null references public.stages (id) on delete cascade,
  manager_id uuid not null references public.profiles (id) on delete cascade,
  player_id text not null references public.players (id) on delete restrict,
  slot_position text not null check (slot_position in ('QB', 'RB', 'WR', 'TE')),
  pick_number smallint,
  created_at timestamptz not null default now(),
  constraint roster_picks_stage_player_unique unique (stage_id, player_id)
);

comment on table public.roster_picks is
  'Drafted rosters. unique(stage_id, player_id) gives an exclusive pool per league per stage; enforce_roster_limits() enforces QB2/RB2/WR2/TE1.';

create index if not exists roster_picks_stage_manager_idx
  on public.roster_picks (stage_id, manager_id);
create index if not exists roster_picks_league_idx
  on public.roster_picks (league_id);
-- FK-covering indexes. manager_id is the SECOND column of
-- roster_picks_stage_manager_idx and player_id the second of
-- roster_picks_stage_player_unique, so neither FK is covered by those.
create index if not exists roster_picks_manager_idx
  on public.roster_picks (manager_id);
create index if not exists roster_picks_player_idx
  on public.roster_picks (player_id);

-- ----------------------------------------------------------------------------
-- weekly_results
-- Computed per-manager stage totals, written when a commissioner finalizes a
-- stage. Stored rather than derived so a finalized week is a fixed record even
-- if a stat correction lands later.
-- ----------------------------------------------------------------------------
create table if not exists public.weekly_results (
  league_id uuid not null references public.leagues (id) on delete cascade,
  stage_id uuid not null references public.stages (id) on delete cascade,
  manager_id uuid not null references public.profiles (id) on delete cascade,
  total_tds smallint not null default 0,
  total_points numeric(6, 1) not null default 0,
  qb_points numeric(6, 1) not null default 0,
  rb_points numeric(6, 1) not null default 0,
  wr_points numeric(6, 1) not null default 0,
  te_points numeric(6, 1) not null default 0,
  rank smallint,
  finalized_at timestamptz,
  primary key (stage_id, manager_id)
);

comment on table public.weekly_results is
  'Per-manager stage totals and rank, written at finalize time. league_id is set by trigger from stage_id.';

create index if not exists weekly_results_league_idx
  on public.weekly_results (league_id);
-- manager_id is the second PK column, so the PK index does not cover the FK.
create index if not exists weekly_results_manager_idx
  on public.weekly_results (manager_id);
