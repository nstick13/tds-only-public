import { PixelPanel } from "@/components/ui/PixelPanel";
import { requireLeague } from "@/lib/league/context";
import {
  getCurrentStage,
  getDraftOrder,
  getPlayers,
  getRosterPicks,
  getSeatedMembers,
} from "@/lib/db";
import { DraftBoard } from "./DraftBoard";
import { TeamRosters } from "@/components/draft/TeamRosters";

/**
 * /l/[slug]/draft — the live draft room. Interactive only while the league's
 * current stage is 'draft_open'; otherwise read-only, with the roster
 * snapshot once picks exist (e.g. while locked).
 */
export default async function DraftPage({ params }: { params: { slug: string } }) {
  const { league, membership } = await requireLeague(params.slug);
  const stage = await getCurrentStage(league.id);

  if (!stage) {
    return (
      <PixelPanel raised className="flex flex-col gap-3 items-center text-center py-12">
        <h1 className="font-pixel text-lg text-retro-yellow">Draft</h1>
        <p className="font-mono text-lg text-retro-offwhite/80">
          The season is over — no active stage.
        </p>
      </PixelPanel>
    );
  }

  const [members, picks] = await Promise.all([
    getSeatedMembers(league.id),
    getRosterPicks(stage.id),
  ]);

  if (stage.status !== "draft_open") {
    const players = picks.length > 0 ? await getPlayers() : [];
    const playersById = new Map(players.map((p) => [p.id, p]));

    return (
      <div className="flex flex-col gap-4">
        <PixelPanel raised className="flex flex-col gap-2 items-center text-center py-8">
          <h1 className="font-pixel text-lg text-retro-yellow">Draft — {stage.name}</h1>
          <p className="font-mono text-lg text-retro-offwhite/80 uppercase">
            {stage.status === "locked"
              ? "Rosters locked for this stage."
              : "Draft is not open yet."}
          </p>
        </PixelPanel>

        {picks.length > 0 ? (
          <TeamRosters
            managers={members}
            picks={picks}
            playersById={playersById}
            currentUserId={membership.user_id}
          />
        ) : null}
      </div>
    );
  }

  const [draftOrder, players] = await Promise.all([
    getDraftOrder(stage.id),
    getPlayers(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-pixel text-lg text-retro-yellow text-center">
        Draft — {stage.name}
      </h1>
      <DraftBoard
        slug={league.slug}
        stageId={stage.id}
        initialDraftOrder={draftOrder}
        initialPicks={picks}
        managers={members}
        allPlayers={players}
        currentUserId={membership.user_id}
        isCommissioner={membership.is_commissioner}
      />
    </div>
  );
}
