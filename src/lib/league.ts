/**
 * League-shape constants and slug handling.
 *
 * League size is a per-league setting (`leagues.size`), bounded 6-10. The
 * ceiling is not arbitrary and not a UI preference — it is quarterbacks.
 * Rosters carry TWO QBs and the player pool is exclusive per stage, so a
 * league needs `size x 2` startable QBs simultaneously. There are 32 NFL
 * starters and a bye week takes 4-6 teams out, leaving roughly 26:
 *
 *      8 managers -> 16 QBs   comfortable
 *     10 managers -> 20 QBs   tight; last picks get poor starters
 *     12 managers -> 24 QBs   ~92% of the pool gone, late picks draft backups
 *
 * No other position comes close to binding. The floor is 6 because the
 * exclusive pool is the point of the game — with fewer managers nothing is
 * ever meaningfully unavailable.
 *
 * These bounds are mirrored in SQL by the `leagues_size_range` CHECK and the
 * enforce_seat_within_league_size() trigger (0009_league_size.sql). Changing
 * them means changing both.
 */
import { ROSTER_SIZE } from "@/lib/roster";

/** Smallest league the game still works at. */
export const MIN_LEAGUE_SIZE = 6;
/** Largest league the QB pool supports. See the header. */
export const MAX_LEAGUE_SIZE = 10;
/** What a new league gets unless the creator picks otherwise. */
export const DEFAULT_LEAGUE_SIZE = 8;

/** Every size a league may be created at, for rendering a chooser. */
export const LEAGUE_SIZES: number[] = Array.from(
  { length: MAX_LEAGUE_SIZE - MIN_LEAGUE_SIZE + 1 },
  (_, i) => MIN_LEAGUE_SIZE + i,
);

/** True if `size` is a league size this app will accept. */
export function isValidLeagueSize(size: number): boolean {
  return (
    Number.isInteger(size) && size >= MIN_LEAGUE_SIZE && size <= MAX_LEAGUE_SIZE
  );
}

/**
 * Total picks in one stage's snake draft: one round per roster slot.
 *
 * Derived from both size and ROSTER_SIZE, so neither can drift from the
 * draft. Note the draft_order.pick_number CHECK constraint does NOT follow
 * automatically — it is set to the widest legal value (MAX_LEAGUE_SIZE x
 * ROSTER_SIZE = 70) and needs a migration if either bound moves.
 */
export function draftPickCount(leagueSize: number): number {
  return leagueSize * ROSTER_SIZE;
}

/**
 * Roughly how long a live draft takes, in minutes, at a realistic pace.
 *
 * Surfaced when choosing a size because it is the cost people actually feel:
 * this is a live draft EVERY week, all season, with everyone present. The
 * difference between 8 and 10 managers is about seven minutes a week, which
 * is a bigger deal over eighteen weeks than it sounds.
 */
export function estimatedDraftMinutes(leagueSize: number): number {
  const SECONDS_PER_PICK = 30;
  return Math.round((draftPickCount(leagueSize) * SECONDS_PER_PICK) / 60);
}

/**
 * How many startable QBs a league needs at once, against the ~26 available in
 * a bye week. Drives the warning on the size chooser.
 */
export function qbPressure(leagueSize: number): {
  needed: number;
  available: number;
  tight: boolean;
} {
  // 32 NFL starters less 4-6 teams on bye. The conservative end, because the
  // warning should fire on the bad weeks, not the average ones.
  const available = 26;
  const needed = leagueSize * 2;
  return { needed, available, tight: needed / available > 0.7 };
}

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
