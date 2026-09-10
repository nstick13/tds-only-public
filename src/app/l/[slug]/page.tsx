import { PixelPanel } from "@/components/ui/PixelPanel";
import { InviteLink } from "@/components/league/InviteLink";
import { Badge } from "@/components/ui/Badge";
import { StandingsTable, type StandingsRow } from "@/components/standings/StandingsTable";
import { ExpandableStandings } from "@/components/standings/ExpandableStandings";
import { PastWeekSection } from "@/components/standings/PastWeekSection";
import { loadStageBoard, namesByManager } from "@/components/standings/board";
import { requireLeague } from "@/lib/league/context";
import {
  getAllWeeklyResults,
  getCurrentStage,
  getPlayers,
  getSeatedMembers,
  getStages,
} from "@/lib/db";
import { LEAGUE_SIZE } from "@/lib/league";
import type { Player, Stage, WeeklyResult } from "@/lib/types";

/**
 * One league's home page — everything except the draft board.
 *
 * Top to bottom: the current week's standings (rows expand to each manager's
 * roster), then the season leaderboard, then every finalized week newest
 * first (each expands to that week's standings, whose rows expand to
 * rosters).
 */
export default async function LeaguePage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { created?: string };
}) {
  const { league } = await requireLeague(params.slug);

  // ?created=<code> is set exactly once, by the redirect out of
  // /leagues/new. A brand-new league is empty and slightly pointless, so the
  // first thing its commissioner sees is the link that fixes that.
  const freshInviteCode = searchParams.created?.trim() || null;

  const [stages, allResults, members, currentStage, players] = await Promise.all([
    getStages(league.id),
    getAllWeeklyResults(league.id),
    getSeatedMembers(league.id),
    getCurrentStage(league.id),
    getPlayers(),
  ]);

  const nameByManagerId = namesByManager(members);
  const playerById = new Map<string, Player>(players.map((p: Player) => [p.id, p]));

  // Newest first: after Week 4 finalizes the reader sees 4, 3, 2, 1.
  const finalizedStages = stages
    .filter((s: Stage) => s.status === "finalized")
    .sort((a: Stage, b: Stage) => b.ordinal - a.ordinal);

  const [currentBoard, pastBoards] = await Promise.all([
    currentStage && currentStage.status !== "upcoming"
      ? loadStageBoard(currentStage, nameByManagerId, playerById)
      : Promise.resolve(null),
    Promise.all(
      finalizedStages.map((s: Stage) => loadStageBoard(s, nameByManagerId, playerById)),
    ),
  ]);

  const finalizedIds = new Set(finalizedStages.map((s: Stage) => s.id));
  const seasonRows = buildSeasonLeaderboard(
    allResults.filter((r: WeeklyResult) => finalizedIds.has(r.stage_id) && r.finalized_at),
    nameByManagerId,
  );

  return (
    <div className="flex flex-col gap-6">
      {freshInviteCode ? (
        <PixelPanel raised className="flex flex-col gap-3 border-retro-yellow">
          <h2 className="font-pixel text-base text-retro-yellow">
            {league.name} is live — now fill the seats
          </h2>
          <p className="font-mono text-lg text-retro-offwhite/80">
            Send this link to the other {LEAGUE_SIZE - 1} managers. It seats
            whoever opens it, first come first served, and expires in 7 days —
            the Commish page can mint a fresh one any time.
          </p>
          <InviteLink code={freshInviteCode} />
        </PixelPanel>
      ) : null}

      {/* This week */}
      <PixelPanel raised className="flex flex-col gap-4">
        {currentStage ? (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h1 className="font-pixel text-lg text-retro-yellow">{currentStage.name}</h1>
              {currentBoard?.live ? (
                <Badge status="Active">Live / In Progress</Badge>
              ) : currentStage.status === "finalized" ? (
                <Badge status="Active" className="!bg-retro-green">
                  Final
                </Badge>
              ) : null}
            </div>

            {currentStage.status === "upcoming" ? (
              <p className="font-mono text-lg text-retro-offwhite/80 text-center py-6">
                Draft hasn&apos;t opened for this stage yet.
              </p>
            ) : currentBoard && currentBoard.rows.length > 0 ? (
              <>
                {currentBoard.live ? (
                  <p className="font-mono text-sm text-retro-offwhite/70">
                    Not yet final — points update as stats sync in. Tap a manager to see
                    their roster.
                  </p>
                ) : null}
                <ExpandableStandings
                  rows={currentBoard.rows}
                  boxesByManager={currentBoard.boxesByManager}
                />
              </>
            ) : (
              <p className="font-mono text-lg text-retro-offwhite/80 text-center py-6">
                No rosters drafted for this stage yet.
              </p>
            )}
          </>
        ) : (
          <p className="font-mono text-lg text-retro-offwhite/80 text-center py-6">
            Season complete — every stage has been finalized.
          </p>
        )}
      </PixelPanel>

      {/* Season */}
      <PixelPanel raised className="flex flex-col gap-4">
        <h2 className="font-pixel text-base text-retro-yellow">Season Standings</h2>
        {seasonRows.length === 0 ? (
          <p className="font-mono text-lg text-retro-offwhite/80 text-center py-6">
            Season hasn&apos;t started — check back once the first week is finalized.
          </p>
        ) : (
          <StandingsTable rows={seasonRows} pointsLabel="SEASON PTS" />
        )}
      </PixelPanel>

      {/* Past weeks */}
      {pastBoards.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h2 className="font-pixel text-base text-retro-yellow px-1">Past Weeks</h2>
          {pastBoards.map((board) => {
            const winner = board.rows.find((r) => r.rank === 1) ?? null;
            return (
              <PastWeekSection
                key={board.stage.id}
                stageName={board.stage.name}
                winnerName={winner?.name ?? null}
                winnerPoints={winner?.points ?? null}
                rows={board.rows}
                boxesByManager={board.boxesByManager}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function buildSeasonLeaderboard(
  results: WeeklyResult[],
  nameByManagerId: Map<string, string>,
): StandingsRow[] {
  interface Agg {
    points: number;
    tds: number;
    weeks: number;
    wins: number;
    bestRank: number | null;
  }

  const agg = new Map<string, Agg>();
  for (const r of results) {
    const entry = agg.get(r.manager_id) ?? {
      points: 0,
      tds: 0,
      weeks: 0,
      wins: 0,
      bestRank: null,
    };
    entry.points += r.total_points;
    entry.tds += r.total_tds;
    entry.weeks += 1;
    if (r.rank === 1) entry.wins += 1;
    if (r.rank != null && (entry.bestRank == null || r.rank < entry.bestRank)) {
      entry.bestRank = r.rank;
    }
    agg.set(r.manager_id, entry);
  }

  const rows: StandingsRow[] = Array.from(agg.entries()).map(([managerId, entry]) => ({
    managerId,
    name: nameByManagerId.get(managerId) ?? "Manager",
    rank: null,
    points: entry.points,
    tds: entry.tds,
    detail: `${entry.wins} win${entry.wins === 1 ? "" : "s"} in ${entry.weeks} week${
      entry.weeks === 1 ? "" : "s"
    }${entry.bestRank ? ` · best: #${entry.bestRank}` : ""}`,
  }));

  rows.sort((a, b) => b.points - a.points);
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  return rows;
}
