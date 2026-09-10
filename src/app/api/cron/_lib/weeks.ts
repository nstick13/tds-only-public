// Which NFL weeks the global sync jobs should fetch right now.
//
// The single-league app asked a different question: "what is THE current
// stage". With many leagues on one instance there is no such thing — league A
// can be drafting Week 6 while league B is still locked on Week 5. So the
// question becomes "which NFL weeks does anyone on this instance care about",
// and the answer is the distinct (season, season_type, week_num) of every
// stage that is draft_open or locked, across all leagues.
//
// This is also where the quota story lives: see dedupeWeeks().
import {
  isAddressable,
  type AddressableStage,
  type Stage,
  type StageStatus,
} from "@/lib/types";
import { weekKeyId, type WeekKey } from "@/lib/tank01";
import type { ServiceClient } from "./cron";

/** Stage statuses that mean "some league is actively using this NFL week". */
const LIVE_STATUSES: StageStatus[] = ["draft_open", "locked"];

export interface TargetWeeks {
  /** Deduped weeks to fetch. One entry = one Tank01 getNFLGamesForWeek call. */
  weeks: WeekKey[];
  /** The live stages behind those weeks, across every league. */
  stages: AddressableStage[];
  /** Live stages with no Tank01 addressing — skipped, never guessed at. */
  unaddressed: Stage[];
}

/**
 * Every stage on the instance that is currently draft_open or locked.
 *
 * No league filter, and that is the point: these jobs write global tables.
 * The partial index stages_active_idx (0004_league_tables.sql) exists for
 * exactly this query.
 */
export async function liveStages(supabase: ServiceClient): Promise<Stage[]> {
  const { data, error } = await supabase
    .from("stages")
    .select("*")
    .in("status", LIVE_STATUSES)
    .order("season", { ascending: true })
    .order("week_num", { ascending: true });

  if (error) throw new Error(`stages lookup failed: ${error.message}`);
  return (data ?? []) as Stage[];
}

/**
 * Collapse many leagues' stages down to the distinct NFL weeks behind them.
 *
 * THIS IS THE DEDUPE THAT KEEPS THE TANK01 BUDGET FLAT. Stats are facts about
 * an NFL week, not about a league, so fifty leagues all playing Week 5 must
 * cost ONE getNFLGamesForWeek and one set of box scores, not fifty. Every
 * caller must iterate `weeks`, never `stages`.
 */
export function dedupeWeeks(stages: AddressableStage[]): WeekKey[] {
  const byKey = new Map<string, WeekKey>();
  for (const stage of stages) {
    const week: WeekKey = {
      season: stage.season,
      season_type: stage.season_type,
      week_num: stage.week_num,
    };
    const id = weekKeyId(week);
    if (!byKey.has(id)) byKey.set(id, week);
  }
  return Array.from(byKey.values());
}

/**
 * The weeks this run should process.
 *
 * An explicit week from the caller wins outright and skips the status filter
 * entirely — that is a commissioner re-running a past week to repair it, and
 * a past week is by definition no longer draft_open or locked.
 */
export async function resolveTargetWeeks(
  supabase: ServiceClient,
  explicit: WeekKey | null,
): Promise<TargetWeeks> {
  if (explicit) return { weeks: [explicit], stages: [], unaddressed: [] };

  const stages = await liveStages(supabase);
  const addressable: AddressableStage[] = [];
  const unaddressed: Stage[] = [];
  for (const stage of stages) {
    // The four postseason stages ship with NULL addressing on purpose. Sending
    // week=null to Tank01 returns an empty result, which reads as "no games
    // this week" rather than "this stage was never configured".
    if (isAddressable(stage)) addressable.push(stage);
    else unaddressed.push(stage);
  }

  return { weeks: dedupeWeeks(addressable), stages: addressable, unaddressed };
}

/** "2 stage(s) skipped: Wild Card (league …), …" — one line for sync_log. */
export function describeSkipped(unaddressed: Stage[]): string {
  if (unaddressed.length === 0) return "";
  const names = Array.from(new Set(unaddressed.map((s) => s.name))).join(", ");
  return (
    ` Skipped ${unaddressed.length} live stage(s) with no Tank01 week ` +
    `addressing (${names}) — postseason numbering is unconfirmed and is ` +
    `never guessed at.`
  );
}
