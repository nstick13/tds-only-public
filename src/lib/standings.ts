/**
 * Standings computation — pure logic, no I/O. Aggregates a single stage's
 * roster_picks x nfl_week_stats into per-manager totals and ranks
 * them. Commissioner server actions (src/app/(app)/commish/actions.ts)
 * call this when finalizing a stage and persist the result to
 * weekly_results. Stats come from src/lib/db/stats.ts, which resolves a
 * stage to its NFL week — this function never sees a stage id.
 */
import type { RosterPick, NflWeekStats } from "@/lib/types";
import type { Position } from "@/lib/roster";

/** Computed per-manager totals for one stage, ranked. Mirrors the weekly_results row shape (minus stage_id/finalized_at, which the caller attaches when persisting). */
export interface ManagerStageTotals {
  manager_id: string;
  total_tds: number;
  total_points: number;
  qb_points: number;
  rb_points: number;
  wr_points: number;
  te_points: number;
  /** 1 = best. Assigned by computeStandings; never null. */
  rank: number;
}

const POSITION_FIELD: Record<Position, keyof Pick<
  ManagerStageTotals,
  "qb_points" | "rb_points" | "wr_points" | "te_points"
>> = {
  QB: "qb_points",
  RB: "rb_points",
  WR: "wr_points",
  TE: "te_points",
};

/**
 * Aggregates one manager's roster picks into raw totals (no rank yet).
 * A player with no matching stats row (e.g. stats haven't synced, or the
 * player didn't play) contributes zero — never throws on missing stats.
 */
function aggregateManager(
  managerId: string,
  picks: RosterPick[],
  statsByPlayer: Map<string, NflWeekStats>,
): Omit<ManagerStageTotals, "rank"> {
  const totals = {
    manager_id: managerId,
    total_tds: 0,
    total_points: 0,
    qb_points: 0,
    rb_points: 0,
    wr_points: 0,
    te_points: 0,
  };

  for (const pick of picks) {
    const stats = statsByPlayer.get(pick.player_id);
    if (!stats) continue;

    const tds = stats.pass_td + stats.rush_td + stats.rec_td;
    const points = stats.points;

    totals.total_tds += tds;
    totals.total_points += points;

    const field = POSITION_FIELD[pick.slot_position];
    totals[field] += points;
  }

  // Round away floating-point drift from repeated += on generated
  // numeric(5,1) values, matching the DB's 1-decimal columns.
  totals.total_points = Math.round(totals.total_points * 10) / 10;
  totals.qb_points = Math.round(totals.qb_points * 10) / 10;
  totals.rb_points = Math.round(totals.rb_points * 10) / 10;
  totals.wr_points = Math.round(totals.wr_points * 10) / 10;
  totals.te_points = Math.round(totals.te_points * 10) / 10;

  return totals;
}

/**
 * Computes ranked standings for a single stage.
 *
 * Sort/tiebreak priority (1 = best), per spec:
 *   1. total_points DESC       (points ARE weighted TDs — the primary sort)
 *   2. total_tds DESC          (tiebreaker: raw TD count regardless of weight)
 *   3. te_points DESC
 *   4. wr_points DESC
 *   5. rb_points DESC
 *   6. qb_points DESC
 *   7. random               (last-resort coin flip for a still-tied pair)
 *
 * `managerIds` drives which managers appear in the result — every id gets
 * a row (zeros if they have no picks/stats), even if `rosterPicks` is
 * empty. Extra managers referenced only in rosterPicks/stats but absent
 * from `managerIds` are ignored (not expected to happen given RLS/roster
 * constraints, but keeps this function total on malformed input).
 */
export function computeStandings(
  rosterPicks: RosterPick[],
  stats: NflWeekStats[],
  managerIds: string[],
): ManagerStageTotals[] {
  const statsByPlayer = new Map(stats.map((s) => [s.player_id, s]));

  const picksByManager = new Map<string, RosterPick[]>();
  for (const pick of rosterPicks) {
    const list = picksByManager.get(pick.manager_id) ?? [];
    list.push(pick);
    picksByManager.set(pick.manager_id, list);
  }

  const totals = managerIds.map((managerId) =>
    aggregateManager(managerId, picksByManager.get(managerId) ?? [], statsByPlayer),
  );

  // Assign a stable per-run random tiebreak value up front (rather than
  // calling Math.random() inside the comparator, which some engines may
  // invoke a variable number of times per pair and produce inconsistent
  // orderings).
  const randomTiebreak = new Map(totals.map((t) => [t.manager_id, Math.random()]));

  const sorted = [...totals].sort((a, b) => {
    return (
      b.total_points - a.total_points ||
      b.total_tds - a.total_tds ||
      b.te_points - a.te_points ||
      b.wr_points - a.wr_points ||
      b.rb_points - a.rb_points ||
      b.qb_points - a.qb_points ||
      randomTiebreak.get(a.manager_id)! - randomTiebreak.get(b.manager_id)!
    );
  });

  return sorted.map((t, i) => ({ ...t, rank: i + 1 }));
}
