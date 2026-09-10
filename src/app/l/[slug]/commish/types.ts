/**
 * Shared types for the commissioner tools route. Kept separate from
 * actions.ts because a "use server" file may only export async functions —
 * plain types/interfaces have to live elsewhere to be importable from both
 * actions.ts and the client components in this route.
 *
 * Every input here carries the league SLUG. Actions re-resolve the league
 * from it rather than trusting a league id from the client; see the header of
 * actions.ts.
 */
import type { Position } from "@/lib/roster";

/** Uniform return shape for every commish server action. */
export type ActionResult<T = undefined> =
  | { success: true; message: string; data: T }
  | ActionFailure;

/**
 * The failure half on its own. Named because requireCommissioner() hands back
 * a ready-to-return failure, and that value has to satisfy actions returning
 * ActionResult<T> for any T — the full union does not, since its success
 * branch pins `data` to undefined.
 */
export type ActionFailure = { success: false; message: string };

export interface ManualRosterEditInput {
  slug: string;
  stageId: string;
  managerId: string;
  /** Player to remove (e.g. the injured player), if any. */
  removePlayerId?: string;
  /** Player to add in their place, if any. Requires slotPosition. */
  addPlayerId?: string;
  /** Roster slot for addPlayerId. Required when addPlayerId is set. */
  slotPosition?: Position;
}

/** Input for swapping one already-drafted player for another. */
export interface ReplaceRosterPickInput {
  slug: string;
  stageId: string;
  /** The drafted player being replaced. Their manager, slot and pick_number carry over. */
  outPlayerId: string;
  /** Their replacement. Must be undrafted in this stage and play the slot's position. */
  inPlayerId: string;
}

/**
 * A change to one member's standing in this league. Replaces the
 * single-league app's ManagerAdminUpdate, which patched global flags on a
 * `profiles` row — there are no global flags any more, and the answer to
 * "is this person a commissioner" is always "…of which league".
 *
 * Omitted fields are left alone; `seat: null` explicitly clears a seat.
 */
export interface MemberAdminUpdate {
  slug: string;
  /** The member being changed, by auth user id. */
  userId: string;
  /** 1..8, or null to bench them (which also clears is_player). */
  seat?: number | null;
  is_commissioner?: boolean;
}

/**
 * Sync jobs the Commish page can hand-trigger. A SUBSET of SyncSource:
 * schedule and locks run on their own cron and there is no useful reason to
 * force them by hand (schedule barely changes; apply-locks runs every few
 * minutes and is DB-only), so they are status-only in the panel.
 */
export type SyncSourceTrigger = "players" | "scores";
