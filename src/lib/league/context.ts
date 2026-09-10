import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { League, LeagueContext, LeagueMember } from "@/lib/types";

/**
 * Resolving /l/[slug] to "which league, and who am I in it".
 *
 * This is the single entry point for everything under /l/[slug]: the layout
 * calls it once, and every server action re-calls it with the slug from its
 * own route rather than trusting a league id posted by the client. Wrapped in
 * React's cache() so those repeated calls inside one request collapse to one
 * pair of queries.
 */

/**
 * The league for `slug` plus the caller's membership in it.
 *
 * Two failure modes, deliberately collapsed into one answer:
 *   - not signed in            -> /login, returning here afterwards
 *   - league missing, OR the caller isn't a member -> notFound()
 *
 * Distinguishing "no such league" from "not your league" would turn this
 * route into a slug oracle: anyone could probe /l/<guess> and learn which
 * leagues exist on the instance from the difference between a 404 and a 403.
 * RLS already gives us this for free — `leagues` is only selectable by
 * members, so a non-member's lookup comes back empty exactly like a typo.
 */
export const requireLeague = cache(async function requireLeague(
  slug: string,
): Promise<LeagueContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/l/${slug}`)}`);
  }

  const { data: league, error: leagueError } = await supabase
    .from("leagues")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (leagueError) throw new Error(`requireLeague: ${leagueError.message}`);
  if (!league) notFound();

  const { data: membership, error: memberError } = await supabase
    .from("league_members")
    .select("*")
    .eq("league_id", (league as League).id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (memberError) throw new Error(`requireLeague: ${memberError.message}`);
  // Belt and braces: RLS should already have hidden the league above, so
  // reaching here means the policies changed under us. 404 either way.
  if (!membership) notFound();

  return {
    league: league as League,
    membership: membership as LeagueMember,
  };
});

/** One league on the home page: the league row plus the caller's seat in it. */
export interface MyLeague {
  league: League;
  membership: LeagueMember;
}

/**
 * Every league the signed-in user belongs to, newest first — the home page's
 * whole content. Returns [] when signed out rather than redirecting, because
 * the home page has a signed-out story to tell.
 *
 * Joined from `league_members` rather than `leagues` because membership is
 * what the user has: the embedded `leagues` row rides along on the same RLS
 * check that already let us read the membership.
 */
export async function getMyLeagues(): Promise<MyLeague[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("league_members")
    .select("*, leagues (*)")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: false });

  if (error) throw new Error(`getMyLeagues: ${error.message}`);

  // PostgREST returns an embedded to-one relation as an object, but its types
  // allow an array; normalize rather than trusting one shape.
  type Row = LeagueMember & { leagues: League | League[] | null };

  return ((data ?? []) as Row[])
    .map(({ leagues, ...membership }) => {
      const league = Array.isArray(leagues) ? leagues[0] : leagues;
      return league ? { league, membership: membership as LeagueMember } : null;
    })
    .filter((entry): entry is MyLeague => entry !== null);
}
