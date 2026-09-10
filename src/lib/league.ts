/**
 * League-shape constants and slug handling.
 *
 * LEAGUE_SIZE is deliberately a constant and not a per-league setting. This
 * app hosts one specific game — 8 managers, weekly full redraft, TDs only —
 * and the number 8 is load-bearing in three places that would all have to
 * move together to change it: the seat range in `league_members`
 * (CHECK seat between 1 and 8), the pick-count range in `draft_order`
 * (CHECK pick_number between 1 and 56 = 8 x ROSTER_SIZE), and the snake
 * generation in src/lib/draftOrder.ts. Making it configurable is a real
 * feature, not a constant swap; see docs/ARCHITECTURE.md.
 */
import { ROSTER_SIZE } from "@/lib/roster";

/** Managers per league. Mirrored by the seat CHECK constraint in SQL. */
export const LEAGUE_SIZE = 8;

/**
 * Total picks in one stage's snake draft. Derived, so a roster-shape change
 * grows the draft automatically — but note the draft_order.pick_number CHECK
 * constraint in supabase/migrations/0004_league_tables.sql does NOT follow,
 * and needs a migration alongside.
 */
export const DRAFT_PICK_COUNT = LEAGUE_SIZE * ROSTER_SIZE;

/** Stages in a season: 18 regular-season weeks + 4 postseason rounds. */
export const STAGE_COUNT = 22;

/**
 * Turns a league name into a URL slug matching the CHECK constraint on
 * `leagues.slug`: lowercase, digits and hyphens, 3-40 chars, no leading or
 * trailing hyphen.
 *
 * Returns null when nothing usable survives (e.g. a name that is entirely
 * emoji or non-Latin script). Callers must handle that rather than shipping
 * an empty slug — the create-league form falls back to asking for one.
 */
export function slugify(name: string): string | null {
  const slug = name
    .normalize("NFD")
    // Strip combining marks so "Café" becomes "cafe" rather than losing the e.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    // A trailing hyphen can reappear after the slice.
    .replace(/-+$/g, "");

  return slug.length >= 3 ? slug : null;
}

/** True if `slug` satisfies the same rule the database enforces. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug);
}

/**
 * Appends a short random suffix to a slug, for retrying a create after a
 * uniqueness collision. Keeps the result inside the 40-char limit by
 * trimming the base rather than overflowing it.
 */
export function suffixSlug(slug: string): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  const base = slug.slice(0, 40 - suffix.length - 1).replace(/-+$/g, "");
  return `${base}-${suffix}`;
}

/**
 * The NFL season year to use for a league created now.
 *
 * A season is named for the calendar year it STARTS in, so January's playoffs
 * still belong to the previous year's season. This mirrors
 * public.current_nfl_season() in SQL and currentSeason() in the sync jobs —
 * all three have to agree, or a league created in January would be seeded
 * against the wrong year's schedule.
 */
export function currentNflSeason(now: Date = new Date()): number {
  // getUTCMonth() is 0-based: 0-5 = Jan-Jun still belongs to last year's season.
  return now.getUTCMonth() <= 5 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}
