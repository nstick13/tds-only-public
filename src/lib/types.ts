/**
 * Shared TypeScript types mirroring the Supabase schema in
 * supabase/migrations/. THE canonical types to import from — do not
 * re-declare row shapes against `any` query results.
 *
 * Naming: SQL is snake_case; these interfaces keep the same field names
 * (camelCase would drift from `select *` results) but use PascalCase type
 * names per TS convention.
 *
 * MULTI-TENANCY NOTE
 * ---------------------------------------------------------------------------
 * Types split into three groups, and knowing which group a table is in is the
 * thing to get right when writing a query:
 *
 *   1. Identity      — Profile. One row per account, no league association.
 *   2. League-scoped — League, LeagueMember, Stage, DraftOrderRow, RosterPick,
 *                      WeeklyResult. EVERY query against these must filter by
 *                      league. RLS enforces it, but a missing filter turns
 *                      into an empty result rather than an error, which is a
 *                      confusing way to find out.
 *   3. Global NFL    — Player, NflGame, NflWeekStats, SyncLog. Shared by every
 *                      league on the instance; no league_id exists to filter by.
 */

/** Player position — mirrors the CHECK constraints on players.position / roster_picks.slot_position. */
export type { Position } from "./roster";

/** stages.status lifecycle: upcoming -> draft_open -> locked -> finalized. */
export type StageStatus = "upcoming" | "draft_open" | "locked" | "finalized";

/** leagues.status lifecycle: setup -> active -> complete. */
export type LeagueStatus = "setup" | "active" | "complete";

/** Player availability as synced from Tank01 (free text; 'Active' is the happy path). */
export type PlayerStatus =
  | "Active"
  | "Questionable"
  | "Doubtful"
  | "OUT"
  | "IR"
  | string;

/** sync_log.source values — the four sync jobs. */
export type SyncSource = "players" | "schedule" | "scores" | "locks";

/** sync_log.status. */
export type SyncStatus = "success" | "error";

// ============================================================================
// 1. Identity
// ============================================================================

/**
 * profiles table — one row per authenticated user. Identity only.
 *
 * Readable ONLY by its owner (see 0006_rls.sql). Leaguemates' names come from
 * LeagueMember.display_name, which is copied here at join time — do not try to
 * join profiles to render a member list, it will come back empty for everyone
 * but yourself.
 */
export interface Profile {
  id: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
}

// ============================================================================
// 2. League-scoped
// ============================================================================

/** leagues table — one row per league. `slug` is the URL key (/l/<slug>). */
export interface League {
  id: string;
  slug: string;
  name: string;
  /** NFL season year this league plays; a season is named for the year it starts in. */
  season: number;
  status: LeagueStatus;
  created_by: string | null;
  created_at: string;
}

/**
 * league_members table — per-league membership and roles. This is the
 * authorization root; there are no global role flags anywhere.
 */
export interface LeagueMember {
  league_id: string;
  user_id: string;
  /** 1..8, or null for a member who holds no roster (spectator / waiting for a seat). */
  seat: number | null;
  is_player: boolean;
  is_commissioner: boolean;
  /** Per-league name, copied from the profile at join time. Null renders as "Manager". */
  display_name: string | null;
  joined_at: string;
}

/** league_invites table — a shareable join code. Readable only by commissioners. */
export interface LeagueInvite {
  code: string;
  league_id: string;
  created_by: string | null;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  revoked_at: string | null;
  created_at: string;
}

/**
 * stages table — one league's draftable stages (18 weeks + 4 postseason).
 *
 * `id` is a uuid, NOT the small integer it was in the single-league app —
 * stage ids are not guessable and not comparable across leagues. Address a
 * stage as (league_id, ordinal); sort and display by `ordinal`.
 *
 * (season, season_type, week_num) is the join key into the global NflWeekStats
 * and NflGame. season_type/week_num are null on the four postseason rows,
 * which ship unaddressed on purpose — see 0004_league_tables.sql.
 */
export interface Stage {
  id: string;
  league_id: string;
  name: string;
  /** Draft/display order, 1..22. Always sort by this; never hardcode a stage list. */
  ordinal: number;
  season: number;
  /** Tank01 seasonType, or null when this stage has no confirmed week addressing. */
  season_type: string | null;
  /** Tank01 week number, or null. See season_type. */
  week_num: number | null;
  status: StageStatus;
  created_at: string;
}

/** A stage with confirmed Tank01 addressing — what the sync jobs can actually fetch. */
export type AddressableStage = Stage & { season_type: string; week_num: number };

/** True when a stage maps to a known NFL week. Sync jobs must check before fetching. */
export function isAddressable(stage: Stage): stage is AddressableStage {
  return stage.season_type !== null && stage.week_num !== null;
}

/** draft_order table — the snake pick order for one stage (56 picks). */
export interface DraftOrderRow {
  league_id: string;
  stage_id: string;
  /** 1..56 (LEAGUE_SIZE x ROSTER_SIZE). */
  pick_number: number;
  manager_id: string | null;
}

/** roster_picks table — one row per player a manager holds in a stage. */
export interface RosterPick {
  id: string;
  league_id: string;
  stage_id: string;
  manager_id: string;
  player_id: string;
  slot_position: import("./roster").Position;
  pick_number: number | null;
  created_at: string;
}

/** weekly_results table — per-manager stage totals and rank, written at finalize time. */
export interface WeeklyResult {
  league_id: string;
  stage_id: string;
  manager_id: string;
  total_tds: number;
  total_points: number;
  qb_points: number;
  rb_points: number;
  wr_points: number;
  te_points: number;
  rank: number | null;
  finalized_at: string | null;
}

// ============================================================================
// 3. Global NFL data (shared by every league on the instance)
// ============================================================================

/** players table — the instance-wide NFL player pool. */
export interface Player {
  /** Tank01 playerID. */
  id: string;
  name: string;
  position: import("./roster").Position;
  nfl_team: string | null;
  nfl_team_id: string | null;
  status: PlayerStatus;
  status_detail: string | null;
  updated_at: string;
  last_synced_at: string | null;
}

/**
 * nfl_team_byes table — which weeks each team is off, per season.
 *
 * This replaces a `players.on_bye` boolean carried over from the single-league
 * app. One global flag could only ever describe ONE week, and on a
 * multi-league instance "the current week" is plural: league A can be drafting
 * Week 6 while league B is locked on Week 5. Whichever week the flag described,
 * it was wrong for somebody — and being wrong here is not cosmetic, because a
 * player marked on bye cannot be drafted at all.
 *
 * Keyed by week, it is simply correct for every league at once.
 */
export interface NflTeamBye {
  season: number;
  nfl_team_id: string;
  week_num: number;
}

/**
 * A player as seen FROM a particular stage — the pool row plus whether that
 * player's team is off in that stage's week.
 *
 * `on_bye` is not a column and cannot be: it is a fact about (player, week),
 * not about the player. Build these with decorateWithByes() in
 * src/lib/db/players.ts rather than assembling them by hand, so the bye set
 * always comes from the stage you are actually rendering.
 */
export type StagePlayer = Player & { on_bye: boolean };

/** nfl_games table — the NFL schedule. A stage locks at its week's first kickoff. */
export interface NflGame {
  game_id: string;
  season: number;
  season_type: string;
  week_num: number;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  game_status: string | null;
  updated_at: string;
}

/**
 * nfl_week_stats table — TD counts per player per NFL WEEK (not per stage).
 * `points` is a generated column; never write it. Join from a stage via
 * (season, season_type, week_num).
 */
export interface NflWeekStats {
  season: number;
  season_type: string;
  week_num: number;
  player_id: string;
  pass_td: number;
  rush_td: number;
  rec_td: number;
  /** Generated: pass_td*0.5 + rush_td*1.0 + rec_td*1.0. See src/lib/scoring.ts. */
  points: number;
  updated_at: string;
}

/** sync_log table — append-only record of sync job runs. Instance-wide. */
export interface SyncLog {
  id: number;
  source: SyncSource;
  status: SyncStatus;
  message: string | null;
  player_count: number | null;
  ran_at: string;
}

// ============================================================================
// Request-scoped context
// ============================================================================

/**
 * The resolved league for a request under /l/[slug], plus the caller's own
 * membership in it. Built once by the league layout and threaded down rather
 * than re-fetched per component.
 *
 * `membership` is non-null by construction: the layout 404s a non-member
 * before this is ever built, so pages can trust it.
 */
export interface LeagueContext {
  league: League;
  membership: LeagueMember;
}

/** Convenience: is the caller running this league? */
export function isCommissioner(ctx: LeagueContext): boolean {
  return ctx.membership.is_commissioner;
}

/** Convenience: does the caller hold a roster in this league? */
export function isSeatedPlayer(ctx: LeagueContext): boolean {
  return ctx.membership.is_player && ctx.membership.seat !== null;
}

/** The name to show for a member. Falls back rather than rendering an empty cell. */
export function memberName(member: Pick<LeagueMember, "display_name">): string {
  return member.display_name?.trim() || "Manager";
}
