-- ============================================================================
-- 0009_league_size.sql
-- TD's Only (public) — league size becomes a per-league setting (6-10)
--
-- Run AFTER 0007_realtime.sql. Additive and safe on a live database: existing
-- leagues take size 8, which is what they were created under.
--
-- WHY 6-10 AND NOT "WHATEVER YOU LIKE"
-- ----------------------------------------------------------------------------
-- The ceiling is quarterbacks, and it is specific to this game. Rosters carry
-- TWO QBs and the player pool is EXCLUSIVE per stage — one quarterback sits on
-- exactly one roster league-wide. There are 32 NFL starters, and in a bye week
-- 4-6 teams are off, so roughly 26 are actually startable:
--
--     managers x 2 QBs   vs ~26 startable QBs in a bye week
--       8  ->  16        comfortable
--      10  ->  20        tight; the last picks get poor starters
--      12  ->  24        ~92% of the pool gone, late picks draft backups
--      14  ->  28        impossible
--
-- No other position comes close to binding (TE is one per roster, so 32
-- managers would be fine). It is the 2-QB rule alone that caps this, which is
-- why the ceiling is 10 rather than the 12 or 14 a normal redraft league runs.
--
-- The floor is 6 because the exclusive pool is the entire point of the game.
-- With fewer managers nothing meaningful is ever unavailable, and the
-- "last place drafts first" swing stops mattering.
--
-- The other real cost is draft LENGTH, which is what actually kills leagues:
-- this is a live draft EVERY week. 8 x 7 = 56 picks; 10 x 7 = 70. At roughly
-- half a minute a pick that is 28 minutes versus 35, every week, with everyone
-- present.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The column. Existing rows take 8 — the size they were created under.
-- ----------------------------------------------------------------------------
alter table public.leagues
  add column if not exists size smallint not null default 8;

alter table public.leagues drop constraint if exists leagues_size_range;
alter table public.leagues add constraint leagues_size_range
  check (size between 6 and 10);

comment on column public.leagues.size is
  'Managers in this league, 6-10. Capped at 10 by the 2-QB roster against a ~26-QB bye-week pool — see this migration''s header.';

-- ----------------------------------------------------------------------------
-- 2. Widen the two CHECKs that hardcoded 8.
--
-- These become the ABSOLUTE bounds (the widest any league may be); the exact
-- per-league bound is enforced by trigger below, because a CHECK constraint
-- cannot reference another table.
-- ----------------------------------------------------------------------------
alter table public.league_members drop constraint if exists league_members_seat_check;
alter table public.league_members add constraint league_members_seat_check
  check (seat is null or seat between 1 and 10);

-- 10 managers x ROSTER_SIZE 7 = 70.
alter table public.draft_order drop constraint if exists draft_order_pick_number_check;
alter table public.draft_order add constraint draft_order_pick_number_check
  check (pick_number between 1 and 70);

comment on table public.draft_order is
  'Snake draft order per stage (league size x 7 rounds; at most 70 picks). league_id is set by trigger from stage_id.';

-- ----------------------------------------------------------------------------
-- 3. The exact per-league seat bound.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_seat_within_league_size()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size smallint;
begin
  if new.seat is null then
    return new;
  end if;

  select size into v_size from public.leagues where id = new.league_id;
  if v_size is null then
    raise exception 'league % does not exist', new.league_id using errcode = '23503';
  end if;

  if new.seat > v_size then
    raise exception
      'Seat % does not exist in this league — it has % seats.', new.seat, v_size
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_seat_within_league_size is
  'Enforces seat <= leagues.size. A CHECK constraint cannot reference another table, so this is the real bound; the CHECK on the column is only the absolute maximum.';

drop trigger if exists league_members_seat_within_size on public.league_members;
create trigger league_members_seat_within_size
  before insert or update on public.league_members
  for each row execute function public.enforce_seat_within_league_size();

-- ----------------------------------------------------------------------------
-- 4. Shrinking a league must not strand a seated manager.
--
-- Without this, a commissioner dropping from 10 to 6 would leave seats 7-10
-- occupied but out of range — rows that violate a rule nothing re-checks, and
-- that the draft would then build a short order around.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_size_fits_seated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_highest smallint;
begin
  if new.size >= old.size then
    return new;
  end if;

  select max(seat) into v_highest
    from public.league_members
   where league_id = new.id and seat is not null;

  if v_highest is not null and v_highest > new.size then
    raise exception
      'Cannot shrink to % seats: seat % is still taken. Move or remove that manager first.',
      new.size, v_highest
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists leagues_size_fits_seated on public.leagues;
create trigger leagues_size_fits_seated
  before update of size on public.leagues
  for each row execute function public.enforce_size_fits_seated();

-- ----------------------------------------------------------------------------
-- 5. create_league takes a size.
--
-- The 3-argument version has to be DROPPED, not replaced: adding a parameter
-- makes a new overload, and a 3-argument call would then be ambiguous rather
-- than resolving to either one.
-- ----------------------------------------------------------------------------
drop function if exists public.create_league(text, text, smallint);

create or replace function public.create_league(
  p_name text,
  p_slug text,
  p_season smallint default null,
  p_size smallint default 8
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
  v_size smallint := coalesce(p_size, 8);
  v_code text := public.random_invite_code();
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a league.'
      using errcode = '42501';
  end if;

  insert into public.leagues (slug, name, season, size, created_by)
  values (lower(trim(p_slug)), trim(p_name), v_season, v_size, v_uid)
  returning id into v_league_id;

  perform public.seed_league_stages(v_league_id, v_season);

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
  'Creates a league at the given size, seeds its stages, seats the creator as commissioner, and mints a first invite — atomically.';

-- ----------------------------------------------------------------------------
-- 6. accept_invite claims against the league's real size, not a literal 8.
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

  perform pg_advisory_xact_lock(hashtext('league_seat:' || v_invite.league_id::text));

  -- generate_series over the LEAGUE'S size. This is the line that used to be
  -- a literal 8 and is the whole reason a 6-person league could previously
  -- seat a seventh manager.
  select min(s.n)::smallint into v_seat
    from generate_series(1, v_league.size) as s(n)
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

-- ----------------------------------------------------------------------------
-- 7. The invite preview reports the league's real seat count.
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
           v_league.size::int,
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

-- ----------------------------------------------------------------------------
-- 8. Re-apply the grant discipline from 0005. A newly created function (the
--    4-arg create_league) gets EXECUTE to PUBLIC by default, and PostgREST
--    publishes `public` — so without this it would be anon-callable.
-- ----------------------------------------------------------------------------
revoke execute on function public.create_league(text, text, smallint, smallint) from public, anon;
revoke execute on function public.accept_invite(text) from public, anon;
revoke execute on function public.get_invite_preview(text) from public, anon;
revoke execute on function public.enforce_seat_within_league_size() from public, anon, authenticated;
revoke execute on function public.enforce_size_fits_seated() from public, anon, authenticated;

grant execute on function public.create_league(text, text, smallint, smallint) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.get_invite_preview(text) to authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   select slug, name, size from public.leagues order by created_at;
-- Existing leagues should read 8.
-- ----------------------------------------------------------------------------
