"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Redeeming an invite. The whole transaction — validating the code, claiming
 * the lowest free seat under an advisory lock, writing the membership row —
 * lives in the `accept_invite` RPC, because there is no client INSERT policy
 * on league_members and there should not be one. This action's only job is
 * turning the RPC's answer into something a person can read.
 */

export interface AcceptInviteResult {
  ok: boolean;
  error?: string;
  slug?: string;
  /** False when every seat was taken and they joined as a spectator instead. */
  seated?: boolean;
  seat?: number | null;
}

interface AcceptInviteRow {
  league_id: string;
  slug: string;
  seat: number | null;
  seated: boolean;
}

export async function acceptInviteAction(code: string): Promise<AcceptInviteResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You must be signed in to join a league." };
  }

  const { data, error } = await supabase.rpc("accept_invite", { p_code: code });

  if (error) {
    // accept_invite raises with a message written for this screen — an
    // expired or revoked link, or a code that never existed. Pass it through
    // rather than replacing it with something vaguer.
    return { ok: false, error: error.message };
  }

  const row = (Array.isArray(data) ? data : [data])[0] as AcceptInviteRow | undefined;
  if (!row) {
    return { ok: false, error: "That invite link is not valid." };
  }

  return { ok: true, slug: row.slug, seated: row.seated, seat: row.seat };
}
