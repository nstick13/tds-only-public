import { RankBadge } from "./RankBadge";

export interface StandingsRow {
  managerId: string;
  name: string;
  rank: number | null;
  points: number;
  tds: number;
  /** Extra small-print under the manager name, e.g. "3-1, best: 1st" for the season table. */
  detail?: string;
}

export interface StandingsTableProps {
  rows: StandingsRow[];
  pointsLabel?: string;
  /** Highlights the table as an in-progress/live snapshot rather than a final result. */
  live?: boolean;
}

/**
 * Retro scoreboard table shared by the season leaderboard, per-stage final
 * standings, and live in-progress standings. Ranks, manager name, TD count,
 * and points — biggest number (points) gets the pixel ScoreDisplay treatment
 * via bold yellow text rather than pulling in ScoreDisplay's stacked layout,
 * which doesn't fit a table row.
 */
export function StandingsTable({ rows, pointsLabel = "PTS", live = false }: StandingsTableProps) {
  if (rows.length === 0) {
    return (
      <p className="font-mono text-retro-offwhite/70 text-center py-6">
        No standings to show yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-base">
        <thead>
          <tr className="border-b-2 border-retro-offwhite/40 text-left uppercase font-pixel text-[10px] text-retro-offwhite/70">
            <th className="py-2 pr-3">Rank</th>
            <th className="py-2 pr-3">Manager</th>
            <th className="py-2 pr-3 text-right">TDs</th>
            <th className="py-2 pl-3 text-right">{pointsLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.managerId}
              className={[
                "border-b border-retro-offwhite/10",
                i === 0 && !live ? "bg-retro-yellow/10" : "",
              ].join(" ")}
            >
              <td className="py-2 pr-3">
                <RankBadge rank={row.rank} />
              </td>
              <td className="py-2 pr-3">
                <div className="text-retro-offwhite">{row.name}</div>
                {row.detail ? (
                  <div className="text-xs text-retro-offwhite/60">{row.detail}</div>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-right text-retro-offwhite">{row.tds}</td>
              <td className="py-2 pl-3 text-right font-pixel text-sm text-retro-yellow">
                {row.points.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
