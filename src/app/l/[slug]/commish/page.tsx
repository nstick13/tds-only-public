import { notFound } from "next/navigation";
import { requireLeague } from "@/lib/league/context";
import {
  getCurrentStage,
  getLeagueInvites,
  getManualSyncCooldowns,
  getMembers,
  getSeatedMembers,
  getStages,
  getSyncStatus,
} from "@/lib/db";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { CommishSection } from "@/components/commish/CommishSection";
import { SeasonControl } from "@/components/commish/SeasonControl";
import { DraftPickForManager } from "@/components/commish/DraftPickForManager";
import { DraftOrderEditor } from "@/components/commish/DraftOrderEditor";
import { RosterEditor } from "@/components/commish/RosterEditor";
import { MemberAdmin } from "@/components/commish/MemberAdmin";
import { InviteManager } from "@/components/commish/InviteManager";
import { SyncPanel } from "@/components/commish/SyncPanel";

/**
 * Commissioner tools for one league.
 *
 * notFound() rather than a redirect for a non-commissioner: the nav only
 * links here for commissioners, so anyone else reached this URL by typing it,
 * and "there is nothing at this address for you" is the honest answer.
 * Every write below is re-guarded in actions.ts and again by RLS.
 *
 * LAYOUT
 * ---------------------------------------------------------------------------
 * Ordered by how urgently you need each tool, not by how the code is
 * organized. During a draft the pick-for-a-manager panel is the thing you're
 * reaching for in a hurry, so it sits at the top the moment a draft is open
 * and disappears when it isn't. Members comes next while a league is still
 * filling up — a new league's only real job is getting seven other people
 * into it — then setup, fixes, and rarely-touched admin.
 */
export default async function CommishPage({ params }: { params: { slug: string } }) {
  const { league, membership } = await requireLeague(params.slug);
  if (!membership.is_commissioner) notFound();

  const [stages, members, seated, invites, currentStage, syncStatus, syncCooldowns] =
    await Promise.all([
      getStages(league.id),
      getMembers(league.id),
      getSeatedMembers(league.id),
      getLeagueInvites(league.id),
      getCurrentStage(league.id),
      getSyncStatus(),
      getManualSyncCooldowns(),
    ]);

  const draftIsOpen = currentStage?.status === "draft_open";
  const stageNote = currentStage
    ? `${currentStage.name} — ${currentStage.status.replace(/_/g, " ")}`
    : "no active stage";

  return (
    <div className="flex flex-col gap-8">
      <PixelPanel raised className="flex flex-col gap-1">
        <h1 className="font-pixel text-lg text-retro-yellow">Commish Tools</h1>
        <p className="font-mono text-base text-retro-offwhite/70">
          {league.name} &middot; {league.season}. Members and invites, season
          control, draft order, roster corrections, and data sync.
        </p>
      </PixelPanel>

      {draftIsOpen && currentStage ? (
        <CommishSection
          title="Draft In Progress"
          blurb="Pick on behalf of a manager who can't get to the app, or undo a pick that just went in wrong."
          note={stageNote}
        >
          <DraftPickForManager
            slug={league.slug}
            currentStage={currentStage}
            managers={seated}
          />
        </CommishSection>
      ) : null}

      <CommishSection
        title="Members"
        blurb="Who's in, who holds a seat, and who else can run the league. Share an invite link to fill the empty seats."
      >
        <div className="flex flex-col gap-4">
          <MemberAdmin
            slug={league.slug}
            members={members}
            currentUserId={membership.user_id}
            size={league.size}
          />
          <InviteManager slug={league.slug} invites={invites} />
        </div>
      </CommishSection>

      <CommishSection
        title="Season"
        blurb="Open the season, and finalize each stage to score it and open the next one."
        note={draftIsOpen ? undefined : stageNote}
      >
        <SeasonControl
          slug={league.slug}
          stages={stages}
          managers={seated}
          currentStage={currentStage}
          size={league.size}
        />
      </CommishSection>

      <CommishSection
        title="Rosters"
        blurb="Fix a roster after the fact — swap an injured or mis-drafted player, or add and remove directly. Works after a stage locks."
      >
        <RosterEditor slug={league.slug} stages={stages} managers={seated} />
      </CommishSection>

      <CommishSection
        title="Draft Order"
        blurb="Inspect or hand-edit the pick order for any stage. Normally generated automatically when a stage opens."
      >
        <DraftOrderEditor slug={league.slug} stages={stages} managers={seated} />
      </CommishSection>

      <CommishSection
        title="Data"
        blurb="Freshness of the synced player and score data, and manual re-triggers when you can't wait for the next scheduled run. The sync is shared by every league on this instance."
      >
        <SyncPanel
          slug={league.slug}
          syncStatus={syncStatus}
          cooldowns={syncCooldowns}
        />
      </CommishSection>
    </div>
  );
}
