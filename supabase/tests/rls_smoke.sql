-- ============================================================================
-- rls_smoke.sql
-- TD's Only (public) — end-to-end check of the authorization model
--
-- Paste this whole file into the Supabase SQL editor and Run. It prints a
-- PASS/FAIL line per case and RAISES at the end if anything failed, so a green
-- run means green. It creates its own fixtures and deletes them again — the
-- database is left exactly as it was found.
--
-- RUN THIS ON A NON-PRODUCTION PROJECT, or at least one with no real leagues.
-- It creates and deletes auth users. It refuses to start if the database
-- already contains data (see the guard below) so it cannot eat a live league.
--
-- ---------------------------------------------------------------------------
-- THE GOTCHA THAT MAKES A TEST LIKE THIS LIE
-- ---------------------------------------------------------------------------
-- The SQL editor runs as a privileged role, which BYPASSES RLS entirely. A
-- test that forgets to switch roles passes vacuously and tells you nothing. So
-- every check below runs inside a function that does:
--
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
--
-- and case 0 asserts that auth.uid() actually reflects it. If case 0 fails,
-- ignore every other result on the page — they are all meaningless.
-- ============================================================================

-- Refuse to run against a database with real data in it.
do $$
begin
  if (select count(*) from public.leagues) > 0
     or (select count(*) from public.profiles) > 0 then
    raise exception
      'rls_smoke.sql refuses to run: this database already contains leagues or '
      'profiles. It creates and deletes users, so it must only run on an empty '
      'or throwaway project.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Fixtures: three accounts. The handle_new_user trigger mirrors each into
-- public.profiles, which case 1 verifies.
--   Alice — creates league "smoke-alpha", becomes its commissioner
--   Bob   — joins Alice's league by invite
--   Zoe   — creates a SECOND league, which Alice and Bob must never see
-- ----------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
values
  ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-4000-8000-000000000001',
   'authenticated','authenticated','smoke-alice@example.invalid','x',
   now(),now(),now(),'{"provider":"google"}','{"full_name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000000','bbbbbbbb-0000-4000-8000-000000000002',
   'authenticated','authenticated','smoke-bob@example.invalid','x',
   now(),now(),now(),'{"provider":"google"}','{"full_name":"Bob"}'),
  ('00000000-0000-0000-0000-000000000000','cccccccc-0000-4000-8000-000000000003',
   'authenticated','authenticated','smoke-zoe@example.invalid','x',
   now(),now(),now(),'{"provider":"google"}','{"full_name":"Zoe"}');

-- ----------------------------------------------------------------------------
-- The test body. Written as a function returning text so results come back as
-- a result set — `raise notice` output is invisible to some SQL clients.
-- ----------------------------------------------------------------------------
create or replace function public._rls_smoke() returns setof text
language plpgsql
as $fn$
declare
  alice constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  bob   constant uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  zoe   constant uuid := 'cccccccc-0000-4000-8000-000000000003';
  v_league uuid;
  v_zoe_league uuid;
  v_code text;
  v_seat smallint;
  v_seated boolean;
  n int;
  ok boolean;
begin
  ---------------------------------------------------------------------------
  -- 0. Impersonation actually works. Everything else depends on this.
  ---------------------------------------------------------------------------
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
    ok := auth.uid() = alice;
    reset role;
    return next case when ok
      then '0  PASS  impersonation works (auth.uid() reflects the JWT claim)'
      else '0  FAIL  auth.uid() DID NOT match — every result below is meaningless' end;
  end;

  ---------------------------------------------------------------------------
  -- 1. Signup trigger mirrors auth.users into profiles, with the OAuth name.
  ---------------------------------------------------------------------------
  select count(*) into n from public.profiles
   where id in (alice, bob, zoe) and display_name in ('Alice','Bob','Zoe');
  return next case when n = 3 then '1  PASS  handle_new_user created 3 profiles with OAuth names'
                   else '1  FAIL  expected 3 profiles, got ' || n end;

  ---------------------------------------------------------------------------
  -- 2. create_league is atomic: league + 22 stages + seated commissioner +
  --    an invite. This is the function that shipped broken once already
  --    (gen_random_bytes lives in the extensions schema, not public).
  ---------------------------------------------------------------------------
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
  select l.league_id, l.invite_code into v_league, v_code
    from public.create_league('Smoke Alpha', 'smoke-alpha') l;
  reset role;
  return next case when v_league is not null and v_code is not null
    then '2  PASS  create_league returned a league and an invite code'
    else '2  FAIL  create_league returned nulls' end;

  select count(*) into n from public.stages where league_id = v_league;
  return next case when n = 22 then '3  PASS  22 stages seeded'
                   else '3  FAIL  expected 22 stages, got ' || n end;

  select count(*) into n from public.stages
   where league_id = v_league and season_type = 'Regular Season';
  return next case when n = 18 then '4  PASS  18 regular-season stages addressed for Tank01'
                   else '4  FAIL  expected 18 addressed, got ' || n end;

  select count(*) into n from public.stages
   where league_id = v_league and season_type is null and week_num is null;
  return next case when n = 4
    then '5  PASS  4 postseason stages left unaddressed on purpose'
    else '5  FAIL  expected 4 unaddressed postseason stages, got ' || n end;

  select count(*) into n from public.league_members
   where league_id = v_league and user_id = alice
     and seat = 1 and is_player and is_commissioner and display_name = 'Alice';
  return next case when n = 1
    then '6  PASS  creator seated at 1 as commissioner, name copied from profile'
    else '6  FAIL  creator membership is wrong' end;

  ---------------------------------------------------------------------------
  -- 7. get_invite_preview must work for a NON-member — that is its whole
  --    reason for being security definer. Bob cannot read `leagues` at all.
  ---------------------------------------------------------------------------
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
  select count(*) into n from public.get_invite_preview(v_code) p
   where p.league_name = 'Smoke Alpha' and p.seats_taken = 1 and p.valid;
  reset role;
  return next case when n = 1 then '7  PASS  non-member can preview an invite'
                   else '7  FAIL  invite preview wrong for a non-member' end;

  ---------------------------------------------------------------------------
  -- 8/9. accept_invite seats Bob, and is idempotent (no double seat, no
  --      extra use burned).
  ---------------------------------------------------------------------------
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
  select a.seat, a.seated into v_seat, v_seated from public.accept_invite(v_code) a;
  reset role;
  return next case when v_seat = 2 and v_seated
    then '8  PASS  accept_invite claimed seat 2'
    else '8  FAIL  expected seat 2, got ' || coalesce(v_seat::text,'null') end;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
  select a.seat into v_seat from public.accept_invite(v_code) a;
  reset role;
  select uses into n from public.league_invites where code = v_code;
  return next case when v_seat = 2 and n = 1
    then '9  PASS  re-accepting is idempotent and does not burn a use'
    else '9  FAIL  seat=' || v_seat || ' uses=' || n || ' (expected 2 / 1)' end;

  ---------------------------------------------------------------------------
  -- A second, unrelated league. Everything from here is about isolation.
  ---------------------------------------------------------------------------
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
  select l.league_id into v_zoe_league
    from public.create_league('Zoe Private', 'smoke-zoe') l;
  reset role;

  ---------------------------------------------------------------------------
  -- 10-14. Alice must see her league and NOTHING of Zoe's — not even when
  --        naming Zoe's primary key directly.
  ---------------------------------------------------------------------------
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';

  select count(*) into n from public.leagues;
  return next case when n = 1 then '10 PASS  sees only her own league'
                   else '10 FAIL  sees ' || n || ' leagues' end;

  select count(*) into n from public.leagues where id = v_zoe_league;
  return next case when n = 0
    then '11 PASS  cannot read another league even by exact uuid'
    else '11 FAIL  LEAKED another league by uuid' end;

  select count(*) into n from public.stages;
  return next case when n = 22 then '12 PASS  sees 22 stages, not 44'
                   else '12 FAIL  sees ' || n || ' stages' end;

  select count(*) into n from public.league_members;
  return next case when n = 2 then '13 PASS  sees 2 members (hers), not Zoe''s'
                   else '13 FAIL  sees ' || n || ' members' end;

  -- profiles is owner-only: Alice shares a league with Bob and STILL must not
  -- read his row, because it carries his email address.
  select count(*) into n from public.profiles;
  return next case when n = 1
    then '14 PASS  profiles is owner-only (no email harvesting)'
    else '14 FAIL  can read ' || n || ' profiles' end;
  reset role;

  ---------------------------------------------------------------------------
  -- 15. Cross-league write must affect nothing.
  ---------------------------------------------------------------------------
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
    update public.stages set status = 'draft_open' where league_id = v_zoe_league;
    get diagnostics n = row_count;
    reset role;
    return next case when n = 0 then '15 PASS  cross-league stage write hit 0 rows'
                     else '15 FAIL  changed ' || n || ' rows in another league' end;
  exception when others then
    reset role;
    return next '15 PASS  cross-league stage write raised';
  end;

  ---------------------------------------------------------------------------
  -- 16-18. Privilege escalation via the "own row" UPDATE policy. A row-level
  --        WITH CHECK cannot stop a column change; guard_league_member_self_
  --        update() is what actually does.
  ---------------------------------------------------------------------------
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
    update public.league_members set is_commissioner = true where user_id = bob;
    reset role;
    return next '16 FAIL  member self-promoted to commissioner';
  exception when others then
    reset role;
    return next '16 PASS  self-promotion blocked';
  end;

  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
    update public.league_members set seat = 1 where user_id = bob;
    reset role;
    return next '17 FAIL  member took another seat';
  exception when others then
    reset role;
    return next '17 PASS  seat change blocked';
  end;

  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
    update public.league_members set display_name = 'Bobby' where user_id = bob;
    reset role;
    return next '18 PASS  but renaming yourself still works';
  exception when others then
    reset role;
    return next '18 FAIL  self-rename was blocked: ' || left(sqlerrm, 40);
  end;

  ---------------------------------------------------------------------------
  -- 19. Invite codes grant seats, so they are commissioner-only.
  ---------------------------------------------------------------------------
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
  select count(*) into n from public.league_invites;
  reset role;
  return next case when n = 0 then '19 PASS  non-commissioner sees no invite codes'
                   else '19 FAIL  LEAKED ' || n || ' invite codes' end;

  ---------------------------------------------------------------------------
  -- 20/21. REGRESSION TEST for a real hole. Postgres grants EXECUTE to PUBLIC
  --        on every new function and PostgREST publishes `public` at
  --        /rest/v1/rpc/<name>, so before the revoke sweep in 0005 every
  --        function here — including the security-definer writers — was
  --        callable with the anonymous key.
  ---------------------------------------------------------------------------
  begin
    set local role anon;
    perform public.seed_league_stages(v_league, 2026::smallint);
    reset role;
    return next '20 FAIL  anon executed seed_league_stages';
  exception when others then
    reset role;
    return next '20 PASS  anon denied seed_league_stages (' || sqlstate || ')';
  end;

  begin
    set local role anon;
    perform public.create_league('Hacked', 'smoke-hacked');
    reset role;
    return next '21 FAIL  anon executed create_league';
  exception when others then
    reset role;
    return next '21 PASS  anon denied create_league (' || sqlstate || ')';
  end;

  ---------------------------------------------------------------------------
  -- 22. A league whose last member disappears must be reaped, not left as an
  --     invisible row squatting on a UNIQUE slug forever. The reachable path
  --     is account deletion, which is what this simulates.
  ---------------------------------------------------------------------------
  delete from public.league_members where league_id = v_zoe_league;
  select count(*) into n from public.leagues where id = v_zoe_league;
  return next case when n = 0
    then '22 PASS  league reaped when its last member left'
    else '22 FAIL  orphaned league survived, squatting on its slug' end;
end
$fn$;

-- ----------------------------------------------------------------------------
-- Run it, then fail loudly if any case did not pass.
-- ----------------------------------------------------------------------------
-- Run ONCE into a temp table. Calling _rls_smoke() a second time would not
-- just be slow — it would fail, because the first run already created
-- 'smoke-alpha' and slugs are unique.
create temp table smoke_results as select line from public._rls_smoke() as t(line);

select line as result from smoke_results;

do $$
declare failures int;
begin
  select count(*) into failures from smoke_results where line like '%FAIL%';
  if failures > 0 then
    raise exception '% smoke check(s) FAILED — see the result set above.', failures;
  end if;
  raise notice 'All RLS smoke checks passed.';
end $$;

drop table smoke_results;

-- ----------------------------------------------------------------------------
-- Teardown. auth.users cascades to profiles -> league_members, and the reaper
-- trigger takes the leagues (and their stages/picks) with them.
-- ----------------------------------------------------------------------------
drop function if exists public._rls_smoke();

delete from public.leagues where slug in ('smoke-alpha','smoke-zoe','smoke-hacked');
delete from auth.users where email like 'smoke-%@example.invalid';

-- Should be all zeros.
select
  (select count(*) from auth.users)            as auth_users,
  (select count(*) from public.profiles)       as profiles,
  (select count(*) from public.leagues)        as leagues,
  (select count(*) from public.league_members) as members,
  (select count(*) from public.league_invites) as invites,
  (select count(*) from public.stages)         as stages;
