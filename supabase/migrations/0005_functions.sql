-- ============================================================================
-- 0005_functions.sql
-- TD's Only (public) — functions & triggers
--
-- Run AFTER 0004_league_tables.sql. 0006_rls.sql depends on the authorization
-- helpers defined here, so this file must go first.
-- ============================================================================

-- ============================================================================
-- SECTION 1 — authorization helpers
--
-- Both are `security definer` so an RLS policy can ask "is this user a member
-- of league X" without the user needing a SELECT policy on league_members
-- that would itself have to consult league_members. Without this you get
-- infinite policy recursion; with it, the check runs once as the definer.
-- ============================================================================

create or replace function public.is_league_member(uid uuid, lid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.league_members
     where user_id = uid and league_id = lid
  );
$$;

comment on function public.is_league_member is
  'RLS helper: true if uid holds any membership row in league lid.';

create or replace function public.is_league_commissioner(uid uuid, lid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.league_members
     where user_id = uid and league_id = lid and is_commissioner
  );
$$;

comment on function public.is_league_commissioner is
  'RLS helper: true if uid is a commissioner of league lid.';

-- Used only to gate the instance-wide manual sync buttons: the Tank01 budget
-- is a shared resource, so "commissioner of at least one league" is the bar.
create or replace function public.is_any_league_commissioner(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.league_members
     where user_id = uid and is_commissioner
  );
$$;

comment on function public.is_any_league_commissioner is
  'True if uid commissions any league. Gates the instance-wide manual sync trigger.';

-- ============================================================================
-- SECTION 2 — keeping the denormalized league_id honest
--
-- draft_order / roster_picks / weekly_results carry league_id purely so RLS
-- can read it off the row (see 0004's header). Application code never sets
-- it: this trigger derives it from stage_id on every insert and update, so
-- the copy cannot drift or be spoofed by a client sending a league_id that
-- isn't the stage's.
-- ============================================================================

create or replace function public.set_league_id_from_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
begin
  select league_id into v_league_id
    from public.stages
   where id = new.stage_id;

  if v_league_id is null then
    raise exception 'stage % does not exist', new.stage_id
      using errcode = '23503';
  end if;

  new.league_id := v_league_id;
  return new;
end;
$$;

comment on function public.set_league_id_from_stage is
  'BEFORE INSERT/UPDATE trigger: derives league_id from stage_id so the denormalized copy can never drift or be spoofed.';

drop trigger if exists draft_order_set_league on public.draft_order;
create trigger draft_order_set_league
  before insert or update on public.draft_order
  for each row execute function public.set_league_id_from_stage();

drop trigger if exists roster_picks_set_league on public.roster_picks;
create trigger roster_picks_set_league
  before insert or update on public.roster_picks
  for each row execute function public.set_league_id_from_stage();

drop trigger if exists weekly_results_set_league on public.weekly_results;
create trigger weekly_results_set_league
  before insert or update on public.weekly_results
  for each row execute function public.set_league_id_from_stage();

-- ============================================================================
-- SECTION 3 — roster shape
--
-- QB2 / RB2 / WR2 / TE1, 7 total, per manager per stage. Mirrors
-- src/lib/roster.ts ROSTER_SHAPE — if one changes, change both (and the
-- draft_order.pick_number CHECK, which does not follow automatically).
-- ============================================================================

create or replace function public.enforce_roster_limits()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  position_cap smallint;
  position_count int;
  total_count int;
  roster_total constant int := 7;
begin
  position_cap := case new.slot_position
    when 'QB' then 2
    when 'RB' then 2
    when 'WR' then 2
    when 'TE' then 1
    else null
  end;

  if position_cap is null then
    raise exception 'Unknown slot_position %', new.slot_position;
  end if;

  select count(*) into position_count
    from public.roster_picks
   where stage_id = new.stage_id
     and manager_id = new.manager_id
     and slot_position = new.slot_position;

  if position_count >= position_cap then
    raise exception
      'Roster limit exceeded: manager % already has % % pick(s) for stage % (cap %)',
      new.manager_id, position_count, new.slot_position, new.stage_id, position_cap;
  end if;

  select count(*) into total_count
    from public.roster_picks
   where stage_id = new.stage_id
     and manager_id = new.manager_id;

  if total_count >= roster_total then
    raise exception
      'Roster limit exceeded: manager % already holds % players for stage %',
      new.manager_id, roster_total, new.stage_id;
  end if;

  return new;
end;
$$;

comment on function public.enforce_roster_limits is
  'BEFORE INSERT on roster_picks: enforces QB2/RB2/WR2/TE1 and a 7-player total per manager per stage. Mirrors src/lib/roster.ts.';

drop trigger if exists roster_picks_enforce_limits on public.roster_picks;
create trigger roster_picks_enforce_limits
  before insert on public.roster_picks
  for each row execute function public.enforce_roster_limits();

-- ============================================================================
-- SECTION 4 — league lifecycle
-- ============================================================================

-- ----------------------------------------------------------------------------
-- current_nfl_season()
-- A season is named for the calendar year it STARTS in, so January's playoffs
-- still belong to the previous year's number. Mirrors currentSeason() in the
-- sync jobs — both have to agree or a league seeded in January would ask
-- Tank01 for the wrong year.
-- ----------------------------------------------------------------------------
-- STABLE, not IMMUTABLE: the body reads now(). An immutable function is a
-- promise to the planner that it can be constant-folded and cached, which for
-- a clock-reading body is a lie that eventually returns last year's season.
create or replace function public.current_nfl_season()
returns smallint
language sql
stable
set search_path = public
as $$
  select case
    when extract(month from now() at time zone 'utc') <= 6
      then extract(year from now() at time zone 'utc') - 1
    else extract(year from now() at time zone 'utc')
  end::smallint;
$$;

-- ----------------------------------------------------------------------------
-- seed_league_stages(league_id, season)
-- Writes the 22 stage rows for a new league. Weeks 1-18 are addressed to
-- Tank01's "Regular Season"; the four postseason rounds ship unaddressed on
-- purpose (see 0004's stages header).
-- Safe to re-run: on conflict does nothing.
-- ----------------------------------------------------------------------------
create or replace function public.seed_league_stages(p_league_id uuid, p_season smallint)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.stages (league_id, name, ordinal, season, season_type, week_num)
  select p_league_id,
         'Week ' || n,
         n::smallint,
         p_season,
         'Regular Season',
         n::smallint
    from generate_series(1, 18) as n
  union all
  select p_league_id, v.name, v.ordinal, p_season, null, null
    from (values
      ('Wild Card Round', 19::smallint),
      ('Divisional Round', 20::smallint),
      ('Conference Championships', 21::smallint),
      ('Super Bowl', 22::smallint)
    ) as v(name, ordinal)
  on conflict (league_id, ordinal) do nothing;
$$;

comment on function public.seed_league_stages is
  'Seeds a league''s 22 stages. Postseason rows are deliberately left unaddressed for Tank01.';

-- ----------------------------------------------------------------------------
-- random_invite_code()
-- 16 URL-safe characters from gen_random_bytes. Not sequential and not
-- guessable: an invite code IS the credential for joining a league.
--
-- gen_random_bytes() comes from pgcrypto, which on Supabase lives in the
-- `extensions` schema, NOT in public. Every caller of this function is
-- `set search_path = public`, and a function with no search_path of its own
-- inherits the caller's — so an unqualified gen_random_bytes() resolves to
-- nothing and create_league() dies with 42883. Qualify it and pin the
-- search_path here.
-- ----------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create or replace function public.random_invite_code()
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select translate(
    encode(extensions.gen_random_bytes(12), 'base64'),
    '+/=',
    '-_'
  );
$$;

-- ----------------------------------------------------------------------------
-- create_league(name, slug, season)
--
-- One transaction: the league row, its 22 stages, the creator's commissioner
-- membership in seat 1, and a first invite code. Doing it here rather than as
-- four calls from the server action means a half-created league — a row with
-- no stages, or a league nobody can administer — is not a reachable state.
--
-- Raises 23505 on a taken slug so the caller can retry with a suffix.
-- ----------------------------------------------------------------------------
create or replace function public.create_league(
  p_name text,
  p_slug text,
  p_season smallint default null
)
returns table (league_id uuid, slug text, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_league_id uuid;
  v_season smallint := coalesce(p_season, public.current_nfl_season());
  v_code text := public.random_invite_code();
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a league.'
      using errcode = '42501';
  end if;

  insert into public.leagues (slug, name, season, created_by)
  values (lower(trim(p_slug)), trim(p_name), v_season, v_uid)
  returning id into v_league_id;

  perform public.seed_league_stages(v_league_id, v_season);

  -- The creator is commissioner AND takes seat 1. A league whose only member
  -- cannot administer it would need a support ticket to fix, and there is no
  -- support.
  --
  -- display_name is COPIED from the profile rather than joined at read time:
  -- profiles are readable only by their owner (see 0006_rls.sql), so this is
  -- what lets leaguemates see each other's names without exposing email
  -- addresses across every league on the instance.
  insert into public.league_members
    (league_id, user_id, seat, is_player, is_commissioner, display_name)
  values (
    v_league_id, v_uid, 1, true, true,
    (select display_name from public.profiles where id = v_uid)
  );

  insert into public.league_invites (code, league_id, created_by, expires_at)
  values (v_code, v_league_id, v_uid, now() + interval '7 days');

  return query select v_league_id, lower(trim(p_slug)), v_code;
end;
$$;

comment on function public.create_league is
  'Creates a league, seeds its stages, seats the creator as commissioner, and mints a first invite — atomically.';

-- ----------------------------------------------------------------------------
-- create_league_invite(league_id, expires_in_days, max_uses)
-- Mints an additional invite. Commissioner only.
-- ----------------------------------------------------------------------------
create or replace function public.create_league_invite(
  p_league_id uuid,
  p_expires_in_days int default 7,
  p_max_uses smallint default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.random_invite_code();
begin
  if not public.is_league_commissioner(v_uid, p_league_id) then
    raise exception 'Commissioner access required to create an invite.'
      using errcode = '42501';
  end if;

  insert into public.league_invites (code, league_id, created_by, expires_at, max_uses)
  values (
    v_code,
    p_league_id,
    v_uid,
    case when p_expires_in_days is null then null
         else now() + make_interval(days => p_expires_in_days) end,
    p_max_uses
  );

  return v_code;
end;
$$;

-- ----------------------------------------------------------------------------
-- get_invite_preview(code)
--
-- What /join/<code> shows BEFORE someone commits to joining: the league's
-- name, how many seats are left, and whether the link is still good.
--
-- security definer because the viewer is by definition not a member yet, and
-- `leagues` is readable only by members. This deliberately exposes nothing but
-- the league name and a seat count — not the roster, not who is in it.
-- Returns no rows for an unknown code, so a wrong link can't be told apart
-- from a revoked one by anything but the message we choose to show.
-- ----------------------------------------------------------------------------
create or replace function public.get_invite_preview(p_code text)
returns table (
  league_name text,
  season smallint,
  seats_taken int,
  seats_total int,
  valid boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.league_invites%rowtype;
  v_league public.leagues%rowtype;
  v_taken int;
begin
  select * into v_invite from public.league_invites where code = p_code;
  if v_invite.code is null then
    return;
  end if;

  select * into v_league from public.leagues where id = v_invite.league_id;

  select count(*) into v_taken
    from public.league_members
   where league_id = v_invite.league_id and seat is not null;

  return query
    select v_league.name,
           v_league.season,
           v_taken,
           8,
           case
             when v_invite.revoked_at is not null then false
             when v_invite.expires_at is not null and v_invite.expires_at < now() then false
             when v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses then false
             else true
           end,
           case
             when v_invite.revoked_at is not null then 'revoked'
             when v_invite.expires_at is not null and v_invite.expires_at < now() then 'expired'
             when v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses then 'used_up'
             else null
           end;
end;
$$;

comment on function public.get_invite_preview is
  'Public-facing invite preview for /join/<code>. Exposes only the league name and seat count.';

-- ----------------------------------------------------------------------------
-- accept_invite(code)
--
-- Redeems an invite: validates it, claims the lowest free seat (1..8), and
-- writes the membership row. This is the ONLY path into league_members for a
-- normal user — there is no client INSERT policy on that table.
--
-- Returns `seated = false` when all 8 seats are taken: the person still joins
-- and can watch, and a commissioner can hand them a seat later. Bouncing them
-- with an error would be worse — they clicked a link they were given.
--
-- Idempotent: re-accepting when already a member returns the existing
-- membership without consuming a use.
-- ----------------------------------------------------------------------------
create or replace function public.accept_invite(p_code text)
returns table (league_id uuid, slug text, seat smallint, seated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.league_invites%rowtype;
  v_league public.leagues%rowtype;
  v_existing public.league_members%rowtype;
  v_seat smallint;
begin
  if v_uid is null then
    raise exception 'You must be signed in to join a league.'
      using errcode = '42501';
  end if;

  select * into v_invite from public.league_invites where code = p_code;
  if v_invite.code is null then
    raise exception 'That invite link is not valid.' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'That invite link has been revoked.' using errcode = '42501';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at < now() then
    raise exception 'That invite link has expired.' using errcode = '42501';
  end if;

  select * into v_league from public.leagues where id = v_invite.league_id;

  -- Already in? Hand back what they already have, don't burn a use.
  -- NOTE: alias + qualify. This function's OUT parameters include `league_id`
  -- and `seat`, so an unqualified column of the same name inside the body is
  -- ambiguous between the PL/pgSQL variable and the table column (42702).
  select * into v_existing
    from public.league_members lm
   where lm.league_id = v_invite.league_id and lm.user_id = v_uid;

  if v_existing.user_id is not null then
    return query
      select v_league.id, v_league.slug, v_existing.seat, v_existing.seat is not null;
    return;
  end if;

  if v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses then
    raise exception 'That invite link has already been used the maximum number of times.'
      using errcode = '42501';
  end if;

  -- Serialize seat claims for this league: two people opening the same link
  -- in the same second must not both be handed seat 4.
  perform pg_advisory_xact_lock(hashtext('league_seat:' || v_invite.league_id::text));

  select min(s.n)::smallint into v_seat
    from generate_series(1, 8) as s(n)
   where s.n not in (
     select lm.seat from public.league_members lm
      where lm.league_id = v_invite.league_id and lm.seat is not null
   );

  insert into public.league_members
    (league_id, user_id, seat, is_player, is_commissioner, display_name)
  values (
    v_invite.league_id, v_uid, v_seat, v_seat is not null, false,
    (select display_name from public.profiles where id = v_uid)
  );

  update public.league_invites
     set uses = uses + 1
   where code = p_code;

  return query select v_league.id, v_league.slug, v_seat, v_seat is not null;
end;
$$;

comment on function public.accept_invite is
  'Redeems an invite and claims the lowest free seat. The only path into league_members for a normal user.';

-- ----------------------------------------------------------------------------
-- leave_league(league_id)
-- Lets a member remove themselves, freeing their seat. The last commissioner
-- cannot leave — a league with no commissioner is unadministrable.
-- ----------------------------------------------------------------------------
create or replace function public.leave_league(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_commish boolean;
  v_other_commishes int;
begin
  select is_commissioner into v_is_commish
    from public.league_members
   where league_id = p_league_id and user_id = v_uid;

  if v_is_commish is null then
    raise exception 'You are not a member of that league.' using errcode = 'P0002';
  end if;

  if v_is_commish then
    select count(*) into v_other_commishes
      from public.league_members
     where league_id = p_league_id and is_commissioner and user_id <> v_uid;

    if v_other_commishes = 0 then
      raise exception
        'You are the only commissioner — promote someone else before leaving.'
        using errcode = '42501';
    end if;
  end if;

  delete from public.league_members
   where league_id = p_league_id and user_id = v_uid;
end;
$$;

-- ----------------------------------------------------------------------------
-- delete_league_when_last_member_leaves()
--
-- A league with no members is unreachable: every policy on it requires
-- membership, so nobody can see it, nobody can administer it, and nobody can
-- delete it — but its row still holds its slug, which is UNIQUE, so that name
-- is burned for good. This trigger reaps it.
--
-- Normal play cannot reach zero members: leave_league() refuses to strand a
-- league without a commissioner, and the commissioner DELETE policy on
-- league_members forbids removing yourself. The reachable path is ACCOUNT
-- DELETION — a user row goes away, profiles cascades, league_members cascades,
-- and if that person was the last member the league is orphaned. That is
-- exactly when this fires.
--
-- No recursion risk: deleting the league cascades back into league_members,
-- but by then there are no rows left there to fire this again.
-- ----------------------------------------------------------------------------
create or replace function public.delete_league_when_last_member_leaves()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.leagues l
   where l.id = old.league_id
     and not exists (
       select 1 from public.league_members m where m.league_id = l.id
     );
  return null;
end;
$$;

comment on function public.delete_league_when_last_member_leaves is
  'Reaps a league once its last member is gone — otherwise it is invisible, unadministrable and squatting on a unique slug forever.';

drop trigger if exists league_members_reap_empty_league on public.league_members;
create trigger league_members_reap_empty_league
  after delete on public.league_members
  for each row execute function public.delete_league_when_last_member_leaves();

-- ============================================================================
-- SECTION 5 — commissioner roster repair
-- ============================================================================

-- ----------------------------------------------------------------------------
-- replace_roster_pick(stage_id, out_player_id, in_player_id)
--
-- Swaps an already-drafted player for another in one transaction, preserving
-- the original manager, slot AND pick_number. The two-statement version
-- (delete then insert) could leave a manager a player short when the insert
-- was rejected, and dropped pick_number on the floor.
--
-- Position is deliberately not swappable: rosters are a fixed shape, so a
-- slot keeps its position. Restructuring a roster is remove-then-add.
-- ----------------------------------------------------------------------------
create or replace function public.replace_roster_pick(
  p_stage_id uuid,
  p_out_player_id text,
  p_in_player_id text
)
returns table (
  manager_id uuid,
  slot_position text,
  pick_number smallint,
  out_player_name text,
  in_player_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_league_id uuid;
  v_pick public.roster_picks%rowtype;
  v_in public.players%rowtype;
  v_out_name text;
begin
  select league_id into v_league_id from public.stages where id = p_stage_id;
  if v_league_id is null then
    raise exception 'Stage not found.' using errcode = 'P0002';
  end if;

  if not public.is_league_commissioner(v_uid, v_league_id) then
    raise exception 'Commissioner access required to replace a pick.'
      using errcode = '42501';
  end if;

  if p_out_player_id = p_in_player_id then
    raise exception 'The replacement is the same player already in that slot.'
      using errcode = '22023';
  end if;

  -- FOR UPDATE: two commissioners replacing the same pick at once must not
  -- both succeed.
  select * into v_pick
    from public.roster_picks
   where stage_id = p_stage_id and player_id = p_out_player_id
   for update;

  if v_pick.id is null then
    raise exception 'That player is not on a roster in this stage — nothing to replace.'
      using errcode = 'P0002';
  end if;

  select * into v_in from public.players where id = p_in_player_id;
  if v_in.id is null then
    raise exception 'Replacement player not found.' using errcode = 'P0002';
  end if;

  if v_in.position is distinct from v_pick.slot_position then
    raise exception
      'Slot mismatch: that slot is %, but % is a %. Rosters are a fixed shape, so a slot keeps its position.',
      v_pick.slot_position, v_in.name, v_in.position
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.roster_picks
     where stage_id = p_stage_id and player_id = p_in_player_id
  ) then
    raise exception '% is already on a roster in this stage.', v_in.name
      using errcode = '23505';
  end if;

  select name into v_out_name from public.players where id = p_out_player_id;

  delete from public.roster_picks where id = v_pick.id;

  insert into public.roster_picks
    (stage_id, manager_id, player_id, slot_position, pick_number)
  values
    (v_pick.stage_id, v_pick.manager_id, p_in_player_id, v_pick.slot_position,
     v_pick.pick_number);

  return query
    select v_pick.manager_id,
           v_pick.slot_position,
           v_pick.pick_number,
           coalesce(v_out_name, p_out_player_id),
           v_in.name;
end;
$$;

-- ============================================================================
-- SECTION 6 — manual sync cooldown (instance-wide)
-- ============================================================================

create or replace function public.manual_sync_cooldown()
returns interval
language sql
immutable
set search_path = public
as $$
  select interval '1 hour';
$$;

-- ----------------------------------------------------------------------------
-- claim_manual_sync(source)
-- Atomically claims the instance's next manual sync slot for one source.
-- Returns claimed=false rather than raising when the window is still running,
-- so the UI can say "available again in Xm" instead of showing an error.
-- ----------------------------------------------------------------------------
create or replace function public.claim_manual_sync(p_source text)
returns table (
  claimed boolean,
  run_id bigint,
  available_at timestamptz,
  blocked_by text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_last public.manual_sync_runs%rowtype;
  v_new_id bigint;
begin
  if not public.is_any_league_commissioner(v_uid) then
    raise exception 'Commissioner access required to trigger a sync.'
      using errcode = '42501';
  end if;

  if p_source is null or p_source not in ('players', 'schedule', 'scores', 'locks') then
    raise exception 'Unknown sync source: %', coalesce(p_source, '<null>')
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('manual_sync_cooldown:' || p_source));

  select * into v_last
    from public.manual_sync_runs
   where source = p_source
   order by triggered_at desc
   limit 1;

  if v_last.id is not null
     and v_last.triggered_at > now() - public.manual_sync_cooldown() then
    return query
      select false,
             null::bigint,
             v_last.triggered_at + public.manual_sync_cooldown(),
             (select display_name from public.profiles where id = v_last.triggered_by);
    return;
  end if;

  insert into public.manual_sync_runs (source, triggered_by)
  values (p_source, v_uid)
  returning id into v_new_id;

  return query select true, v_new_id, now() + public.manual_sync_cooldown(), null::text;
end;
$$;

-- ----------------------------------------------------------------------------
-- release_manual_sync(run_id)
-- Undoes a claim whose sync call never went through, so a failed trigger does
-- not cost an hour. Limited to the caller's own newest claim for that source.
-- ----------------------------------------------------------------------------
create or replace function public.release_manual_sync(p_run_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  delete from public.manual_sync_runs m
   where m.id = p_run_id
     and m.triggered_by = v_uid
     and m.id = (
       select max(id) from public.manual_sync_runs where source = m.source
     );
end;
$$;

-- ============================================================================
-- SECTION 7 — grants
--
-- REVOKE FIRST. Postgres grants EXECUTE to PUBLIC on every new function, and
-- PostgREST exposes everything in `public` at /rest/v1/rpc/<name>. Granting to
-- `authenticated` without revoking PUBLIC therefore leaves every function on
-- this list — plus the ones NOT on it — callable by the anonymous key.
--
-- That is not theoretical here: seed_league_stages() is `security definer` and
-- writes stage rows for an arbitrary league_id, and the trigger functions
-- (set_league_id_from_stage, handle_new_user) are definer writers too. All of
-- them were reachable at /rest/v1/rpc/... by anon before this revoke.
--
-- Trigger functions need no grant at all: Postgres checks EXECUTE on a trigger
-- function when the trigger is CREATED, not when it fires.
-- ============================================================================

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

-- The RLS helpers are not part of the RPC surface, but policy expressions are
-- evaluated as the querying role, so `authenticated` must be able to run them.
grant execute on function public.is_league_member(uuid, uuid) to authenticated;
grant execute on function public.is_league_commissioner(uuid, uuid) to authenticated;
grant execute on function public.is_any_league_commissioner(uuid) to authenticated;

-- Every function a signed-in user is meant to call directly via RPC.
grant execute on function public.create_league(text, text, smallint) to authenticated;
grant execute on function public.create_league_invite(uuid, int, smallint) to authenticated;
grant execute on function public.get_invite_preview(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.leave_league(uuid) to authenticated;
grant execute on function public.replace_roster_pick(uuid, text, text) to authenticated;
grant execute on function public.claim_manual_sync(text) to authenticated;
grant execute on function public.release_manual_sync(bigint) to authenticated;
grant execute on function public.manual_sync_cooldown() to authenticated;
grant execute on function public.current_nfl_season() to authenticated;
