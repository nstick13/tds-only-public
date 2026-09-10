-- ============================================================================
-- 0006_rls.sql
-- TD's Only (public) — Row Level Security
--
-- Run AFTER 0005_functions.sql (the policies below call helpers defined there).
--
-- THE ONE RULE
-- ----------------------------------------------------------------------------
-- In the single-league app, "authenticated" and "in the league" were the same
-- thing, so almost every policy was `using (true)`. Here they are emphatically
-- not: anyone on the internet can sign in. Every league-scoped table therefore
-- gates SELECT on is_league_member(auth.uid(), league_id), and every write on
-- is_league_commissioner(...) or ownership of the row.
--
-- A `using (true)` in this file is a bug unless the table is one of the four
-- global NFL tables, whose contents are public sports facts.
--
-- RLS is the authorization boundary. Server actions re-check things too, but
-- only so they can return a friendly message instead of a raw policy denial —
-- never as the actual control.
--
-- WHY auth.uid() IS ALWAYS WRITTEN `(select auth.uid())`
-- ----------------------------------------------------------------------------
-- A bare auth.uid() in a policy is volatile to the planner, so it is
-- re-evaluated once PER ROW scanned. Wrapping it in a scalar subquery lets the
-- planner hoist it into an InitPlan and run it once per statement. On a 56-row
-- draft board that is invisible; on a player-pool scan it is not. This is the
-- Supabase `auth_rls_initplan` lint — keep the parens if you edit a policy.
-- ============================================================================

alter table public.profiles           enable row level security;
alter table public.leagues            enable row level security;
alter table public.league_members     enable row level security;
alter table public.league_invites     enable row level security;
alter table public.stages             enable row level security;
alter table public.draft_order        enable row level security;
alter table public.roster_picks       enable row level security;
alter table public.weekly_results     enable row level security;
alter table public.players            enable row level security;
alter table public.nfl_games          enable row level security;
alter table public.nfl_week_stats     enable row level security;
alter table public.sync_log           enable row level security;
alter table public.manual_sync_runs   enable row level security;
alter table public.push_subscriptions enable row level security;

-- ----------------------------------------------------------------------------
-- profiles — YOUR OWN ROW ONLY.
--
-- This is stricter than the single-league app on purpose. `profiles` holds
-- email addresses, and on a shared instance "any authenticated user can read
-- every profile" means anyone who signs up can enumerate the email address of
-- everyone who has ever used the app.
--
-- Leaguemates still see each other's names: league_members.display_name is
-- copied from the profile when someone joins (see create_league /
-- accept_invite), so member lists render entirely from league_members and
-- never need to read someone else's profile row.
-- ----------------------------------------------------------------------------
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT/DELETE policy: rows are created by handle_new_user() and removed
-- by the auth.users cascade.

-- ----------------------------------------------------------------------------
-- leagues
--
-- No INSERT policy — create_league() is security definer and is the only way
-- in, which keeps "a league always has stages and a commissioner" true by
-- construction.
-- ----------------------------------------------------------------------------
drop policy if exists "leagues_select_member" on public.leagues;
create policy "leagues_select_member"
  on public.leagues for select
  to authenticated
  using (public.is_league_member((select auth.uid()), id));

drop policy if exists "leagues_update_commissioner" on public.leagues;
create policy "leagues_update_commissioner"
  on public.leagues for update
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), id))
  with check (public.is_league_commissioner((select auth.uid()), id));

drop policy if exists "leagues_delete_commissioner" on public.leagues;
create policy "leagues_delete_commissioner"
  on public.leagues for delete
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), id));

-- ----------------------------------------------------------------------------
-- league_members
--
-- SELECT is the member list every league page renders.
--
-- UPDATE is split in two, and the split matters: a commissioner may change
-- anything (seats, roles, benching someone), while an ordinary member may
-- update only their OWN row. A plain `using (user_id = auth.uid())` would be
-- a privilege-escalation hole — nothing in a row-level WITH CHECK stops the
-- user from also flipping their own is_commissioner to true in the same
-- statement. The guard trigger below is what actually pins that down, by
-- rejecting any self-update that changes a column other than display_name.
-- ----------------------------------------------------------------------------
drop policy if exists "league_members_select_member" on public.league_members;
create policy "league_members_select_member"
  on public.league_members for select
  to authenticated
  using (public.is_league_member((select auth.uid()), league_id));

drop policy if exists "league_members_update_commissioner" on public.league_members;
create policy "league_members_update_commissioner"
  on public.league_members for update
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id))
  with check (public.is_league_commissioner((select auth.uid()), league_id));

drop policy if exists "league_members_update_own" on public.league_members;
create policy "league_members_update_own"
  on public.league_members for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "league_members_delete_commissioner" on public.league_members;
create policy "league_members_delete_commissioner"
  on public.league_members for delete
  to authenticated
  using (
    public.is_league_commissioner((select auth.uid()), league_id)
    -- A commissioner cannot remove themselves this way; leave_league() is the
    -- path, and it refuses to strand a league with no commissioner.
    and user_id <> (select auth.uid())
  );

-- No INSERT policy: accept_invite() (security definer) is the only way in.

-- ----------------------------------------------------------------------------
-- guard_league_member_self_update()
--
-- Enforces what the "own row" UPDATE policy above cannot. A member editing
-- their own membership may change display_name and nothing else; seat,
-- is_player and is_commissioner are the commissioner's to set. Skipped
-- entirely when the caller commissions the league, and when there is no
-- auth.uid() at all (service role / definer functions), which is what lets
-- accept_invite and the commissioner UI work normally.
-- ----------------------------------------------------------------------------
create or replace function public.guard_league_member_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if public.is_league_commissioner(auth.uid(), new.league_id) then
    return new;
  end if;

  if new.seat is distinct from old.seat
     or new.is_player is distinct from old.is_player
     or new.is_commissioner is distinct from old.is_commissioner
     or new.league_id is distinct from old.league_id
     or new.user_id is distinct from old.user_id then
    raise exception
      'Only a commissioner can change seats or roles. You can change your display name.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- Trigger functions get EXECUTE to PUBLIC by default, which means PostgREST
-- exposes this `security definer` function at /rest/v1/rpc/... to anon. It is
-- only ever meant to fire from the trigger below, and a trigger's EXECUTE
-- privilege is checked at CREATE TRIGGER time, not at fire time — so revoking
-- costs nothing. (0005 does the same sweep for the functions it defines; this
-- one is created after that sweep runs, so it needs its own.)
revoke execute on function public.guard_league_member_self_update() from public;
revoke execute on function public.guard_league_member_self_update() from anon;
revoke execute on function public.guard_league_member_self_update() from authenticated;

drop trigger if exists league_members_guard_self_update on public.league_members;
create trigger league_members_guard_self_update
  before update on public.league_members
  for each row execute function public.guard_league_member_self_update();

-- ----------------------------------------------------------------------------
-- league_invites
--
-- Only commissioners see invite rows — an invite code is a credential, and a
-- plain member being able to read every code for their league would let them
-- hand out seats. Non-members see nothing here at all; /join/<code> reads
-- through get_invite_preview(), which is security definer and returns only a
-- league name and a seat count.
-- ----------------------------------------------------------------------------
drop policy if exists "league_invites_select_commissioner" on public.league_invites;
create policy "league_invites_select_commissioner"
  on public.league_invites for select
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id));

drop policy if exists "league_invites_update_commissioner" on public.league_invites;
create policy "league_invites_update_commissioner"
  on public.league_invites for update
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id))
  with check (public.is_league_commissioner((select auth.uid()), league_id));

drop policy if exists "league_invites_delete_commissioner" on public.league_invites;
create policy "league_invites_delete_commissioner"
  on public.league_invites for delete
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id));

-- No INSERT policy: create_league() / create_league_invite() mint codes.

-- ----------------------------------------------------------------------------
-- stages
-- ----------------------------------------------------------------------------
drop policy if exists "stages_select_member" on public.stages;
create policy "stages_select_member"
  on public.stages for select
  to authenticated
  using (public.is_league_member((select auth.uid()), league_id));

drop policy if exists "stages_write_commissioner" on public.stages;
create policy "stages_write_commissioner"
  on public.stages for all
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id))
  with check (public.is_league_commissioner((select auth.uid()), league_id));

-- ----------------------------------------------------------------------------
-- draft_order
-- ----------------------------------------------------------------------------
drop policy if exists "draft_order_select_member" on public.draft_order;
create policy "draft_order_select_member"
  on public.draft_order for select
  to authenticated
  using (public.is_league_member((select auth.uid()), league_id));

drop policy if exists "draft_order_write_commissioner" on public.draft_order;
create policy "draft_order_write_commissioner"
  on public.draft_order for all
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id))
  with check (public.is_league_commissioner((select auth.uid()), league_id));

-- ----------------------------------------------------------------------------
-- roster_picks
--
-- NOTE on the WITH CHECK expressions: league_id is filled in by the
-- set_league_id_from_stage() BEFORE trigger (0005). Postgres evaluates
-- BEFORE ROW triggers before RLS WITH CHECK, so by the time these policies
-- run the column holds the stage's real league — a client cannot smuggle in
-- a league_id it isn't a member of.
-- ----------------------------------------------------------------------------
drop policy if exists "roster_picks_select_member" on public.roster_picks;
create policy "roster_picks_select_member"
  on public.roster_picks for select
  to authenticated
  using (public.is_league_member((select auth.uid()), league_id));

drop policy if exists "roster_picks_insert_own_while_open" on public.roster_picks;
create policy "roster_picks_insert_own_while_open"
  on public.roster_picks for insert
  to authenticated
  with check (
    manager_id = (select auth.uid())
    and public.is_league_member((select auth.uid()), league_id)
    and exists (
      select 1 from public.stages
       where stages.id = roster_picks.stage_id
         and stages.status = 'draft_open'
    )
  );

drop policy if exists "roster_picks_delete_own_while_open" on public.roster_picks;
create policy "roster_picks_delete_own_while_open"
  on public.roster_picks for delete
  to authenticated
  using (
    manager_id = (select auth.uid())
    and exists (
      select 1 from public.stages
       where stages.id = roster_picks.stage_id
         and stages.status = 'draft_open'
    )
  );

-- Commissioners write any pick in any stage status — this is the deliberate
-- post-lock correction path (injury swaps, fixing a mis-drafted slot).
drop policy if exists "roster_picks_all_commissioner" on public.roster_picks;
create policy "roster_picks_all_commissioner"
  on public.roster_picks for all
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id))
  with check (public.is_league_commissioner((select auth.uid()), league_id));

-- ----------------------------------------------------------------------------
-- weekly_results
-- ----------------------------------------------------------------------------
drop policy if exists "weekly_results_select_member" on public.weekly_results;
create policy "weekly_results_select_member"
  on public.weekly_results for select
  to authenticated
  using (public.is_league_member((select auth.uid()), league_id));

drop policy if exists "weekly_results_write_commissioner" on public.weekly_results;
create policy "weekly_results_write_commissioner"
  on public.weekly_results for all
  to authenticated
  using (public.is_league_commissioner((select auth.uid()), league_id))
  with check (public.is_league_commissioner((select auth.uid()), league_id));

-- ============================================================================
-- GLOBAL NFL TABLES
--
-- Readable by any signed-in user: these are public sports facts, they carry
-- no league association, and every league needs them to render a draft board.
-- Writes have NO policy at all — the sync jobs use the service role, which
-- bypasses RLS. That is the whole authorization story for these tables, and
-- it means a compromised user session can never corrupt the shared data every
-- league on the instance depends on.
-- ============================================================================

drop policy if exists "players_select_authenticated" on public.players;
create policy "players_select_authenticated"
  on public.players for select to authenticated using (true);

drop policy if exists "nfl_games_select_authenticated" on public.nfl_games;
create policy "nfl_games_select_authenticated"
  on public.nfl_games for select to authenticated using (true);

drop policy if exists "nfl_week_stats_select_authenticated" on public.nfl_week_stats;
create policy "nfl_week_stats_select_authenticated"
  on public.nfl_week_stats for select to authenticated using (true);

drop policy if exists "sync_log_select_authenticated" on public.sync_log;
create policy "sync_log_select_authenticated"
  on public.sync_log for select to authenticated using (true);

-- The cooldown UI ("available again in 42m") needs to read this; writes go
-- only through claim_manual_sync() / release_manual_sync().
drop policy if exists "manual_sync_runs_select_authenticated" on public.manual_sync_runs;
create policy "manual_sync_runs_select_authenticated"
  on public.manual_sync_runs for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- push_subscriptions — owner only, all four verbs.
-- A push endpoint is a bearer URL: holding someone else's lets you send
-- notifications to their phone. No commissioner override, no league-wide read.
-- ----------------------------------------------------------------------------
drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own"
  on public.push_subscriptions for select
  to authenticated using (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_insert_own" on public.push_subscriptions;
create policy "push_subscriptions_insert_own"
  on public.push_subscriptions for insert
  to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_update_own" on public.push_subscriptions;
create policy "push_subscriptions_update_own"
  on public.push_subscriptions for update
  to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_delete_own" on public.push_subscriptions;
create policy "push_subscriptions_delete_own"
  on public.push_subscriptions for delete
  to authenticated using (user_id = (select auth.uid()));
