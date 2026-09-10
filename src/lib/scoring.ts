/**
 * TD-only scoring rules. This is the single source of truth for point
 * values — mirror these constants in SQL (see
 * nfl_week_stats.points generated column in
 * supabase/migrations/0002_global_nfl.sql) but do not duplicate the values
 * anywhere else in application code. Import from here instead.
 */
export const POINTS_PER_PASS_TD = 0.5;
export const POINTS_PER_RUSH_TD = 1.0;
export const POINTS_PER_REC_TD = 1.0;

export interface TdCounts {
  passTd: number;
  rushTd: number;
  recTd: number;
}

/** Computes fantasy points from raw TD counts using the league's scoring rules. */
export function computePoints({ passTd, rushTd, recTd }: TdCounts): number {
  const points =
    passTd * POINTS_PER_PASS_TD +
    rushTd * POINTS_PER_RUSH_TD +
    recTd * POINTS_PER_REC_TD;

  // Round to 1 decimal to match the numeric(5,1)/numeric(6,1) columns in the DB.
  return Math.round(points * 10) / 10;
}
