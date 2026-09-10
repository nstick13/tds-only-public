import { createClient } from "@/lib/supabase/server";
import type { LeagueMember } from "@/lib/types";

/**
 * League membership reads. This module replaces the single-league app's
 * getManagers(), which selected `profiles where is_player` — a query that
 * cannot work here for two separate reasons: there are no global role flags
 * any more, and `profiles` is owner-readable only, so a join through it comes
 * back holding nothing but your own row. Names live on
 * league_members.display_name, copied from the profile at join time exactly
 * so member lists never need to read someone else's profile.
 */

/**
 * Every member of a league — seated managers first (by seat), then spectators
 * by join order. Callers that specifically need the drafting managers should
 * use getSeatedMembers().
 */
export async function getMembers(leagueId: string): Promise<LeagueMember[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("league_members")
    .select("*")
    .eq("league_id", leagueId)
    // nullsFirst: false puts the seated members (seat 1..8) ahead of the
    // spectators, which is the order every member list wants to render in.
    .order("seat", { ascending: true, nullsFirst: false })
    .order("joined_at", { ascending: true });

  if (error) throw new Error(`getMembers: ${error.message}`);
  return data as LeagueMember[];
}

/**
 * The managers who actually hold a roster, in seat order.
 *
 * `is_player && seat != null` rather than either alone: the two are kept in
 * lockstep by a CHECK constraint (0003_leagues.sql), but the draft derives
 * its round count from this list and a mismatch would silently produce a
 * short draft, so ask for both.
 */
export async function getSeatedMembers(leagueId: string): Promise<LeagueMember[]> {
  const members = await getMembers(leagueId);
  return members.filter((m) => m.is_player && m.seat !== null);
}

/** One member's row, or null when that user isn't in the league. */
export async function getMember(
  leagueId: string,
  userId: string,
): Promise<LeagueMember | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("league_members")
    .select("*")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`getMember: ${error.message}`);
  return data as LeagueMember | null;
}
