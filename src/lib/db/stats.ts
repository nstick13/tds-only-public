import { createClient } from "@/lib/supabase/server";
import { isAddressable, type NflWeekStats, type Stage } from "@/lib/types";

/**
 * Stat reads for a stage.
 *
 * The single-league app kept `player_stage_stats(stage_id, player_id)` — one
 * copy of every touchdown per stage. Here stats are a fact about an NFL week,
 * not about a league: `nfl_week_stats` is keyed by
 * (season, season_type, week_num, player_id) and shared by every league on
 * the instance. Anything that used to filter stats by stage_id comes through
 * here instead, which resolves the stage's three addressing columns and joins
 * on those.
 */

/**
 * Every stat row for the NFL week a stage scores.
 *
 * Returns [] for an unaddressed stage — the four postseason rounds ship with
 * season_type/week_num NULL because Tank01's playoff numbering was never
 * confirmed (see 0004_league_tables.sql). Querying with week=null matches
 * nothing anyway, but returning early makes "we never configured this" a
 * deliberate answer rather than an accident that reads as "nobody scored".
 */
export async function getStageStats(stage: Stage): Promise<NflWeekStats[]> {
  if (!isAddressable(stage)) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("nfl_week_stats")
    .select("*")
    .eq("season", stage.season)
    .eq("season_type", stage.season_type)
    .eq("week_num", stage.week_num);

  if (error) throw new Error(`getStageStats: ${error.message}`);
  return data as NflWeekStats[];
}
