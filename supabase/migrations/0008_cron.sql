-- ============================================================================
-- 0008_cron.sql
-- TD's Only (public) — schedule the sync jobs from Postgres
--
-- OPTIONAL. Everything else works without this; the app just never refreshes
-- its data on its own. Run it once your app is deployed and you know its URL.
--
-- WHAT THIS DOES
-- ----------------------------------------------------------------------------
-- Schedules periodic HTTP POSTs (via pg_net) to the four sync routes in
-- src/app/api/cron/, each carrying the Bearer token those routes require:
--
--   sync-players   every 6 hours    player pool + injury status
--   sync-schedule  every 12 hours   nfl_games kickoffs + nfl_team_byes
--   sync-scores    every 30 min     nfl_week_stats
--   apply-locks    every 5 min      locks drafts at kickoff (no API calls, so
--                                   it is free and stays frequent)
--
-- WHY POSTGRES AND NOT VERCEL CRON
-- ----------------------------------------------------------------------------
-- Vercel's Hobby plan allows at most 2 cron jobs and rejects any expression
-- running more than once a day — and it fails the DEPLOYMENT, it does not
-- degrade. pg_cron is on Supabase's free tier, fires on time, and needs no
-- third service. See docs/SCHEDULING.md for the alternatives.
--
-- Note this does not contradict moving the sync logic out of Supabase Edge
-- Functions: the logic lives in the Next app because it is instance-wide and
-- shares code with it. What triggers it is a separate question, and Postgres
-- is a perfectly good answer.
--
-- CADENCES: no day-of-week windows, deliberately. The single-league app polled
-- only inside hand-written UTC game-day windows, which assumed games run
-- Thursday to Monday — an assumption a Wednesday opener, Black Friday and
-- Christmas all break, and every night game already lands on the next UTC day.
-- Running all week costs a small fraction of the Tank01 allowance. Don't
-- reintroduce them. The full budget arithmetic is in
-- src/app/api/cron/_lib/cron.ts.
--
-- BEFORE YOU RUN THIS — edit exactly TWO lines
-- ----------------------------------------------------------------------------
-- Set v_base to your deployed app's origin, and v_key to the SAME value as the
-- CRON_SECRET environment variable in your Vercel project. The DO block refuses
-- to run if either is left as a placeholder, so a missed edit fails here rather
-- than scheduling jobs that 401 forever.
--
-- KEEP THIS FILE'S FILLED-IN FORM SECRET. The token is stored inside the job's
-- command text, so:
--   * never commit a filled-in copy, and
--   * never `select command from cron.job` in the SQL editor — it would print
--     the token into the results pane.
-- Safe to re-run: existing jobs with these names are unscheduled first.
-- ============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Idempotency: drop any previous versions of these jobs before re-scheduling,
-- so re-running after changing an interval doesn't leave duplicates behind.
do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname in (
    'tdsonly-sync-players',
    'tdsonly-sync-schedule',
    'tdsonly-sync-scores',
    'tdsonly-apply-locks'
  );
exception
  when others then
    -- cron.job may not exist yet on a fresh project; ignore.
    null;
end $$;

do $$
declare
  v_base text := '<APP_URL>';       -- e.g. https://your-app.vercel.app  (no trailing slash)
  v_key  text := '<CRON_SECRET>';   -- same value as the Vercel env var
  v_job record;
  v_cmd text;
begin
  if v_base like '<%>' or v_base !~ '^https://' then
    raise exception
      'Set v_base to your deployed app origin (https://...) before running this file.';
  end if;
  if v_key like '<%>' or length(v_key) < 16 then
    raise exception
      'Set v_key to your real CRON_SECRET before running this file.';
  end if;

  for v_job in
    select *
    from (values
      ('tdsonly-sync-players',  '0 */6 * * *',   'sync-players'),
      ('tdsonly-sync-schedule', '30 */12 * * *', 'sync-schedule'),
      ('tdsonly-sync-scores',   '*/30 * * * *',  'sync-scores'),
      ('tdsonly-apply-locks',   '*/5 * * * *',   'apply-locks')
    ) as t(jobname, schedule, route)
  loop
    -- Built with format(%L) so the URL and token are quoted exactly once, in
    -- one place. The old single-league version repeated these values in twelve
    -- spots, which meant a missed edit scheduled a job that failed only at
    -- runtime with an unhelpful hostname error.
    v_cmd := format(
      $cmd$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
      $cmd$,
      v_base || '/api/cron/' || v_job.route,
      'Bearer ' || v_key
    );

    perform cron.schedule(v_job.jobname, v_job.schedule, v_cmd);
    raise notice 'scheduled % (%)', v_job.jobname, v_job.schedule;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Verify — note that neither of these prints the token.
--
--   select jobname, schedule, active from cron.job
--    where jobname like 'tdsonly-%' order by jobname;
--
-- Recent outcomes (pg_net is async, so this shows whether the REQUEST was
-- made, not what the route answered):
--
--   select j.jobname, d.status, d.return_message, d.start_time
--     from cron.job_run_details d
--     join cron.job j on j.jobid = d.jobid
--    where j.jobname like 'tdsonly-%'
--    order by d.start_time desc limit 20;
--
-- What the routes actually DID is in the app's own log — one row per run:
--
--   select source, status, ran_at, message
--     from public.sync_log order by ran_at desc limit 20;
-- ----------------------------------------------------------------------------
