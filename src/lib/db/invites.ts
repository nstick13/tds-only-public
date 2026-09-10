import { createClient } from "@/lib/supabase/server";
import type { LeagueInvite } from "@/lib/types";

/**
 * A league's invite codes, newest first.
 *
 * Commissioner-only by RLS, and deliberately so: an invite code is the entire
 * credential for joining a league, so an ordinary member being able to read
 * them would be able to hand out seats. For a non-commissioner this returns
 * [] rather than an error — which is why the commish page is the only thing
 * that calls it.
 */
export async function getLeagueInvites(leagueId: string): Promise<LeagueInvite[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("league_invites")
    .select("*")
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getLeagueInvites: ${error.message}`);
  return data as LeagueInvite[];
}
