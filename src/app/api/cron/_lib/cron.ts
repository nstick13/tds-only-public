// Shared plumbing for the four sync jobs under /api/cron.
//
// Underscore-prefixed folder: Next.js treats it as private, so nothing in here
// is routable. Only a `route.ts` becomes an endpoint.
//
// ===========================================================================
// CRON CADENCES AND THE CALL BUDGET
// ===========================================================================
// The schedules live in vercel.json, which is strict JSON and cannot carry a
// comment, so the reasoning lives here. Ported from the pg_cron budget in
// reference-league/supabase/migrations/0004_cron.sql and the day-of-week fix
// in 0011_sync_scores_every_day.sql.
//
//   sync-players    0 */6 * * *     4 runs/day x ~3 paginated calls  = ~12/day
//   sync-schedule   30 */12 * * *   2 runs/day x (1 getNFLTeams + 1 per
//                                   distinct live week) = ~4-6/day
//   sync-scores     */30 * * * *    48 runs/day x (1 getNFLGamesForWeek per
//                                   distinct live week + one box score per
//                                   game that can still change)
//   apply-locks     */5 * * * *     0 API calls — pure database work, so it
//                                   costs nothing and stays frequent. A late
//                                   lock means someone edits a roster after
//                                   kickoff.
//
// Tank01 Pro allows 1,000 calls/DAY for the WHOLE INSTANCE. sync-scores is the
// only job whose cost varies: its floor is ~48/day (one schedule call per run
// when nothing is live) and its worst case, a full 16-game Sunday, lands near
// 250-300. Steady-state total is well under a third of the allowance.
//
// Crucially that total does NOT grow with the number of leagues. Stats are
// keyed by NFL week, and resolveTargetWeeks() dedupes every league's live
// stages down to distinct weeks before any fetch — see _lib/weeks.ts. Fifty
// leagues playing Week 5 cost exactly what one league costs.
//
// NO DAY-OF-WEEK WINDOWS. The single-league app polled for scores only inside
// hand-written UTC game-day windows, which encoded an assumption the NFL does
// not honour: that games are played Thursday through Monday. A Wednesday-night
// opener (Wed 8:20pm ET is Thursday in UTC), Black Friday and Christmas Day all
// break it, and the 2026 Week 1 opener went completely unpolled because of it.
// Every night game already lands on the NEXT UTC day, which is what made the
// windows so easy to get wrong in the first place. Do not reintroduce them —
// the headroom to just run all week was always there.
//
// VERCEL HOBBY PLAN LIMITATION: Hobby allows only 2 cron jobs, and triggers
// them once per day (the schedule is treated as a daily hint, not honoured
// minute-by-minute). The four schedules above are what is CORRECT on Pro and
// are written for Pro. On Hobby this app cannot lock rosters at kickoff or
// follow a live slate at all; run it on Pro, or drive these routes from an
// external scheduler with the same Bearer token.
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import type { SyncSource, SyncStatus } from "@/lib/types";
import { currentSeason, type WeekKey } from "@/lib/tank01";
import { timingSafeEqual } from "node:crypto";

/**
 * The service-role client, typed from the factory rather than as `any`, so a
 * typo in a column name is still caught where it can be.
 */
export type ServiceClient = ReturnType<typeof createServiceRoleClient>;

/**
 * Verify `Authorization: Bearer $CRON_SECRET`, which Vercel Cron sends
 * automatically and the in-app manual trigger sends by hand.
 *
 * Returns a Response to send back, or null when the caller may proceed.
 *
 * An UNSET CRON_SECRET is a hard refusal, not a bypass. These routes hold the
 * service role key: they write every global table and read across every
 * league, so "no secret configured" must never degrade into "open to
 * anyone" — an unauthenticated caller could burn the whole instance's Tank01
 * budget in a minute. 503 rather than 401 because the fault is the
 * deployment's, not the caller's.
 */
export function authorizeCron(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET is not set, so this job refuses to run rather than " +
          "running unauthenticated. Set it in the Vercel project's " +
          "environment variables (see .env.example).",
      },
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization") ?? "";
  if (!timingSafeEquals(header, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Constant-time string comparison.
 *
 * `a !== b` on secrets returns as soon as it finds a differing byte, which
 * leaks the length of the matching prefix through response timing. Over the
 * public internet that signal is buried in network jitter and this is not a
 * realistic attack on a 32-byte random secret — but the correct comparison is
 * three lines, and this file is the thing anyone forking the repo will copy.
 *
 * timingSafeEqual() throws on length mismatch (a length difference is not
 * secret), so compare lengths first and return early.
 */
function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Write one row to sync_log. Never throws — a logging failure must not mask
 * the real error, and the caller has already decided what to return.
 *
 * Every job writes EXACTLY ONE of these per run, success or error: the
 * freshness line in the UI reads the newest successful row per source, so a
 * run that logs twice makes "last updated" mean something else.
 */
export async function writeSyncLog(
  supabase: ServiceClient,
  source: SyncSource,
  status: SyncStatus,
  message: string,
  playerCount: number | null = null,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("sync_log")
      .insert({ source, status, message, player_count: playerCount });
    if (error) {
      console.error(`Failed to write sync_log row for ${source}:`, error);
    }
  } catch (err) {
    console.error(`Exception writing sync_log row for ${source}:`, err);
  }
}

/** An explicitly requested week, plus the flag that suppresses the watermark. */
export interface CronRequest {
  /** Set when the caller named a specific week; null means "whatever is live". */
  week: WeekKey | null;
  /** True when `week` came from the caller — see the watermark note in sync-scores. */
  explicit: boolean;
}

/**
 * Read an optional `?season=&season_type=&week=` override, from the query
 * string (GET, which is what Vercel Cron issues) or from a JSON POST body
 * (the in-app manual trigger).
 *
 * This is the commissioner's one path for re-running a specific week to repair
 * it, so it deliberately bypasses every "is this week live" filter below.
 * `season` defaults to the current one; `season_type` and `week` must both be
 * given or neither — a half-address would send week=null to Tank01 and read as
 * "no games this week" rather than "you asked for nothing".
 */
export async function readCronRequest(req: Request): Promise<CronRequest> {
  const url = new URL(req.url);
  let raw: Record<string, unknown> = {};

  for (const key of ["season", "season_type", "week"]) {
    const v = url.searchParams.get(key);
    if (v !== null) raw[key] = v;
  }

  if (req.method === "POST" && Object.keys(raw).length === 0) {
    try {
      const body: unknown = await req.json();
      if (body && typeof body === "object") raw = body as Record<string, unknown>;
    } catch {
      // No body, or not JSON. An empty POST is the normal manual-trigger case.
    }
  }

  const seasonType =
    typeof raw.season_type === "string" && raw.season_type.trim().length > 0
      ? raw.season_type.trim()
      : null;
  const weekNum = toPositiveInt(raw.week);

  if (seasonType === null && weekNum === null) return { week: null, explicit: false };
  if (seasonType === null || weekNum === null) {
    throw new Error(
      "Partial week override: season_type and week must be given together " +
        `(got season_type=${JSON.stringify(raw.season_type)}, ` +
        `week=${JSON.stringify(raw.week)}).`,
    );
  }

  return {
    week: {
      season: toPositiveInt(raw.season) ?? currentSeason(),
      season_type: seasonType,
      week_num: weekNum,
    },
    explicit: true,
  };
}

function toPositiveInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Message text for a caught error, without leaking a non-Error's shape. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
