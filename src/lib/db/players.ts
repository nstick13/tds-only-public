import { createClient } from "@/lib/supabase/server";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type { Player } from "@/lib/types";
import type { Position } from "@/lib/roster";

export interface PlayerFilter {
  position?: Position;
  /** Substring match against player name (case-insensitive). */
  search?: string;
}

/** All players in the league-wide pool, optionally filtered by position/name (server). */
export async function getPlayers(filter?: PlayerFilter): Promise<Player[]> {
  const supabase = await createClient();
  let query = supabase.from("players").select("*");
  if (filter?.position) query = query.eq("position", filter.position);
  if (filter?.search) query = query.ilike("name", `%${filter.search}%`);
  const { data, error } = await query.order("name", { ascending: true });

  if (error) throw new Error(`getPlayers: ${error.message}`);
  return data as Player[];
}

/** Client-component variant of getPlayers (e.g. for a live-filtering draft board). */
export async function getPlayersClient(filter?: PlayerFilter): Promise<Player[]> {
  const supabase = createBrowserClient();
  let query = supabase.from("players").select("*");
  if (filter?.position) query = query.eq("position", filter.position);
  if (filter?.search) query = query.ilike("name", `%${filter.search}%`);
  const { data, error } = await query.order("name", { ascending: true });

  if (error) throw new Error(`getPlayersClient: ${error.message}`);
  return data as Player[];
}

/**
 * The available player pool for a stage: every player NOT already in
 * roster_picks for that stage (roster_picks.unique(stage_id, player_id)
 * enforces the exclusive league-wide pool per stage).
 */
export async function getPlayerPool(stageId: string): Promise<Player[]> {
  const supabase = await createClient();

  const { data: picks, error: picksError } = await supabase
    .from("roster_picks")
    .select("player_id")
    .eq("stage_id", stageId);

  if (picksError) throw new Error(`getPlayerPool: ${picksError.message}`);

  const takenIds = (picks ?? []).map((p) => p.player_id as string);

  let query = supabase.from("players").select("*").order("name", { ascending: true });
  if (takenIds.length > 0) {
    query = query.not("id", "in", `(${takenIds.map((id) => `"${id}"`).join(",")})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getPlayerPool: ${error.message}`);
  return data as Player[];
}

/** Client-component variant of getPlayerPool — call again after realtime roster_picks changes to refresh availability. */
export async function getPlayerPoolClient(stageId: string): Promise<Player[]> {
  const supabase = createBrowserClient();

  const { data: picks, error: picksError } = await supabase
    .from("roster_picks")
    .select("player_id")
    .eq("stage_id", stageId);

  if (picksError) throw new Error(`getPlayerPoolClient: ${picksError.message}`);

  const takenIds = (picks ?? []).map((p) => p.player_id as string);

  let query = supabase.from("players").select("*").order("name", { ascending: true });
  if (takenIds.length > 0) {
    query = query.not("id", "in", `(${takenIds.map((id) => `"${id}"`).join(",")})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getPlayerPoolClient: ${error.message}`);
  return data as Player[];
}
