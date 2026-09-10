import { createClient } from "@/lib/supabase/server";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type { RosterPick } from "@/lib/types";

/** All roster_picks for a stage (every manager's drafted players). */
export async function getRosterPicks(stageId: string): Promise<RosterPick[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("roster_picks")
    .select("*")
    .eq("stage_id", stageId)
    .order("pick_number", { ascending: true });

  if (error) throw new Error(`getRosterPicks: ${error.message}`);
  return data as RosterPick[];
}

/** Client-component variant of getRosterPicks — re-call after a realtime roster_picks event to refresh the board. */
export async function getRosterPicksClient(stageId: string): Promise<RosterPick[]> {
  const supabase = createBrowserClient();
  const { data, error } = await supabase
    .from("roster_picks")
    .select("*")
    .eq("stage_id", stageId)
    .order("pick_number", { ascending: true });

  if (error) throw new Error(`getRosterPicksClient: ${error.message}`);
  return data as RosterPick[];
}

/** The signed-in user's own roster_picks for a stage (their drafted team). */
export async function getMyRoster(stageId: string): Promise<RosterPick[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await supabase
    .from("roster_picks")
    .select("*")
    .eq("stage_id", stageId)
    .eq("manager_id", user.id);

  if (error) throw new Error(`getMyRoster: ${error.message}`);
  return data as RosterPick[];
}
