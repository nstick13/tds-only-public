-- ============================================================================
-- 0003_leagues.sql
-- TD's Only (public) — leagues, membership, invites
--
-- Run AFTER 0002_global_nfl.sql.
--
-- This is the whole multi-tenant seam. Everything league-scoped hangs off
-- `leagues.id`, and `league_members` is the authorization root: RLS asks
-- "is this user a member / a commissioner OF THIS LEAGUE", never a global
-- flag on the account.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- leagues
--
-- `slug` is the URL key (/l/<slug>). Lowercase, hyphen-separated, 3-40 chars,
-- and constrained here rather than only in the app so a bad slug can never
-- reach the routing layer. `season` is the NFL season year the league plays
-- (a season is named for the year it STARTS in, so January's playoffs still
-- belong to the previous year's number).
--
-- `status`:
--   setup    — created, seats still filling, no draft opened
--   active   — the season is running
--   complete — every stage finalized
-- ----------------------------------------------------------------------------
create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$'),
  name text not null check (length(trim(name)) between 1 and 60),
  season smallint not null check (season between 2020 and 2100),
  status text not null default 'setup'
    check (status in ('setup', 'active', 'complete')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.leagues is
  'One row per league. slug is the URL key (/l/<slug>); season is the NFL season year this league plays.';

create index if not exists leagues_created_by_idx on public.leagues (created_by);

-- ----------------------------------------------------------------------------
-- league_members
--
-- The roles model, per league. This replaces profiles.is_commissioner /
-- is_player / manager_slot from the single-league app.
--
--   seat            1..8, or NULL for someone who has joined but holds no
--                   roster (a spectator, or a 9th arrival waiting for a seat
--                   to open). unique per league — NULLs don't collide in a
--                   Postgres unique constraint, which is exactly what we want.
--   is_player       true when this member drafts a roster. Set together with
--                   a seat; kept separate so a commissioner can bench someone
--                   without freeing their seat.
--   is_commissioner can run the league. The creator gets this on creation.
--   display_name    per-league override; NULL falls back to profiles.display_name.
--                   Lets someone be "Nate" in one league and "Coach" in another.
-- ----------------------------------------------------------------------------
create table if not exists public.league_members (
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  seat smallint check (seat between 1 and 8),
  is_player boolean not null default false,
  is_commissioner boolean not null default false,
  display_name text,
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id),
  constraint league_members_seat_unique unique (league_id, seat),
  -- A seated member is a player and vice versa. Enforced here because the
  -- draft derives its round count from the seated managers, and a seat with
  -- is_player=false (or the reverse) would silently produce a short draft.
  constraint league_members_seat_matches_player
    check ((seat is null) = (is_player is false))
);

comment on table public.league_members is
  'Per-league membership and roles. THE authorization root — RLS asks this table, never a global flag.';

create index if not exists league_members_user_idx on public.league_members (user_id);

-- ----------------------------------------------------------------------------
-- league_invites
--
-- A shareable code that grants membership in one league. Commissioners mint
-- them; accept_invite() (0005_functions.sql) is the only thing that redeems
-- one, and it is what claims a seat.
--
-- `uses`/`max_uses` rather than one-shot codes: the normal flow is a
-- commissioner pasting ONE link into a group chat for seven people.
-- ----------------------------------------------------------------------------
create table if not exists public.league_invites (
  code text primary key check (code ~ '^[A-Za-z0-9_-]{8,64}$'),
  league_id uuid not null references public.leagues (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz,
  max_uses smallint check (max_uses is null or max_uses > 0),
  uses smallint not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.league_invites is
  'Shareable join codes. Redeemed only by accept_invite(), which is what claims a seat.';

create index if not exists league_invites_league_idx
  on public.league_invites (league_id, created_at desc);

-- Covers the created_by FK (`on delete set null` on profile deletion).
create index if not exists league_invites_created_by_idx
  on public.league_invites (created_by);
