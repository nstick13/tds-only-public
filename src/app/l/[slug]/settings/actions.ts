"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireLeague } from "@/lib/league/context";

export interface ActionResult {
  success: boolean;
  message: string;
}

/**
 * Updates the caller's display name IN ONE LEAGUE.
 *
 * Names live on league_members, not profiles: leaguemates can read
 * league_members and cannot read each other's profiles, so this row is what
 * every roster and standings table renders from. It also means the same
 * person can be "Nate" in one league and "Coach" in another, which is a
 * feature and not an accident.
 *
 * Two things stop this from being a privilege-escalation hole, and neither is
 * this function: the "own row" RLS policy pins user_id, and the
 * guard_league_member_self_update trigger rejects any self-update that
 * touches a column other than display_name (a row-level WITH CHECK cannot).
 */
export async function updateDisplayNameAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (displayName.length < 2) {
    return { success: false, message: "Display name must be at least 2 characters." };
  }
  if (displayName.length > 40) {
    return { success: false, message: "Display name must be 40 characters or fewer." };
  }

  const { league, membership } = await requireLeague(slug);

  const supabase = await createClient();
  const { error } = await supabase
    .from("league_members")
    .update({ display_name: displayName })
    .eq("league_id", league.id)
    .eq("user_id", membership.user_id);

  if (error) {
    return { success: false, message: error.message };
  }

  // The whole league shows this name — nav, draft board, standings — so
  // revalidate the league subtree rather than just this page.
  revalidatePath(`/l/${slug}`, "layout");
  return { success: true, message: "Display name saved." };
}
