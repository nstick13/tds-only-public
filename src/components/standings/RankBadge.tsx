const MEDALS: Record<number, string> = {
  1: "🥇",
  2: "🥈",
  3: "🥉",
};

/**
 * Rank indicator used in both the season leaderboard and per-stage
 * standings tables — medal emoji for the top 3, a plain pixel-font
 * ordinal otherwise.
 */
export function RankBadge({ rank }: { rank: number | null }) {
  if (rank == null) {
    return <span className="font-mono text-retro-offwhite/60">—</span>;
  }

  const medal = MEDALS[rank];
  return (
    <span className="font-pixel text-xs text-retro-yellow whitespace-nowrap">
      {medal ? <span className="mr-1">{medal}</span> : null}
      {rank}
    </span>
  );
}
