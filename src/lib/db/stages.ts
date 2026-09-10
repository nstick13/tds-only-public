import { createClient } from "@/lib/supabase/server";
import type { Stage } from "@/lib/types";

/**
 * A league's 22 stages, ordered by ordinal — the DB-driven source of truth.
 * Never hardcode a stage list, and never query stages without a league_id:
 * RLS would hide the other leagues' rows anyway, but an unscoped query that
 * quietly returns nothing is a miserable bug to chase.
 */
export async function getStages(leagueId: string): Promise<Stage[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stages")
    .select("*")
    .eq("league_id", leagueId)
    .order("ordinal", { ascending: true });

  if (error) throw new Error(`getStages: ${error.message}`);
  return data as Stage[];
}

/**
 * A single stage by its uuid. No league argument needed — a stage id names
 * exactly one league's stage, and RLS refuses to hand back one you can't see.
 */
export async function getStageById(stageId: string): Promise<Stage | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stages")
    .select("*")
    .eq("id", stageId)
    .maybeSingle();

  if (error) throw new Error(`getStageById: ${error.message}`);
  return data as Stage | null;
}

/**
 * The "current" stage for one league's dashboard and nav: the stage that is
 * actively in progress, preferring draft_open over locked; falling back to
 * the lowest-ordinal stage that isn't finalized; or null once every stage is
 * finalized (season over).
 */
export async function getCurrentStage(leagueId: string): Promise<Stage | null> {
  const stages = await getStages(leagueId);
  if (stages.length === 0) return null;

  const draftOpen = stages.find((s) => s.status === "draft_open");
  if (draftOpen) return draftOpen;

  const locked = stages.find((s) => s.status === "locked");
  if (locked) return locked;

  const upcoming = stages
    .filter((s) => s.status !== "finalized")
    .sort((a, b) => a.ordinal - b.ordinal)[0];

  return upcoming ?? null;
}
