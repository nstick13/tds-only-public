"use client";

import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { DraftOrderRow, RosterPick } from "@/lib/types";

/** Unsubscribes and removes the underlying Supabase Realtime channel. */
export type Unsubscribe = () => void;

export interface DraftChannelHandlers {
  /** Fired on any INSERT/UPDATE/DELETE to roster_picks for this stage. */
  onRosterPickChange?: (
    payload: RealtimePostgresChangesPayload<RosterPick>,
  ) => void;
  /** Fired on any INSERT/UPDATE/DELETE to draft_order for this stage. */
  onDraftOrderChange?: (
    payload: RealtimePostgresChangesPayload<DraftOrderRow>,
  ) => void;
}

/**
 * Subscribes to live draft activity for a single stage on the
 * `draft:{stageId}` channel (see docs/ARCHITECTURE.md "Realtime").
 * Listens to Postgres Changes on roster_picks and draft_order filtered to
 * this stage_id, so multiple stages' draft rooms don't cross-talk.
 *
 * `stageId` is a uuid, which is why the league id is absent from the channel
 * name: stage ids are globally unique across every league on the instance, so
 * two leagues drafting Week 5 at the same time cannot collide.
 *
 * Returns an unsubscribe function — call it in a useEffect cleanup.
 */
export function subscribeToDraft(
  stageId: string,
  handlers: DraftChannelHandlers,
): Unsubscribe {
  const supabase = createClient();
  const channel = supabase.channel(`draft:${stageId}`);

  if (handlers.onRosterPickChange) {
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "roster_picks",
        filter: `stage_id=eq.${stageId}`,
      },
      handlers.onRosterPickChange,
    );
  }

  if (handlers.onDraftOrderChange) {
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "draft_order",
        filter: `stage_id=eq.${stageId}`,
      },
      handlers.onDraftOrderChange,
    );
  }

  channel.subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Generic single-table Postgres Changes subscription, for features that
 * don't fit the draft-specific channel above (e.g. watching sync_log for
 * live staleness updates, or weekly_results for live standings).
 * Uses a channel named `table:{table}`.
 */
export function subscribeToTable<T extends Record<string, unknown>>(
  table: string,
  handler: (payload: RealtimePostgresChangesPayload<T>) => void,
  filter?: string,
): Unsubscribe {
  const supabase = createClient();
  const channel = supabase.channel(`table:${table}`).on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table,
      ...(filter ? { filter } : {}),
    },
    handler,
  );

  channel.subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
