// How a league's stage maps onto a Tank01 week: the season year, and the
// message every job uses when a stage has no such mapping yet.
import type { Stage } from "@/lib/types";

/**
 * The NFL season year to ask Tank01 for.
 *
 * ESPN's scoreboard implied the current season; Tank01 requires it explicitly.
 * A season is named for the calendar year it STARTS in, so January's playoffs
 * still belong to the previous year's season — getting this wrong would fetch
 * the wrong games every January.
 *
 * This must agree with currentNflSeason() in src/lib/league.ts and
 * current_nfl_season() in SQL: those decide which season a league is seeded
 * for, this decides which season gets fetched for it. A disagreement in
 * January is invisible until standings come back empty.
 *
 * Override with TANK01_SEASON when backfilling a past season.
 */
export function currentSeason(now: Date = new Date()): number {
  const override = process.env.TANK01_SEASON?.trim();
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 2000) return n;
  }
  // getUTCMonth() is 0-based: 0-5 = Jan-Jun still belongs to last year's season.
  return now.getUTCMonth() <= 5 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

/** One NFL week, the unit every global sync job actually works in. */
export interface WeekKey {
  season: number;
  season_type: string;
  week_num: number;
}

/** Stable string form of a WeekKey, for deduping and for log lines. */
export function weekKeyId(w: WeekKey): string {
  return `${w.season}|${w.season_type}|${w.week_num}`;
}

/** Human-readable week, for sync_log messages. */
export function describeWeek(w: WeekKey): string {
  return `${w.season} ${w.season_type} week ${w.week_num}`;
}

/**
 * Message used by every job that skips an unaddressed stage, so sync_log reads
 * consistently whichever job hit it first.
 */
export function unaddressedStageMessage(stage: Stage): string {
  return (
    `Stage "${stage.name}" (ordinal ${stage.ordinal}) has no Tank01 week ` +
    `addressing yet, so there is nothing to fetch. Confirm the playoff ` +
    `seasonType/week values against a real response and set season_type / ` +
    `week_num — see reference-league/supabase/migrations/` +
    `0006_tank01_stage_addressing.sql.`
  );
}
