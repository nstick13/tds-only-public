// sync-scores
//
// For every NFL week any league on this instance is currently using, lists
// that week's games from Tank01 (getNFLGamesForWeek), fetches the box score of
// each game that can still change, and tallies pass_td / rush_td / rec_td per
// player into the global `nfl_week_stats`.
//
// Keyed by (season, season_type, week_num, player_id) — NOT by stage. That is
// the whole reason this instance scales: fifty leagues playing Week 5 read one
// set of rows written by one fetch.
//
// Parsing approach (Tank01 shape — verified against
// reference-league/reference/tank01/getNFLBoxScore.sample.json)
// ------------------------------------------------------------------------
// getNFLBoxScore returns `playerStats`, an OBJECT KEYED BY playerID. Each
// value carries at most one object per stat category the player recorded:
//
//   "15835": { playerID: "15835", longName: "Zach Ertz", teamAbv: "WSH",
//              Receiving: { recTD: "1", recYds: "40", ... } }
//
// Every value is a STRING, and a category object is simply ABSENT when the
// player recorded nothing in it (Ertz above has no Passing/Rushing key).
// tdsFor() in src/lib/tank01/client.ts does the parsing — it reads exactly
// Passing.passTD / Rushing.rushTD / Receiving.recTD and deliberately ignores
// Defense.defTD and the return-TD fields, which this league does not score.
// Do not re-implement that here.
//
// A passing TD and its receiving TD are separate rows keyed by separate
// playerIDs, so the QB and the receiver are each credited without any
// play-by-play text parsing.
//
// Quota discipline
// ------------------------------------------------------------------------
// Tank01 Pro is 1,000 calls/day for the WHOLE instance, so this job refuses to
// re-fetch a box score that cannot have changed: games that have not kicked
// off yet have no stats, and final games are frozen. See shouldFetch() in
// src/lib/tank01/gameFetch.ts.
//
// It also iterates deduped WEEKS, never stages — resolveTargetWeeks() collapses
// every league's live stages down to distinct (season, season_type, week_num)
// first, so N leagues sharing a week cost one fetch rather than N.
//
// Partial-week upsert safety, re-checked under the week-keyed model: an NFL
// player appears in at most ONE game per NFL WEEK, so the per-player rows
// produced by fetched games and by skipped games are disjoint. Upserting only
// the players we saw this run therefore never clobbers a skipped game's
// already-stored TDs. The old wording said "one game per stage", which was the
// same claim through a league's copy of the week; keying on the week itself
// makes it more directly true, not less.
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  describeWeek,
  getBoxScore,
  getGamesForWeek,
  hasAnyTd,
  mapWithConcurrency,
  shouldFetch,
  type Tank01Game,
  tdsFor,
  type TdTally,
  type WeekKey,
} from "@/lib/tank01";
import {
  authorizeCron,
  errorMessage,
  readCronRequest,
  writeSyncLog,
  type ServiceClient,
} from "../_lib/cron";
import { describeSkipped, resolveTargetWeeks } from "../_lib/weeks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GAME_FETCH_CONCURRENCY = 4;
const ID_CHUNK = 500;
const UPSERT_CHUNK = 200;

/**
 * Timestamp of the last sync-scores run that fetched every game cleanly.
 *
 * IMPORTANT LIMITATION, NOW WORSE THAN IT WAS: `sync_log` records a source but
 * not a stage — and now not a week either. The watermark is INSTANCE-GLOBAL. A
 * clean run for Week 5 would otherwise make every already-final Week 3 game
 * look "already ingested".
 *
 * In the single-league app that only bit a commissioner explicitly re-running
 * an earlier week, so skipping the watermark on an explicit request was a
 * complete fix. Here it also bites a league CREATED MID-SEASON: its Week 2
 * stage goes draft_open in December, every Week 2 game is long final, and the
 * global watermark is months past them — so an unrepaired watermark would skip
 * the entire week and the new league's standings would stay empty with nobody
 * having asked for anything unusual.
 *
 * So the watermark is now applied PER WEEK, and only to a week we can prove we
 * have ingested before: weekAlreadyIngested() checks for stored rows first.
 * That check is a database read, not a Tank01 call, so it costs no quota.
 */
async function lastCleanRunAt(supabase: ServiceClient): Promise<Date | null> {
  const { data, error } = await supabase
    .from("sync_log")
    .select("ran_at")
    .eq("source", "scores")
    .eq("status", "success")
    .order("ran_at", { ascending: false })
    .limit(1);
  // A logging-table hiccup must not stop scores from syncing; without a
  // watermark we simply fetch more games than strictly necessary.
  if (error || !data || data.length === 0) return null;
  const d = new Date(data[0].ran_at as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Have we ever stored stats for this week? See the watermark note above. */
async function weekAlreadyIngested(
  supabase: ServiceClient,
  week: WeekKey,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("nfl_week_stats")
    .select("player_id")
    .eq("season", week.season)
    .eq("season_type", week.season_type)
    .eq("week_num", week.week_num)
    .limit(1);
  // On error, assume not ingested: fetching a week twice costs quota, missing
  // it entirely costs a league its standings.
  if (error) return false;
  return (data ?? []).length > 0;
}

interface WeekResult {
  week: WeekKey;
  gamesInWeek: number;
  gamesFetched: number;
  gamesFailed: number;
  gamesSkippedFinal: number;
  gamesSkippedScheduled: number;
  gamesStaleScheduled: number;
  playersTallied: number;
  playersWithTds: number;
  playersUpserted: number;
  skippedUnknownPlayers: number;
}

async function syncWeek(
  supabase: ServiceClient,
  week: WeekKey,
  lastClean: Date | null,
): Promise<WeekResult> {
  const games = await getGamesForWeek(week.week_num, week.season_type, week.season);

  if (games.length === 0) {
    throw new Error(
      `Tank01 getNFLGamesForWeek for ${describeWeek(week)} returned zero ` +
        `games — nothing to sync.`,
    );
  }

  const toFetch: Tank01Game[] = [];
  let skippedScheduled = 0;
  let skippedFinal = 0;
  let staleScheduled = 0;
  for (const game of games) {
    const decision = shouldFetch(game, lastClean);
    if (decision.fetch) {
      toFetch.push(game);
      // Counted separately so a provider whose statuses are stuck shows up in
      // the sync log instead of hiding inside the fetched-games total.
      if (decision.reason === "stale-scheduled") staleScheduled++;
    } else if (decision.reason === "scheduled") skippedScheduled++;
    else skippedFinal++;
  }

  // Scoped to THIS week, deliberately. A player can score in week 5 and again
  // in week 6, and a run may be processing both; a tally map shared across
  // weeks would add the two together and write the sum into each.
  const tallies = new Map<string, TdTally>();

  const { results, errors } = await mapWithConcurrency(
    toFetch,
    GAME_FETCH_CONCURRENCY,
    async (game: Tank01Game) => {
      const box = await getBoxScore(game.gameID);
      const playerStats = box.playerStats;
      if (!playerStats || typeof playerStats !== "object") {
        throw new Error(`game ${game.gameID} box score has no playerStats`);
      }
      for (const [playerId, stats] of Object.entries(playerStats)) {
        if (!playerId || !stats) continue;
        const t = tdsFor(stats);
        const existing = tallies.get(playerId);
        if (!existing) {
          tallies.set(playerId, t);
        } else {
          // Defensive: a player appears in exactly one game per week, so this
          // only fires if Tank01 lists a game twice.
          existing.pass_td += t.pass_td;
          existing.rush_td += t.rush_td;
          existing.rec_td += t.rec_td;
        }
      }
      return game.gameID;
    },
  );

  if (errors.length > 0) {
    console.error(
      `sync-scores: ${errors.length}/${toFetch.length} box score fetches failed ` +
        `for ${describeWeek(week)}`,
      errors.map((e) => String(e.error)),
    );
  }

  // Only upsert players that already exist in `players` (skip unknowns rather
  // than violate the FK or invent player rows here — sync-players is the
  // source of truth for the pool). Most of the skips are defenders, kickers
  // and linemen, who are unrosterable.
  const playerIds = Array.from(tallies.keys());
  const knownIds = new Set<string>();
  for (let i = 0; i < playerIds.length; i += ID_CHUNK) {
    const chunk = playerIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase.from("players").select("id").in("id", chunk);
    if (error) throw new Error(`players lookup failed: ${error.message}`);
    for (const row of data ?? []) knownIds.add(row.id as string);
  }

  const now = new Date().toISOString();
  // NOTE: `points` is a GENERATED column on nfl_week_stats — never write it;
  // Postgres computes it from the three TD counts.
  //
  // Players with zero TDs are kept deliberately: writing their zeros back is
  // what corrects a TD that was credited live and later reversed by a stat
  // correction.
  const rows = playerIds
    .filter((id) => knownIds.has(id))
    .map((id) => {
      const t = tallies.get(id)!;
      return {
        season: week.season,
        season_type: week.season_type,
        week_num: week.week_num,
        player_id: id,
        pass_td: t.pass_td,
        rush_td: t.rush_td,
        rec_td: t.rec_td,
        updated_at: now,
      };
    });

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from("nfl_week_stats")
      .upsert(chunk, { onConflict: "season,season_type,week_num,player_id" });
    if (error) {
      throw new Error(
        `nfl_week_stats upsert for ${describeWeek(week)} failed at chunk ` +
          `${i / UPSERT_CHUNK}: ${error.message}`,
      );
    }
  }

  return {
    week,
    gamesInWeek: games.length,
    gamesFetched: results.length,
    gamesFailed: errors.length,
    gamesSkippedFinal: skippedFinal,
    gamesSkippedScheduled: skippedScheduled,
    gamesStaleScheduled: staleScheduled,
    playersTallied: playerIds.length,
    playersWithTds: rows.filter((r) => hasAnyTd(r)).length,
    playersUpserted: rows.length,
    skippedUnknownPlayers: playerIds.length - rows.length,
  };
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
      const isGap = target.unaddressed.length > 0;
      const msg = isGap
        ? `No addressable NFL week is live.${skipNote}`
        : "No league has a draft_open or locked stage — no scores to sync.";
      await writeSyncLog(supabase, "scores", isGap ? "error" : "success", msg, null);
      return NextResponse.json(
        { ok: !isGap, weeks: [], message: msg },
        { status: isGap ? 422 : 200 },
      );
    }

    // An explicit week means a human is deliberately re-syncing it, almost
    // always to repair it. Honour that by re-fetching every playable game
    // instead of trusting the (week-blind) watermark, which would otherwise
    // skip the whole week as already ingested.
    const globalLastClean = request.explicit ? null : await lastCleanRunAt(supabase);

    const results: WeekResult[] = [];
    const failures: string[] = [];
    for (const week of target.weeks) {
      try {
        // The watermark only means "already ingested" for a week we actually
        // have rows for — see lastCleanRunAt().
        const lastClean =
          globalLastClean && (await weekAlreadyIngested(supabase, week))
            ? globalLastClean
            : null;
        results.push(await syncWeek(supabase, week, lastClean));
      } catch (err) {
        // One bad week must not cost the others their scores.
        failures.push(errorMessage(err));
      }
    }

    const gamesFailed = results.reduce((n, r) => n + r.gamesFailed, 0);
    const upserted = results.reduce((n, r) => n + r.playersUpserted, 0);
    // A run is clean only when EVERY week's every playable game came back.
    // That is what makes the watermark's induction hold: anything less logs
    // 'error' and never advances it.
    const clean = failures.length === 0 && gamesFailed === 0;

    const msg =
      results
        .map(
          (r) =>
            `${describeWeek(r.week)}: fetched ${r.gamesFetched}/${
              r.gamesFetched + r.gamesFailed
            } box scores of ${r.gamesInWeek} games (skipped ${r.gamesSkippedFinal} ` +
            `already-final, ${r.gamesSkippedScheduled} not yet kicked off` +
            (r.gamesStaleScheduled > 0
              ? `, ${r.gamesStaleScheduled} still marked scheduled long after ` +
                `kickoff — fetched anyway`
              : "") +
            `); upserted ${r.playersUpserted} player(s), ${r.playersWithTds} with TDs, ` +
            `${r.skippedUnknownPlayers} unknown to the players table.`,
        )
        .join(" ") +
      (results.length === 0 ? "No week completed." : "") +
      skipNote +
      (gamesFailed > 0
        ? ` ${gamesFailed} box score fetch(es) FAILED — stats for those games ` +
          `are missing this run.`
        : "") +
      (failures.length > 0 ? ` WEEK FAILURES: ${failures.join(" | ")}` : "");
    await writeSyncLog(supabase, "scores", clean ? "success" : "error", msg, upserted);

    return NextResponse.json(
      { ok: clean, weeks: results, unaddressedStages: target.unaddressed.length, failures },
      { status: clean ? 200 : 502 },
    );
  } catch (err) {
    const msg = errorMessage(err);
    await writeSyncLog(supabase, "scores", "error", msg, null);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
