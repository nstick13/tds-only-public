-- ============================================================================
-- 0007_realtime.sql
-- TD's Only (public) — live draft updates
--
-- Run AFTER 0006_rls.sql. This is the last migration.
--
-- Supabase only streams Postgres Changes for tables in the `supabase_realtime`
-- publication, and that publication is EMPTY on a fresh project. Without this
-- file every client subscribes correctly to its draft channel and then sits
-- there hearing nothing — a silent failure that looks like an app bug.
--
-- REPLICA IDENTITY FULL — required, not a nicety
-- ----------------------------------------------------------------------------
-- Subscriptions filter by `stage_id=eq.<uuid>` so two drafts never cross-talk.
-- Postgres puts only the PRIMARY KEY in a DELETE's old record by default, so a
-- delete event would carry no stage_id, fail the filter, and vanish — meaning
-- an undone pick (or a commissioner replacement, which deletes the old row)
-- would never reach anyone else's screen while ordinary picks did. `replica
-- identity full` puts the whole old row in the WAL so deletes match the filter
-- like everything else. These tables hold at most 56 rows per stage, so the
-- extra WAL volume is irrelevant.
--
-- RLS still applies to realtime: a subscriber receives only rows their own
-- SELECT policies would let them read. Since 0006 scopes both tables to league
-- members, a stage_id from another league yields an empty stream rather than a
-- leak — the filter is for tidiness, the policy is the security.
-- ============================================================================

alter table public.roster_picks replica identity full;
alter table public.draft_order  replica identity full;

-- Idempotent: adding a table already in the publication raises an error.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'roster_picks'
  ) then
    alter publication supabase_realtime add table public.roster_picks;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'draft_order'
  ) then
    alter publication supabase_realtime add table public.draft_order;
  end if;
end $$;
