// sync-schedule
//
// For every NFL week any league on this instance is currently using:
//   (a) upserts that week's games into the global `nfl_games` table — game id,
//       teams, kickoff and status.
//   (b) sets players.on_bye from the teams on bye that week.
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
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  byeWeeksFor,
  describeWeek,
  getGamesForWeek,
  getTeams,
  kickoffAt,
  type Tank01Team,
  type WeekKey,
} from "@/lib/tank01";
import {
  authorizeCron,
  errorMessage,
  readCronRequest,
  writeSyncLog,
  type ServiceClient,
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
 * Flip players.on_bye for one reference week.
 *
 * `players.on_bye` is a single instance-wide boolean, so it can only ever
 * describe ONE week — see the note at the call site for which one gets picked
 * when leagues are on different weeks.
 */
async function applyByes(
  supabase: ServiceClient,
  teams: Tank01Team[],
  week: WeekKey,
): Promise<string[]> {
  const byeTeamIds: string[] = [];
  const activeTeamIds: string[] = [];
  for (const team of teams) {
    const byes = byeWeeksFor(team, week.season);
    (byes.includes(week.week_num) ? byeTeamIds : activeTeamIds).push(
      String(team.teamID),
    );
  }

  if (byeTeamIds.length > MAX_PLAUSIBLE_BYE_TEAMS) {
    throw new Error(
      `Refusing to flag ${byeTeamIds.length} teams on bye for ` +
        `${describeWeek(week)}; more than ${MAX_PLAUSIBLE_BYE_TEAMS} is ` +
        `implausible and suggests bad byeWeeks data rather than a real bye week.`,
    );
  }

  const now = new Date().toISOString();
  if (byeTeamIds.length > 0) {
    const { error } = await supabase
      .from("players")
      .update({ on_bye: true, updated_at: now })
      .in("nfl_team_id", byeTeamIds);
    if (error) throw new Error(`players on_bye=true update failed: ${error.message}`);
  }
  if (activeTeamIds.length > 0) {
    const { error } = await supabase
      .from("players")
      .update({ on_bye: false, updated_at: now })
      .in("nfl_team_id", activeTeamIds);
    if (error) throw new Error(`players on_bye=false update failed: ${error.message}`);
  }
  return byeTeamIds;
}

async function run(req: Request): Promise<NextResponse> {
  const denied = authorizeCron(req);
  if (denied) return denied;

  const supabase = createServiceRoleClient();

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
    for (const week of target.weeks) {
      try {
        outcomes.push(await syncWeek(supabase, week));
      } catch (err) {
        // One bad week must not cost the others their schedule — collect and
        // keep going, then fail the run as a whole.
        failures.push(errorMessage(err));
      }
    }

    // WHICH WEEK on_bye DESCRIBES.
    // The column is global and boolean, so it can hold exactly one week's
    // byes. The draft UI is what reads it, so the answer is the newest week
    // someone is currently DRAFTING; locked weeks are already drafted and no
    // longer care. With every league on the real NFL calendar this is a single
    // week anyway — the tie-break only matters in the window where one league
    // has opened week N+1 while another is still locked on week N.
    //
    // An explicit re-run is excluded deliberately: repairing October's
    // schedule in December must not re-flag October's byes over the live week.
    const byeWeek = request.explicit ? null : pickByeWeek(target);
    let byeTeamIds: string[] = [];
    if (byeWeek) {
      try {
        byeTeamIds = await applyByes(supabase, teams, byeWeek);
      } catch (err) {
        failures.push(errorMessage(err));
      }
    }

    const status = failures.length > 0 ? "error" : "success";
    const gameCount = outcomes.reduce((n, o) => n + o.gameCount, 0);
    const undated = outcomes.reduce((n, o) => n + o.undatedGames, 0);
    const msg =
      `Synced ${gameCount} game(s) across ${outcomes.length}/${target.weeks.length} ` +
      `week(s): ${outcomes.map((o) => describeWeek(o.week)).join("; ") || "none"}. ` +
      (byeWeek
        ? `${byeTeamIds.length} team(s) on bye for ${describeWeek(byeWeek)} ` +
          `(${byeTeamIds.join(", ") || "none"}).`
        : "Bye flags left untouched (explicit week re-run).") +
      (undated > 0 ? ` ${undated} game(s) without a kickoff time.` : "") +
      skipNote +
      (failures.length > 0 ? ` FAILURES: ${failures.join(" | ")}` : "");
    await writeSyncLog(supabase, "schedule", status, msg);

    return NextResponse.json(
      {
        ok: failures.length === 0,
        weeks: outcomes,
        byeWeek,
        byeTeamIds,
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

/**
 * The week on_bye should describe: the latest week someone is drafting, or —
 * if nothing is open — the latest week in play at all. See the note above.
 */
function pickByeWeek(target: TargetWeeks): WeekKey | null {
  const drafting = dedupeWeeks(
    target.stages.filter((s) => s.status === "draft_open"),
  );
  const candidates = drafting.length > 0 ? drafting : target.weeks;
  return candidates.reduce<WeekKey | null>((best, w) => {
    if (!best) return w;
    if (w.season !== best.season) return w.season > best.season ? w : best;
    return w.week_num > best.week_num ? w : best;
  }, null);
}

export const GET = run;
export const POST = run;
