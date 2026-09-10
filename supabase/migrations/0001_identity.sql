-- ============================================================================
-- 0001_identity.sql
-- TD's Only (public) — accounts
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor.
-- Run 0001 .. 0007 in order, each as a single paste-and-run.
--
-- WHAT CHANGED FROM THE SINGLE-LEAGUE APP
-- ----------------------------------------------------------------------------
-- In tds-only-league, `profiles` carried the whole roles model:
-- is_commissioner, is_player and manager_slot (1-8). That only works when the
-- instance IS one league. Here one account can be a commissioner in one
-- league, a plain manager in another, and a spectator in a third, so all of
-- those columns move to `league_members` (0003_leagues.sql) and `profiles`
-- becomes pure identity: who you are, not what you can do.
--
-- The signup trigger shrinks to match. It no longer hands out seats — seats
-- are claimed per league by accept_invite() (0005_functions.sql).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles
-- One row per authenticated user, created by handle_new_user() below.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  email text,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per authenticated user. Identity only — per-league roles and seats live in league_members.';

-- ----------------------------------------------------------------------------
-- handle_new_user()
-- Fires after an auth.users insert (i.e. the first time someone authorizes
-- with Google) and creates their profiles row. The display-name fallback
-- chain covers both Google (full_name / name) and any future email signup
-- (display_name), ending at the email address.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      new.email
    ),
    new.email
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is
  'On auth.users insert: creates the profiles row. Seats/roles are per league — see accept_invite().';

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
