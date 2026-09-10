// apply-locks
//
// Automates "rosters lock at first kickoff" server-side, independent of anyone
// having the app open. For every league's draft_open stage, looks up the
// earliest kickoff of the NFL week that stage addresses; if it has passed, the
// stage flips to 'locked'.
//
// THE ONLY LEAGUE-AWARE SYNC JOB. The other three write global NFL tables and
// never name a league; this one writes `stages`, which is league-scoped. It
// still runs instance-wide in a single pass — every league's due stages lock
// in one run, because a league whose lock is late is a league where someone
// can still edit a roster after kickoff.
//
// Where the kickoff comes from: the single-league app read
// stages.first_kickoff_at, a per-league copy of a per-week fact. That column is
// gone. The kickoff now lives on nfl_games, and this job takes the MIN over the
// stage's (season, season_type, week_num).
//
// Makes NO Tank01 calls — it is pure database work, which is why it can run
// every few minutes without touching the quota.
//
// Idempotent: running it with nothing newly due is a no-op that still logs a
// success row with locked=0.
import { NextResponse } from "next/server";
import { describeWeek, weekKeyId, type WeekKey } from "@/lib/tank01";
import { isAddressable, type AddressableStage, type Stage } from "@/lib/types";
import {
  authorizeCron,
  errorMessage,
  writeSyncLog,
  type ServiceClient,
  serviceClientOrError,
} from "../_lib/cron";
import { describeSkipped } from "../_lib/weeks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Earliest scheduled kickoff of one NFL week, or null when the schedule for
 * that week hasn't been synced yet (or carries no kickoff times).
 *
 * A missing kickoff must never lock a stage: "we don't know when this week
 * starts" and "this week has started" are opposite states, and confusing them
 * would close a draft that was still legitimately open.
 */
async function firstKickoffOf(
  supabase: ServiceClient,
  week: WeekKey,
): Promise<Date | null> {
  const { data, error } = await supabase
    .from("nfl_games")
    .select("kickoff_at")
    .eq("season", week.season)
    .eq("season_type", week.season_type)
    .eq("week_num", week.week_num)
    .not("kickoff_at", "is", null)
    .order("kickoff_at", { ascending: true })
    .limit(1);

  if (error) throw new Error(`nfl_games lookup for ${describeWeek(week)} failed: ${error.message}`);
  const raw = data?.[0]?.kickoff_at as string | undefined;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

async function run(req: Request): Promise<NextResponse> {
  const denied = authorizeCron(req);
  if (denied) return denied;

  const svc = serviceClientOrError();
  if ("error" in svc) return svc.error;
  const supabase = svc.client;

  try {
    const now = new Date();

    const { data, error } = await supabase
      .from("stages")
      .select("*")
      .eq("status", "draft_open");
    if (error) throw new Error(`stages select failed: ${error.message}`);

    const open = (data ?? []) as Stage[];
    const addressable: AddressableStage[] = [];
    const unaddressed: Stage[] = [];
    for (const stage of open) {
      // An unaddressed stage has no week to look a kickoff up in. Skipping is
      // the safe direction: it leaves the draft open for a commissioner to
      // close by hand, where guessing a week could lock it days early.
      if (isAddressable(stage)) addressable.push(stage);
      else unaddressed.push(stage);
    }

    // One kickoff lookup per distinct week, not per stage: every league whose
    // Week 5 is open shares the same first kickoff.
    const kickoffs = new Map<string, Date | null>();
    const due: AddressableStage[] = [];
    const waiting: AddressableStage[] = [];
    const unscheduled: AddressableStage[] = [];

    for (const stage of addressable) {
      const week: WeekKey = {
        season: stage.season,
        season_type: stage.season_type,
        week_num: stage.week_num,
      };
      const id = weekKeyId(week);
      if (!kickoffs.has(id)) kickoffs.set(id, await firstKickoffOf(supabase, week));
      const kickoff = kickoffs.get(id) ?? null;

      if (!kickoff) unscheduled.push(stage);
      else if (kickoff <= now) due.push(stage);
      else waiting.push(stage);
    }

    if (due.length > 0) {
      const { error: updErr } = await supabase
        .from("stages")
        .update({ status: "locked" })
        .in(
          "id",
          due.map((s) => s.id),
        )
        // Belt-and-suspenders re-check for idempotency under races: a
        // commissioner may have locked or finalized one of these by hand
        // between the select and here.
        .eq("status", "draft_open");
      if (updErr) throw new Error(`stages lock update failed: ${updErr.message}`);
    }

    const msg =
      (due.length > 0
        ? `Locked ${due.length} stage(s): ${due
            .map((s) => `${s.name} (${describeWeek({ season: s.season, season_type: s.season_type, week_num: s.week_num })})`)
            .join(", ")}.`
        : "No draft_open stage is past its week's first kickoff — nothing to lock.") +
      (waiting.length > 0 ? ` ${waiting.length} still open before kickoff.` : "") +
      (unscheduled.length > 0
        ? ` ${unscheduled.length} open stage(s) have no synced kickoff yet and ` +
          `were left open — run sync-schedule.`
        : "") +
      describeSkipped(unaddressed);
    await writeSyncLog(supabase, "locks", "success", msg, null);

    return NextResponse.json({
      ok: true,
      lockedCount: due.length,
      lockedStages: due.map((s) => ({ id: s.id, league_id: s.league_id, name: s.name })),
      stillOpen: waiting.length,
      awaitingSchedule: unscheduled.length,
      unaddressedStages: unaddressed.length,
    });
  } catch (err) {
    const msg = errorMessage(err);
    await writeSyncLog(supabase, "locks", "error", msg, null);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
