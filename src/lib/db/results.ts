import { createClient } from "@/lib/supabase/server";
import type { WeeklyResult } from "@/lib/types";

/** Frozen per-manager totals and ranks for a single stage, best rank first. */
export async function getWeeklyResults(stageId: string): Promise<WeeklyResult[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("weekly_results")
    .select("*")
    .eq("stage_id", stageId)
    .order("rank", { ascending: true });

  if (error) throw new Error(`getWeeklyResults: ${error.message}`);
  return data as WeeklyResult[];
}

/**
 * Every finalized result in one league, for the season-long leaderboard.
 * Scoped by league_id rather than gathered across stages: weekly_results
 * carries its own league_id (set by trigger from the stage), so this is one
 * query instead of one per stage.
 */
export async function getAllWeeklyResults(leagueId: string): Promise<WeeklyResult[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("weekly_results")
    .select("*")
    .eq("league_id", leagueId)
    .order("stage_id", { ascending: true });

  if (error) throw new Error(`getAllWeeklyResults: ${error.message}`);
  return data as WeeklyResult[];
}
