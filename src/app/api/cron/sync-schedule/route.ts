// sync-schedule
//
// For every NFL week any league on this instance is currently using:
//   (a) upserts that week's games into the global `nfl_games` table — game id,
//       teams, kickoff and status.
//   (b) records which teams are on bye each week, into nfl_team_byes.
//
// WHERE KICKOFF WENT
// ---------------------------------------------------------------------------
// The single-league app wrote the week's earliest kickoff to
// stages.first_kickoff_at. That column does not exist here, and shouldn't:
// kickoff is a property of the NFL week, not of one league's copy of it, so
// N leagues sharing Week 5 would have stored N timestamps free to drift apart.
// It now lives on nfl_games.kickoff_at, and apply-locks takes the MIN over the
// week rather than reading a per-league scalar.
//
// WHAT CHANGED IN THE TANK01 MIGRATION (still true)
// ---------------------------------------------------------------------------
// Byes used to be *derived*: fetch the week's games, collect the team ids that
// appear, and treat the other 32-N as on bye. That inferred a bye from an
// absence, so any week the schedule came back short — a partial fetch, a
// postponed game, an API hiccup — silently benched real players.
//
// Tank01 publishes byes directly: every team in getNFLTeams carries a
// `byeWeeks` map keyed by season year. So we read the bye instead of inferring
// it, and a short/failed schedule response can no longer masquerade as
// "everyone's on bye".
//
// Kickoff comes from each game's `gameTime_epoch` (unix seconds), which is
// unambiguous — unlike a local time string, it needs no timezone guessing.
import { NextResponse } from "next/server";
import {
  byeWeeksFor,
  describeWeek,
  getGamesForWeek,
  getTeams,
  kickoffAt,
  type Tank01Team,
  type WeekKey,
  weekKeyId,
} from "@/lib/tank01";
import {
  authorizeCron,
  errorMessage,
  readCronRequest,
  writeSyncLog,
  type ServiceClient,
  serviceClientOrError,
} from "../_lib/cron";
import {
  dedupeWeeks,
  describeSkipped,
  resolveTargetWeeks,
  type TargetWeeks,
} from "../_lib/weeks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A normal NFL week has at most a handful of teams on bye. If the bye data
// ever comes back malformed enough to bench most of the league, that is a bug,
// not a bye week — refuse rather than wipe the player pool's availability for
// every league at once.
const MAX_PLAUSIBLE_BYE_TEAMS = 8;

interface WeekOutcome {
  week: WeekKey;
  gameCount: number;
  undatedGames: number;
  firstKickoffAt: string | null;
}

/** Upsert one week's games into the global schedule. One Tank01 call. */
async function syncWeek(
  supabase: ServiceClient,
  week: WeekKey,
): Promise<WeekOutcome> {
  const games = await getGamesForWeek(week.week_num, week.season_type, week.season);

  if (games.length === 0) {
    throw new Error(
      `getNFLGamesForWeek for ${describeWeek(week)} returned zero games — ` +
        `refusing to write a schedule off an empty week. If this week is ` +
        `correctly addressed, check the seasonType value against a real response.`,
    );
  }

  const now = new Date().toISOString();
  const kickoffs: number[] = [];

  const rows = games.map((game) => {
    const at = kickoffAt(game);
    if (at) kickoffs.push(at.getTime());

    return {
      game_id: game.gameID,
      // The address we ASKED for, not the one echoed back: these three columns
      // are the join key stages use, so they must match the stage exactly.
      season: week.season,
      season_type: week.season_type,
      week_num: week.week_num,
      home_team: (game.home ?? "").trim() || null,
      away_team: (game.away ?? "").trim() || null,
      kickoff_at: at?.toISOString() ?? null,
      game_status: (game.gameStatus ?? "").trim() || null,
      updated_at: now,
    };
  });

  const { error } = await supabase
    .from("nfl_games")
    .upsert(rows, { onConflict: "game_id" });
  if (error) {
    throw new Error(`nfl_games upsert for ${describeWeek(week)} failed: ${error.message}`);
  }

  return {
    week,
    gameCount: games.length,
    undatedGames: games.length - kickoffs.length,
    firstKickoffAt:
      kickoffs.length > 0 ? new Date(Math.min(...kickoffs)).toISOString() : null,
  };
}

/**
 * Record which teams are off in one week, into nfl_team_byes.
 *
 * The single-league app flipped a global `players.on_bye` boolean here. That
 * could only ever describe ONE week, and on a multi-league instance "the
 * current week" is plural — so whichever week it described, it was wrong for
 * some other league, and a player wrongly marked on bye cannot be drafted at
 * all. Keyed by week instead, this is correct for every league at once, and
 * the whole "which week does the flag mean" question disappears.
 *
 * Writes are per (season, week): the rows for the week being synced are
 * replaced wholesale, so a corrected bye schedule cleans up after itself
 * rather than leaving a stale team flagged forever.
 */
async function applyByes(
  supabase: ServiceClient,
  teams: Tank01Team[],
  week: WeekKey,
): Promise<string[]> {
  const byeTeamIds: string[] = [];
  for (const team of teams) {
    if (byeWeeksFor(team, week.season).includes(week.week_num)) {
      byeTeamIds.push(String(team.teamID));
    }
  }

  if (byeTeamIds.length > MAX_PLAUSIBLE_BYE_TEAMS) {
    throw new Error(
      `Refusing to flag ${byeTeamIds.length} teams on bye for ` +
        `${describeWeek(week)}; more than ${MAX_PLAUSIBLE_BYE_TEAMS} is ` +
        `implausible and suggests bad byeWeeks data rather than a real bye week.`,
    );
  }

  // Replace rather than upsert: a team REMOVED from the bye list has to lose
  // its row, and an upsert would silently leave it behind.
  const { error: delError } = await supabase
    .from("nfl_team_byes")
    .delete()
    .eq("season", week.season)
    .eq("week_num", week.week_num);
  if (delError) throw new Error(`nfl_team_byes delete failed: ${delError.message}`);

  if (byeTeamIds.length > 0) {
    const { error } = await supabase.from("nfl_team_byes").insert(
      byeTeamIds.map((id) => ({
        season: week.season,
        nfl_team_id: id,
        week_num: week.week_num,
      })),
    );
    if (error) throw new Error(`nfl_team_byes insert failed: ${error.message}`);
  }

  return byeTeamIds;
}

async function run(req: Request): Promise<NextResponse> {
  const denied = authorizeCron(req);
  if (denied) return denied;

  const svc = serviceClientOrError();
  if ("error" in svc) return svc.error;
  const supabase = svc.client;

  try {
    const request = await readCronRequest(req);
    const target = await resolveTargetWeeks(supabase, request.week);
    const skipNote = describeSkipped(target.unaddressed);

    if (target.weeks.length === 0) {
      // Live stages that are ALL unaddressed is a configuration gap someone
      // has to fix (the postseason rows); no live stages at all is just the
      // offseason, and logging that as an error would leave the UI showing a
      // permanent failure all summer.
      const isGap = target.unaddressed.length > 0;
      const msg = isGap
        ? `No addressable NFL week is live.${skipNote}`
        : "No league has a draft_open or locked stage — nothing to schedule.";
      await writeSyncLog(supabase, "schedule", isGap ? "error" : "success", msg);
      return NextResponse.json({ ok: !isGap, weeks: [], message: msg }, {
        status: isGap ? 422 : 200,
      });
    }

    // One getNFLTeams for the whole run, not one per week: byeWeeks is keyed by
    // season inside the payload, so the same response answers every week.
    const teams = await getTeams();

    const outcomes: WeekOutcome[] = [];
    const failures: string[] = [];
    const byesByWeek = new Map<string, string[]>();
    for (const week of target.weeks) {
      try {
        outcomes.push(await syncWeek(supabase, week));
        // Byes are recorded for EVERY week this run touches, not for one
        // chosen "current" week. That choice only existed because the old
        // global boolean could hold a single week; keyed by week there is
        // nothing to choose, and an explicit re-run of October now repairs
        // October's byes without disturbing the live week.
        byesByWeek.set(weekKeyId(week), await applyByes(supabase, teams, week));
      } catch (err) {
        // One bad week must not cost the others their schedule — collect and
        // keep going, then fail the run as a whole.
        failures.push(errorMessage(err));
      }
    }

    const status = failures.length > 0 ? "error" : "success";
    const gameCount = outcomes.reduce((n, o) => n + o.gameCount, 0);
    const undated = outcomes.reduce((n, o) => n + o.undatedGames, 0);
    const byeSummary = outcomes
      .map((o) => {
        const ids = byesByWeek.get(weekKeyId(o.week)) ?? [];
        return `${describeWeek(o.week)}: ${ids.length} on bye`;
      })
      .join("; ");
    const msg =
      `Synced ${gameCount} game(s) across ${outcomes.length}/${target.weeks.length} ` +
      `week(s): ${outcomes.map((o) => describeWeek(o.week)).join("; ") || "none"}. ` +
      `Byes — ${byeSummary || "none"}.` +
      (undated > 0 ? ` ${undated} game(s) without a kickoff time.` : "") +
      skipNote +
      (failures.length > 0 ? ` FAILURES: ${failures.join(" | ")}` : "");
    await writeSyncLog(supabase, "schedule", status, msg);

    return NextResponse.json(
      {
        ok: failures.length === 0,
        weeks: outcomes,
        byes: Object.fromEntries(byesByWeek),
        unaddressedStages: target.unaddressed.length,
        failures,
      },
      { status: failures.length > 0 ? 502 : 200 },
    );
  } catch (err) {
    const msg = errorMessage(err);
    await writeSyncLog(supabase, "schedule", "error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
