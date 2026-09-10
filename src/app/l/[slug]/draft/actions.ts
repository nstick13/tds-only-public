"use server";

import { getByeTeamIds, decorateWithByes } from "@/lib/db/players";

import { revalidatePath } from "next/cache";
import { notifyOnTheClock } from "@/lib/push/notify";
import { createClient } from "@/lib/supabase/server";
import { requireLeague } from "@/lib/league/context";
import { getStageById } from "@/lib/db/stages";
import { getDraftOrder } from "@/lib/db/draftOrder";
import { getRosterPicks } from "@/lib/db/roster";
import type { LeagueContext, Player, Position, Stage } from "@/lib/types";
import {
  computeCurrentPick,
  isPlayerDraftable,
  isSlotFull,
  reasonPlayerBlocked,
} from "@/components/draft/draftLogic";

/**
 * Draft-room server actions.
 *
 * EVERY action takes the league SLUG from its own route and re-resolves it.
 * A server action is a separate request with no layout above it, so the
 * LeagueContext the page had is gone by the time one runs — and a leagueId
 * posted from the client is an assertion, not a fact. requireLeague() is
 * cheap (React-cached per request) and answers both "does this league exist
 * for you" and "what are you in it" in one go.
 *
 * The stage id is then checked against that league. RLS would reject a
 * cross-league write anyway, but a stage from another league would otherwise
 * get as far as reading its draft order before failing, which reads as a
 * confusing bug rather than a rejected request.
 */

export interface DraftActionResult {
  ok: boolean;
  error?: string;
}

export interface DraftPlayerInput {
  /** League slug from the route. Never a league id from the client. */
  slug: string;
  stageId: string;
  playerId: string;
  slotPosition: Position;
  commissionerOverride?: boolean;
}

/** Resolves the league and confirms the stage is one of its own. */
async function resolveStage(
  slug: string,
  stageId: string,
): Promise<{ ctx: LeagueContext; stage: Stage } | { error: string }> {
  const ctx = await requireLeague(slug);
  const stage = await getStageById(stageId);

  if (!stage || stage.league_id !== ctx.league.id) {
    return { error: "Stage not found in this league." };
  }
  return { ctx, stage };
}

/** The LeagueRef the notification copy needs, straight off the resolved league. */
function leagueRef(ctx: LeagueContext) {
  return { id: ctx.league.id, slug: ctx.league.slug, name: ctx.league.name };
}

/** Both draft views and the league page move when a pick lands. */
function revalidateLeague(slug: string) {
  revalidatePath(`/l/${slug}/draft`);
  revalidatePath(`/l/${slug}`);
}

/**
 * Drafts a player onto a manager's roster for a stage.
 *
 * Normally the pick is attributed to the signed-in user and it must be their
 * turn. When `commissionerOverride` is true the caller must be a commissioner
 * OF THIS LEAGUE, and the pick is attributed to whoever is on the clock —
 * that is both the "pick for a manager who can't get to their phone" path and
 * what lets a commissioner solo-test a draft without 8 real people.
 */
export async function draftPlayer(
  input: DraftPlayerInput,
): Promise<DraftActionResult> {
  const { slug, stageId, playerId, slotPosition, commissionerOverride } = input;

  const resolved = await resolveStage(slug, stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { ctx, stage } = resolved;

  if (commissionerOverride && !ctx.membership.is_commissioner) {
    return { ok: false, error: "Commissioner access required for override." };
  }
  if (stage.status !== "draft_open") {
    return { ok: false, error: "The draft is not open for this stage." };
  }

  const supabase = await createClient();

  const [draftOrder, picks] = await Promise.all([
    getDraftOrder(stageId),
    getRosterPicks(stageId),
  ]);

  const { pickNumber, managerId: onTheClockId } = computeCurrentPick(
    draftOrder,
    picks.length,
  );

  if (pickNumber === null) {
    return { ok: false, error: "The draft is already complete for this stage." };
  }

  const pickForManagerId = commissionerOverride
    ? onTheClockId
    : ctx.membership.user_id;

  if (!pickForManagerId) {
    return { ok: false, error: "Nobody is assigned to this pick." };
  }
  if (!commissionerOverride && onTheClockId !== ctx.membership.user_id) {
    return { ok: false, error: "It is not your turn to pick." };
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("*")
    .eq("id", playerId)
    .maybeSingle();

  if (playerError) {
    return { ok: false, error: `Could not load player: ${playerError.message}` };
  }
  if (!player) {
    return { ok: false, error: "Player not found." };
  }

  const typedPlayer = player as Player;

  if (typedPlayer.position !== slotPosition) {
    return { ok: false, error: "Slot position must match the player's position." };
  }

  // Re-derive the bye here rather than trusting anything the client sent: the
  // browser's copy came from a page render that may be minutes stale, and a
  // bye is what makes a player undraftable. Scoped to THIS stage's week — a
  // player on bye in week 6 is perfectly draftable in week 7.
  const byeTeamIds = await getByeTeamIds(stage);
  const stagePlayer = decorateWithByes([typedPlayer], byeTeamIds)[0];

  const blockedReason = reasonPlayerBlocked(stagePlayer);
  if (!isPlayerDraftable(stagePlayer) && blockedReason) {
    return { ok: false, error: blockedReason };
  }

  if (picks.some((p) => p.player_id === playerId)) {
    return { ok: false, error: "That player was just taken." };
  }

  if (isSlotFull(picks, pickForManagerId, slotPosition)) {
    return { ok: false, error: `${slotPosition} slot is already full for that manager.` };
  }

  // league_id is deliberately absent: the set_league_id_from_stage trigger
  // derives it from stage_id, and application code that set it would be
  // asserting something the database is already sure of.
  const { error: insertError } = await supabase.from("roster_picks").insert({
    stage_id: stageId,
    manager_id: pickForManagerId,
    player_id: playerId,
    slot_position: slotPosition,
    pick_number: pickNumber,
  });

  if (insertError) {
    return { ok: false, error: friendlyInsertError(insertError.message) };
  }

  // Tell whoever is up next. The pick is already committed, so a push failure
  // must not surface as a failed draft — notifyOnTheClock swallows its own
  // errors, and this is awaited only to keep it inside the request.
  const next = computeCurrentPick(draftOrder, picks.length + 1);
  if (next.managerId && next.pickNumber !== null) {
    await notifyOnTheClock(leagueRef(ctx), next.managerId, stage.name, next.pickNumber);
  }

  revalidateLeague(slug);
  return { ok: true };
}

/**
 * Removes the most recent pick in a stage. Non-commissioners can only undo
 * their own picks while the draft is open; commissioners can undo any
 * manager's last pick (for test-draft cleanup and misclicks).
 */
export async function undoPick(
  slug: string,
  stageId: string,
  commissionerOverride?: boolean,
): Promise<DraftActionResult> {
  const resolved = await resolveStage(slug, stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { ctx, stage } = resolved;

  if (commissionerOverride && !ctx.membership.is_commissioner) {
    return { ok: false, error: "Commissioner access required for override." };
  }
  if (stage.status !== "draft_open") {
    return { ok: false, error: "The draft is not open for this stage." };
  }

  const supabase = await createClient();

  let query = supabase
    .from("roster_picks")
    .select("*")
    .eq("stage_id", stageId)
    .order("pick_number", { ascending: false })
    .limit(1);

  if (!commissionerOverride) {
    query = query.eq("manager_id", ctx.membership.user_id);
  }

  const { data: targetPicks, error: picksError } = await query;

  if (picksError) {
    return { ok: false, error: picksError.message };
  }
  if (!targetPicks || targetPicks.length === 0) {
    return { ok: false, error: "No picks to undo." };
  }

  const { error: deleteError } = await supabase
    .from("roster_picks")
    .delete()
    .eq("id", targetPicks[0].id);

  if (deleteError) {
    return { ok: false, error: deleteError.message };
  }

  revalidateLeague(slug);
  return { ok: true };
}

function friendlyInsertError(message: string): string {
  if (message.includes("roster_picks_stage_player_unique")) {
    return "That player was just taken.";
  }
  if (message.includes("Roster limit exceeded")) {
    // Match on the wording, not the number — the roster total is a league
    // rule (see ROSTER_SIZE) and this string quietly stopped matching when it
    // changed from 6 to 7.
    return /already holds \d+ players/.test(message)
      ? "Roster is already full."
      : "That position slot is already full.";
  }
  return `Could not draft player: ${message}`;
}
