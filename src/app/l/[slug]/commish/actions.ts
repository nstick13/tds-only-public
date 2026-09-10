"use server";

/**
 * Commissioner server actions.
 *
 * THE RULE FOR EVERY ACTION HERE: take the league slug from the route,
 * re-resolve it with requireLeague(), and read is_commissioner off the
 * caller's own league_members row. Never accept a league id (or a "yes I'm
 * the commissioner") from the client — an action is an HTTP endpoint, and the
 * only trustworthy thing in its arguments is which route it belongs to.
 *
 * RLS enforces all of this again on the underlying writes. The checks here
 * exist so a refusal reads as a sentence rather than a raw policy denial.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { notifyDraftOpen, notifyOnTheClock, notifyWeekFinal } from "@/lib/push/notify";
import { createClient } from "@/lib/supabase/server";
import { requireLeague } from "@/lib/league/context";
import {
  getDraftOrder,
  getMembers,
  getRosterPicks,
  getSeatedMembers,
  getStageById,
  getStages,
  getStageStats,
} from "@/lib/db";
import { generateDraftOrder, type StandingsSeed } from "@/lib/draftOrder";
import {
  MAX_LEAGUE_SIZE,
  MIN_LEAGUE_SIZE,
  isValidLeagueSize,
} from "@/lib/league";
import { timeUntil } from "@/lib/timeAgo";
import { computeStandings } from "@/lib/standings";
import { memberName, type LeagueContext } from "@/lib/types";
import type {
  ActionResult,
  ActionFailure,
  ManualRosterEditInput,
  MemberAdminUpdate,
  ReplaceRosterPickInput,
  SyncSourceTrigger,
} from "./types";

/**
 * Resolves the league and confirms the caller runs it. Returns the context on
 * success, or a ready-to-return failure — so every action starts with the
 * same three lines and cannot forget the check.
 */
async function requireCommissioner(
  slug: string,
): Promise<{ ctx: LeagueContext } | { failure: ActionFailure }> {
  const ctx = await requireLeague(slug);
  if (!ctx.membership.is_commissioner) {
    return {
      failure: { success: false, message: "Commissioner access required." },
    };
  }
  return { ctx };
}

/** The LeagueRef the notification copy needs. */
function leagueRef(ctx: LeagueContext) {
  return { id: ctx.league.id, slug: ctx.league.slug, name: ctx.league.name };
}

function friendlyDbError(message: string): string {
  if (message.includes("Roster limit exceeded")) return message;
  if (message.includes("roster_picks_stage_player_unique")) {
    return "That player is already on a roster for this stage.";
  }
  if (message.includes("league_members_seat_unique")) {
    return "Another member already holds that seat. Free it first.";
  }
  if (message.includes("league_members_seat_matches_player")) {
    return "A seat and player status have to move together — that's a bug, not your input.";
  }
  return message;
}

/** Revalidates the three league pages any commissioner write can move. */
function revalidateLeague(slug: string) {
  revalidatePath(`/l/${slug}/commish`);
  revalidatePath(`/l/${slug}/draft`);
  revalidatePath(`/l/${slug}`);
}

async function writeDraftOrderRows(
  stageId: string,
  picks: string[],
): Promise<string | null> {
  const supabase = await createClient();

  const { error: deleteError } = await supabase
    .from("draft_order")
    .delete()
    .eq("stage_id", stageId);
  if (deleteError) return deleteError.message;

  // No league_id: set_league_id_from_stage() derives it from stage_id.
  const rows = picks.map((managerId, i) => ({
    stage_id: stageId,
    pick_number: i + 1,
    manager_id: managerId,
  }));

  const { error: insertError } = await supabase.from("draft_order").insert(rows);
  if (insertError) return insertError.message;

  return null;
}

/** Confirms a stage id names a stage of THIS league before acting on it. */
async function stageInLeague(ctx: LeagueContext, stageId: string) {
  const stage = await getStageById(stageId);
  return stage && stage.league_id === ctx.league.id ? stage : null;
}

/**
 * Opens the season: generates a random round-1 order for the lowest-ordinal
 * stage (Week 1), writes its draft_order, and flips that stage to draft_open.
 *
 * Refuses below 2 seated managers — a one-person snake draft is not a draft,
 * it is picking every player in a row, and the loser's-draft seeding that
 * shapes every following week has nothing to work with. Warns rather than
 * refuses between 2 and 8: a short league is a legitimate way to try the app
 * out, and it will still play correctly.
 */
export async function openSeasonAction(slug: string): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  const stages = await getStages(ctx.league.id);
  const firstStage = [...stages].sort((a, b) => a.ordinal - b.ordinal)[0];
  if (!firstStage) return { success: false, message: "No stages exist yet." };

  const existingOrder = await getDraftOrder(firstStage.id);
  if (existingOrder.some((r) => r.manager_id)) {
    return {
      success: false,
      message: `${firstStage.name} already has a draft order — season already opened.`,
    };
  }

  const members = await getSeatedMembers(ctx.league.id);
  if (members.length < 2) {
    return {
      success: false,
      message:
        `Only ${members.length} manager${members.length === 1 ? " is" : "s are"} ` +
        "seated. You need at least 2 to draft — share an invite link from the " +
        "Members section below.",
    };
  }

  const managerIds = members.map((m) => m.user_id);
  const picks = generateDraftOrder(managerIds, null);

  const writeError = await writeDraftOrderRows(firstStage.id, picks);
  if (writeError) return { success: false, message: friendlyDbError(writeError) };

  const supabase = await createClient();
  const { error: statusError } = await supabase
    .from("stages")
    .update({ status: "draft_open" })
    .eq("id", firstStage.id);
  if (statusError) return { success: false, message: friendlyDbError(statusError.message) };

  // The league is running now, not merely set up.
  await supabase.from("leagues").update({ status: "active" }).eq("id", ctx.league.id);

  // generateDraftOrder returns manager ids in pick order, so index 0 is the
  // manager on the clock for pick #1.
  await notifyDraftOpen(leagueRef(ctx), firstStage.name);
  if (picks[0]) {
    await notifyOnTheClock(leagueRef(ctx), picks[0], firstStage.name, 1);
  }

  revalidateLeague(slug);
  const warning =
    members.length < ctx.league.size
      ? ` (${members.length}/${ctx.league.size} seats filled — it'll play fine, but you'll want the full ${ctx.league.size} for the real thing)`
      : "";
  return {
    success: true,
    message: `${firstStage.name} draft opened — order randomized.${warning}`,
    data: undefined,
  };
}

/**
 * The core weekly-redraft loop: computes and finalizes standings for
 * `stageId`, then opens the next stage (by ordinal) with its draft order
 * seeded by those standings (last place picks first). If there is no next
 * stage, the season is over — this just finalizes.
 */
export async function finalizeAndAdvanceAction(
  slug: string,
  stageId: string,
): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  const stage = await stageInLeague(ctx, stageId);
  if (!stage) return { success: false, message: "Stage not found in this league." };
  if (stage.status === "finalized") {
    return { success: false, message: `${stage.name} is already finalized.` };
  }

  const [rosterPicks, members, stats] = await Promise.all([
    getRosterPicks(stageId),
    getSeatedMembers(ctx.league.id),
    // Stats come from the global nfl_week_stats via the stage's NFL week.
    // An unaddressed postseason stage yields [], and everyone scores zero —
    // which is the honest answer for a week we never taught Tank01 to fetch.
    getStageStats(stage),
  ]);
  const managerIds = members.map((m) => m.user_id);

  const standings = computeStandings(rosterPicks, stats, managerIds);

  // No league_id: the weekly_results trigger derives it from stage_id.
  const resultRows = standings.map((s) => ({
    stage_id: stageId,
    manager_id: s.manager_id,
    total_tds: s.total_tds,
    total_points: s.total_points,
    qb_points: s.qb_points,
    rb_points: s.rb_points,
    wr_points: s.wr_points,
    te_points: s.te_points,
    rank: s.rank,
    finalized_at: new Date().toISOString(),
  }));

  const supabase = await createClient();
  const { error: upsertError } = await supabase
    .from("weekly_results")
    .upsert(resultRows, { onConflict: "stage_id,manager_id" });
  if (upsertError) return { success: false, message: friendlyDbError(upsertError.message) };

  const { error: finalizeError } = await supabase
    .from("stages")
    .update({ status: "finalized" })
    .eq("id", stageId);
  if (finalizeError) return { success: false, message: friendlyDbError(finalizeError.message) };

  // Announced once here rather than at each return below, so every exit path
  // (season over, next stage already seeded, normal advance) tells the league.
  const winner = standings.find((s) => s.rank === 1) ?? null;
  const winnerMember = winner
    ? members.find((m) => m.user_id === winner.manager_id)
    : undefined;
  await notifyWeekFinal(
    leagueRef(ctx),
    stage.name,
    winnerMember ? memberName(winnerMember) : winner ? "Someone" : null,
    winner?.total_points ?? null,
  );

  const stages = await getStages(ctx.league.id);
  const nextStage = stages
    .filter((s) => s.ordinal > stage.ordinal)
    .sort((a, b) => a.ordinal - b.ordinal)[0];

  if (!nextStage) {
    await supabase
      .from("leagues")
      .update({ status: "complete" })
      .eq("id", ctx.league.id);
    revalidateLeague(slug);
    return {
      success: true,
      message: `${stage.name} finalized. That was the last stage — season complete!`,
      data: undefined,
    };
  }

  const nextExistingOrder = await getDraftOrder(nextStage.id);
  if (nextExistingOrder.some((r) => r.manager_id)) {
    revalidateLeague(slug);
    return {
      success: true,
      message: `${stage.name} finalized, but ${nextStage.name} already had a draft order — left as-is.`,
      data: undefined,
    };
  }

  const seed: StandingsSeed[] = standings.map((s) => ({
    manager_id: s.manager_id,
    rank: s.rank,
  }));
  const nextPicks = generateDraftOrder(managerIds, seed);

  const writeError = await writeDraftOrderRows(nextStage.id, nextPicks);
  if (writeError) return { success: false, message: friendlyDbError(writeError) };

  const { error: openError } = await supabase
    .from("stages")
    .update({ status: "draft_open" })
    .eq("id", nextStage.id);
  if (openError) return { success: false, message: friendlyDbError(openError.message) };

  await notifyDraftOpen(leagueRef(ctx), nextStage.name);
  if (nextPicks[0]) {
    await notifyOnTheClock(leagueRef(ctx), nextPicks[0], nextStage.name, 1);
  }

  revalidateLeague(slug);
  return {
    success: true,
    message: `${stage.name} finalized. ${nextStage.name} draft opened, seeded by standings (last place picks first).`,
    data: undefined,
  };
}

/**
 * Overwrites a stage's draft order: re-snakes every pick from a new round-1
 * seed order (a permutation of the seated managers). Refuses if the stage
 * already has picks made, to avoid invalidating an in-progress draft board.
 */
export async function updateDraftOrderAction(
  slug: string,
  stageId: string,
  roundOneOrder: string[],
): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  const stage = await stageInLeague(ctx, stageId);
  if (!stage) return { success: false, message: "Stage not found in this league." };

  const members = await getSeatedMembers(ctx.league.id);
  const managerIds = members.map((m) => m.user_id);

  const isPermutation =
    roundOneOrder.length === managerIds.length &&
    new Set(roundOneOrder).size === managerIds.length &&
    roundOneOrder.every((id) => managerIds.includes(id));
  if (!isPermutation) {
    return {
      success: false,
      message: "Round-1 order must include every seated manager exactly once.",
    };
  }

  const existingPicks = await getRosterPicks(stageId);
  if (existingPicks.length > 0) {
    return {
      success: false,
      message: "Can't edit the draft order — picks have already been made this stage.",
    };
  }

  // Re-seed by manufacturing a rank list that sorts (via
  // seedRoundOneFromStandings' rank-descending sort inside generateDraftOrder)
  // back into exactly roundOneOrder: give the first manager the highest rank
  // number so it sorts first, and so on down.
  const seed: StandingsSeed[] = roundOneOrder.map((managerId, i) => ({
    manager_id: managerId,
    rank: roundOneOrder.length - i,
  }));
  const picks = generateDraftOrder(managerIds, seed);

  const writeError = await writeDraftOrderRows(stageId, picks);
  if (writeError) return { success: false, message: friendlyDbError(writeError) };

  revalidateLeague(slug);
  return { success: true, message: `${stage.name} draft order updated.`, data: undefined };
}

/**
 * Swaps an already-drafted player for another, keeping the original manager,
 * roster slot and pick_number.
 *
 * Delegates the whole thing to the replace_roster_pick RPC rather than
 * issuing a delete and an insert from here. That makes it one transaction: a
 * rejected insert — the replacement was just taken, the roster trigger fires
 * — rolls the removal back instead of leaving the manager a player short. It
 * also preserves pick_number, which the two-statement path dropped. The RPC
 * re-checks commissionership of the stage's league itself, so it is safe even
 * against a stage id from somewhere else; we check first only for the
 * friendlier message.
 */
export async function replaceRosterPickAction(
  input: ReplaceRosterPickInput,
): Promise<ActionResult> {
  const guard = await requireCommissioner(input.slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  if (!(await stageInLeague(ctx, input.stageId))) {
    return { success: false, message: "Stage not found in this league." };
  }
  if (!input.outPlayerId || !input.inPlayerId) {
    return { success: false, message: "Choose the player to replace and their replacement." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("replace_roster_pick", {
    // uuid now, not the small int the single-league app passed.
    p_stage_id: input.stageId,
    p_out_player_id: input.outPlayerId,
    p_in_player_id: input.inPlayerId,
  });

  if (error) return { success: false, message: friendlyDbError(error.message) };

  const row = (Array.isArray(data) ? data : [data])[0] as
    | {
      slot_position: string;
      pick_number: number | null;
      out_player_name: string;
      in_player_name: string;
    }
    | undefined;

  revalidateLeague(input.slug);

  const where = row?.pick_number != null ? ` (pick #${row.pick_number})` : "";
  return {
    success: true,
    message: row
      ? `Replaced ${row.out_player_name} with ${row.in_player_name} in the ${row.slot_position} slot${where}.`
      : "Pick replaced.",
    data: undefined,
  };
}

/**
 * Changes how many managers a league seats.
 *
 * Allowed at any time, not just during setup — the common case is a
 * commissioner who planned for eight, got six, and would rather run a real
 * six-manager league than three empty seats and a short draft every week.
 *
 * Shrinking below an occupied seat is refused by a database trigger
 * (enforce_size_fits_seated), not here: the check has to be atomic against
 * someone accepting an invite at the same moment. This re-checks first only
 * so the usual case gets a sentence naming who is in the way instead of a
 * raw constraint error.
 */
export async function updateLeagueSizeAction(
  slug: string,
  size: number,
): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  if (!isValidLeagueSize(size)) {
    return {
      success: false,
      message: `A league seats between ${MIN_LEAGUE_SIZE} and ${MAX_LEAGUE_SIZE} managers.`,
    };
  }

  if (size === ctx.league.size) {
    return { success: false, message: `Already ${size} seats.` };
  }

  const members = await getMembers(ctx.league.id);
  const highest = members.reduce<number>(
    (max, m) => (m.seat !== null && m.seat > max ? m.seat : max),
    0,
  );
  if (size < highest) {
    const blocking = members.find((m) => m.seat === highest);
    return {
      success: false,
      message:
        `Seat ${highest} is taken by ${blocking ? memberName(blocking) : "a manager"}. ` +
        `Move or remove them before shrinking to ${size}.`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("leagues")
    .update({ size })
    .eq("id", ctx.league.id);
  if (error) return { success: false, message: friendlyDbError(error.message) };

  revalidateLeague(slug);
  return {
    success: true,
    message: `League now seats ${size}.`,
    data: undefined,
  };
}

/**
 * Manual roster correction (the deliberate post-lock injury-swap path).
 * Commissioner RLS permits roster_picks writes in any stage status. Remove
 * and/or add a player for one manager in one stage.
 */
export async function manualRosterEditAction(
  input: ManualRosterEditInput,
): Promise<ActionResult> {
  const guard = await requireCommissioner(input.slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  if (!(await stageInLeague(ctx, input.stageId))) {
    return { success: false, message: "Stage not found in this league." };
  }
  if (!input.removePlayerId && !input.addPlayerId) {
    return { success: false, message: "Nothing to do — pick a player to remove and/or add." };
  }
  if (input.addPlayerId && !input.slotPosition) {
    return { success: false, message: "Choose a roster slot for the player being added." };
  }

  const supabase = await createClient();

  if (input.removePlayerId) {
    const { error } = await supabase
      .from("roster_picks")
      .delete()
      .eq("stage_id", input.stageId)
      .eq("manager_id", input.managerId)
      .eq("player_id", input.removePlayerId);
    if (error) return { success: false, message: friendlyDbError(error.message) };
  }

  if (input.addPlayerId && input.slotPosition) {
    const { error } = await supabase.from("roster_picks").insert({
      stage_id: input.stageId,
      manager_id: input.managerId,
      player_id: input.addPlayerId,
      slot_position: input.slotPosition,
      pick_number: null,
    });
    if (error) return { success: false, message: friendlyDbError(error.message) };
  }

  revalidateLeague(input.slug);
  return { success: true, message: "Roster updated.", data: undefined };
}

// ============================================================================
// Member admin
//
// This section is the public version's answer to a step the private app
// punted on entirely: "go edit the profiles table in Supabase Studio". Seats,
// commissioners and invites all live here now, because a stranger who starts
// a league has no Studio and should not need one.
// ============================================================================

/**
 * Changes one member's seat and/or commissioner flag.
 *
 * seat and is_player move together, always: a CHECK constraint requires
 * `(seat is null) = (is_player is false)`, because the draft derives its
 * round count from the seated managers and a seat with is_player=false would
 * silently produce a short draft. So callers set a seat (or clear it) and
 * is_player follows — there is no reason to expose it separately.
 */
export async function updateMemberAction(
  update: MemberAdminUpdate,
): Promise<ActionResult> {
  const guard = await requireCommissioner(update.slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  if (
    update.seat !== undefined &&
    update.seat !== null &&
    (update.seat < 1 || update.seat > ctx.league.size)
  ) {
    return {
      success: false,
      message: `Seat must be between 1 and ${ctx.league.size}.`,
    };
  }

  const supabase = await createClient();

  // The last commissioner may not demote themselves. RLS can't express this
  // (it's a property of the league, not of the row), and a league with nobody
  // able to administer it needs a support ticket to fix — there is no support.
  if (
    update.is_commissioner === false &&
    update.userId === ctx.membership.user_id
  ) {
    const { count, error } = await supabase
      .from("league_members")
      .select("user_id", { count: "exact", head: true })
      .eq("league_id", ctx.league.id)
      .eq("is_commissioner", true);
    if (error) return { success: false, message: friendlyDbError(error.message) };
    if ((count ?? 0) <= 1) {
      return {
        success: false,
        message:
          "You're the only commissioner. Promote someone else before stepping down.",
      };
    }
  }

  const patch: Record<string, unknown> = {};
  if (update.seat !== undefined) {
    patch.seat = update.seat;
    patch.is_player = update.seat !== null;
  }
  if (update.is_commissioner !== undefined) {
    patch.is_commissioner = update.is_commissioner;
  }

  if (Object.keys(patch).length === 0) {
    return { success: false, message: "Nothing to update." };
  }

  const { error } = await supabase
    .from("league_members")
    .update(patch)
    .eq("league_id", ctx.league.id)
    .eq("user_id", update.userId);
  if (error) return { success: false, message: friendlyDbError(error.message) };

  revalidateLeague(update.slug);
  return { success: true, message: "Member updated.", data: undefined };
}

/**
 * Removes a member from the league entirely, freeing their seat.
 *
 * Their roster_picks go with them (ON DELETE CASCADE from profiles is not
 * what fires here — the picks reference the member's user id and stay, which
 * is deliberate: a finalized week's box score should not change because
 * someone left in November). What they lose is access and their seat.
 */
export async function removeMemberAction(
  slug: string,
  userId: string,
): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  if (userId === ctx.membership.user_id) {
    return {
      success: false,
      message:
        "You can't remove yourself here — that would risk leaving the league " +
        "with no commissioner.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("league_members")
    .delete()
    .eq("league_id", ctx.league.id)
    .eq("user_id", userId);
  if (error) return { success: false, message: friendlyDbError(error.message) };

  revalidateLeague(slug);
  return { success: true, message: "Member removed.", data: undefined };
}

/** Mints a fresh invite link. Returns the code; the UI builds the URL. */
export async function createInviteAction(
  slug: string,
): Promise<ActionResult<{ code: string }>> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_league_invite", {
    p_league_id: ctx.league.id,
    p_expires_in_days: 7,
    p_max_uses: null,
  });

  if (error) return { success: false, message: friendlyDbError(error.message) };

  const code = typeof data === "string" ? data : String(data ?? "");
  if (!code) return { success: false, message: "The invite came back empty." };

  revalidatePath(`/l/${slug}/commish`);
  return { success: true, message: "New invite link ready.", data: { code } };
}

/**
 * Revokes an invite. A soft revoke (revoked_at) rather than a delete, so
 * get_invite_preview can tell someone holding the link "this was revoked"
 * instead of "no such invite" — which sounds like they mistyped it.
 */
export async function revokeInviteAction(
  slug: string,
  code: string,
): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;
  const { ctx } = guard;

  const supabase = await createClient();
  const { error } = await supabase
    .from("league_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("code", code)
    .eq("league_id", ctx.league.id);

  if (error) return { success: false, message: friendlyDbError(error.message) };

  revalidatePath(`/l/${slug}/commish`);
  return { success: true, message: "Invite revoked.", data: undefined };
}

// ============================================================================
// Manual sync
// ============================================================================

/** One row of claim_manual_sync's result set (0005_functions.sql). */
interface ClaimRow {
  claimed: boolean;
  run_id: number | null;
  available_at: string;
  blocked_by: string | null;
}

/** The cron route behind each hand-triggerable job. */
const SYNC_ROUTE: Record<SyncSourceTrigger, string> = {
  players: "sync-players",
  scores: "sync-scores",
};

/**
 * Hand-triggers one of the sync jobs.
 *
 * The jobs are Next route handlers on this same deployment now, not Supabase
 * Edge Functions, so this posts to our own origin with the CRON_SECRET the
 * routes expect. That origin is read from the request headers rather than
 * configured: on Vercel the public host arrives in x-forwarded-host, and
 * hard-coding a URL breaks every preview deployment.
 *
 * Rate limited to one trigger per hour per job, ACROSS THE WHOLE INSTANCE —
 * not per league. The Tank01 budget is shared by every league here, and
 * because stats are fetched per NFL week rather than per league, one run
 * serves them all; letting fifty commissioners each force a refresh would
 * spend the day's calls on the same data fifty times. The window is claimed
 * in the database (claim_manual_sync), so it holds across users and app
 * instances and two simultaneous clicks can't both win.
 *
 * The claim is taken BEFORE the call and released if the call doesn't go
 * through, so a failed trigger doesn't cost everyone an hour.
 */
export async function triggerSyncAction(
  slug: string,
  source: SyncSourceTrigger,
): Promise<ActionResult> {
  const guard = await requireCommissioner(slug);
  if ("failure" in guard) return guard.failure;

  const job = SYNC_ROUTE[source];
  if (!job) return { success: false, message: `Unknown sync job "${source}".` };

  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return {
      success: false,
      message:
        "CRON_SECRET isn't set, so the sync jobs refuse to run at all. Add it " +
        "to the deployment's environment variables and redeploy.",
    };
  }

  // claim_manual_sync is a set-returning function, so rpc() hands back a
  // one-row array. claimed=false means the instance's hourly window for this
  // job is still running — a normal answer, not an error.
  const supabase = await createClient();
  const { data: claimData, error: claimError } = await supabase.rpc("claim_manual_sync", {
    p_source: source,
  });

  if (claimError) {
    return { success: false, message: `Couldn't check the sync cooldown: ${claimError.message}` };
  }

  const claim = ((Array.isArray(claimData) ? claimData : [claimData]) as ClaimRow[])[0];
  if (!claim) {
    return { success: false, message: "Couldn't check the sync cooldown — please try again." };
  }

  if (!claim.claimed) {
    const who = claim.blocked_by ? `${claim.blocked_by} ` : "Someone ";
    return {
      success: false,
      message: `${who}already ran ${job} — it unlocks again ${timeUntil(claim.available_at)}.`,
    };
  }

  const releaseClaim = async () => {
    if (claim.run_id == null) return;
    await supabase.rpc("release_manual_sync", { p_run_id: claim.run_id });
  };

  const headerList = headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  if (!host) {
    await releaseClaim();
    return { success: false, message: "Couldn't work out this app's own address." };
  }
  const url = `${proto}://${host}/api/cron/${job}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await releaseClaim();
      return {
        success: false,
        message: `${job} responded with ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}.`,
      };
    }

    revalidateLeague(slug);
    return {
      success: true,
      message: `${job} triggered. It unlocks again ${timeUntil(claim.available_at)}.`,
      data: undefined,
    };
  } catch (err) {
    await releaseClaim();
    // Report what actually went wrong rather than guessing at a cause: this
    // catches any throw from the call — DNS, TLS, a timeout — and undici
    // nests the useful part in err.cause ("fetch failed" -> "getaddrinfo
    // ENOTFOUND ..."), so unwrap one level. Nothing secret appears in the
    // message: the URL is this app's own public address, and CRON_SECRET only
    // ever travelled in a header we built ourselves.
    console.error(`triggerSyncAction: POST ${url} threw`, err);
    return { success: false, message: `Couldn't reach ${job} — ${describeFetchError(err)}.` };
  }
}

/**
 * Flattens a thrown fetch error into something readable. Node's fetch reports
 * nearly everything as a bare "fetch failed" and puts the real reason on
 * .cause, so surface both.
 */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error && err.cause.message && err.cause.message !== err.message
    ? `${err.message}: ${err.cause.message}`
    : err.message || "unknown error";
}
