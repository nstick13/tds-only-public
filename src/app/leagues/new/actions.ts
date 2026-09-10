"use server";

import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_LEAGUE_SIZE,
  currentNflSeason,
  isValidLeagueSize,
  slugify,
  suffixSlug,
} from "@/lib/league";

/**
 * League creation. Everything happens inside the `create_league` RPC — the
 * league row, its 22 stages, the creator's commissioner seat, and a first
 * invite code, in one transaction. A league with no stages or no
 * commissioner is therefore not a reachable state, and this action never has
 * to clean one up.
 */

export interface CreateLeagueResult {
  ok: boolean;
  error?: string;
  /** Present on success — the caller redirects to /l/<slug> and shows the invite. */
  slug?: string;
  inviteCode?: string;
}

/** One row of create_league's result set. */
interface CreateLeagueRow {
  league_id: string;
  slug: string;
  invite_code: string;
}

/** Postgres unique_violation — here, always a slug someone else already took. */
const UNIQUE_VIOLATION = "23505";

/**
 * How many times to retry a taken slug with a random suffix before giving up.
 * Three is plenty: each retry adds four random characters, so a collision at
 * that depth means something other than bad luck is going on and a clear
 * error beats an infinite loop.
 */
const SLUG_RETRIES = 3;

export async function createLeagueAction(
  formData: FormData,
): Promise<CreateLeagueResult> {
  const name = String(formData.get("name") ?? "").trim();
  const sizeRaw = formData.get("size");
  const size = sizeRaw == null ? DEFAULT_LEAGUE_SIZE : Number(sizeRaw);

  if (!isValidLeagueSize(size)) {
    // The form only offers legal sizes, so this is a hand-crafted request.
    // The DB would reject it too (leagues_size_range); saying so here just
    // makes the failure legible instead of surfacing a constraint name.
    return { ok: false, error: "That isn't a league size this app supports." };
  }

  if (name.length < 1) {
    return { ok: false, error: "Give the league a name." };
  }
  if (name.length > 60) {
    return { ok: false, error: "League names are 60 characters or fewer." };
  }

  const baseSlug = slugify(name);
  if (!baseSlug) {
    return {
      ok: false,
      error:
        "That name doesn't produce a usable web address. Add a few letters or " +
        "digits — the address needs at least three of them.",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "You must be signed in to create a league." };
  }

  let slug = baseSlug;

  for (let attempt = 0; attempt <= SLUG_RETRIES; attempt++) {
    const { data, error } = await supabase.rpc("create_league", {
      p_name: name,
      p_slug: slug,
      p_season: currentNflSeason(),
      p_size: size,
    });

    if (!error) {
      const row = (Array.isArray(data) ? data : [data])[0] as
        | CreateLeagueRow
        | undefined;
      if (!row) {
        return { ok: false, error: "The league was created but came back empty." };
      }
      return { ok: true, slug: row.slug, inviteCode: row.invite_code };
    }

    // A taken slug is the ordinary case, not a failure: two people can
    // reasonably both call their league "Sunday Beers". Suffix and retry
    // rather than making the second one rename their league.
    if (error.code === UNIQUE_VIOLATION) {
      slug = suffixSlug(baseSlug);
      continue;
    }

    return { ok: false, error: error.message };
  }

  return {
    ok: false,
    error:
      `"${baseSlug}" and several variations of it are all taken. Try a more ` +
      "distinctive league name.",
  };
}
