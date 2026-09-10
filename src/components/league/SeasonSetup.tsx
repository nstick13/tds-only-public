import { PixelPanel } from "@/components/ui/PixelPanel";
import { InviteLink } from "@/components/league/InviteLink";
import { memberName, type LeagueMember } from "@/lib/types";
import { estimatedDraftMinutes } from "@/lib/league";

/**
 * The waiting room: what a league looks like between "created" and "Week 1
 * draft is open".
 *
 * This period used to show nothing at all. The invite link appeared exactly
 * once, on the redirect out of league creation, and a commissioner who
 * navigated away could not find it again without going to the Commish page —
 * while everyone else saw an empty scoreboard with no explanation of what
 * they were waiting for. A league sits in this state for days while people
 * are nagged into signing up, which makes it the screen a new league is
 * looked at on most, not least.
 *
 * So it answers the three questions actually being asked: who is in, how many
 * more are needed, and whose move is it.
 */
export interface SeasonSetupProps {
  leagueName: string;
  /** Seats in this league (6-10). */
  size: number;
  /** Everyone in the league, seated or not. */
  members: LeagueMember[];
  isCommissioner: boolean;
  /**
   * A usable invite code, or null. Null for non-commissioners by design —
   * RLS will not show them one, because a code grants a seat.
   */
  inviteCode: string | null;
  /** Shown the moment a league is created, so the first thing seen is the link. */
  justCreated?: boolean;
}

export function SeasonSetup({
  leagueName,
  size,
  members,
  isCommissioner,
  inviteCode,
  justCreated = false,
}: SeasonSetupProps) {
  const seated = members
    .filter((m) => m.seat !== null)
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
  const spectators = members.filter((m) => m.seat === null);
  const open = Math.max(0, size - seated.length);
  const full = open === 0;

  const commissioners = members.filter((m) => m.is_commissioner);

  return (
    <PixelPanel raised className="flex flex-col gap-4 border-retro-yellow">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="font-pixel text-base text-retro-yellow">
          {justCreated ? `${leagueName} is live` : "Filling seats"}
        </h2>
        <span className="font-pixel text-xs text-retro-offwhite">
          {seated.length} / {size}
        </span>
      </div>

      {/* The seat list is the status: names where someone has joined, an
          explicit "open" everywhere else. A count alone reads as progress;
          the empty rows read as "these are the people you still have to
          text", which is the actual task. */}
      <ol className="flex flex-col gap-1 font-mono text-lg">
        {Array.from({ length: size }, (_, i) => {
          const seat = i + 1;
          const member = seated.find((m) => m.seat === seat);
          return (
            <li
              key={seat}
              className="flex items-center gap-3 border-b-2 border-retro-offwhite/10 pb-1"
            >
              <span className="font-pixel text-[10px] text-retro-offwhite/50 w-6">
                {seat}
              </span>
              {member ? (
                <>
                  <span className="text-retro-offwhite">{memberName(member)}</span>
                  {member.is_commissioner ? (
                    <span className="font-pixel text-[9px] text-retro-yellow">
                      COMMISH
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-retro-offwhite/35">open</span>
              )}
            </li>
          );
        })}
      </ol>

      {spectators.length > 0 ? (
        <p className="font-mono text-base text-retro-offwhite/60">
          Plus {spectators.length} watching without a seat
          {isCommissioner
            ? " — you can hand them one from the Commish page if somebody drops."
            : "."}
        </p>
      ) : null}

      {isCommissioner ? (
        <div className="flex flex-col gap-3">
          {full ? (
            <p className="font-mono text-lg text-retro-offwhite">
              Every seat is taken. Open the season from the{" "}
              <span className="text-retro-yellow">Commish</span> page — that
              randomises the Week 1 order and starts the draft. Budget about{" "}
              {estimatedDraftMinutes(size)} minutes with everyone present.
            </p>
          ) : (
            <p className="font-mono text-lg text-retro-offwhite">
              {open} more {open === 1 ? "manager" : "managers"} to go. Send this
              link — it seats whoever opens it, first come first served.
            </p>
          )}
          {inviteCode ? <InviteLink code={inviteCode} /> : null}
          {!full ? (
            <p className="font-mono text-base text-retro-offwhite/60">
              You can start short-handed if someone flakes, but the draft order
              and scoring assume {size}.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="font-mono text-lg text-retro-offwhite/80">
          {full
            ? `All ${size} seats are taken. ${
                commissioners.length === 1
                  ? `${memberName(commissioners[0])} opens the season`
                  : "A commissioner opens the season"
              } and the first draft starts — you'll get a notification when it's your turn to pick.`
            : `Waiting on ${open} more ${
                open === 1 ? "manager" : "managers"
              } before the first draft can start.`}
        </p>
      )}
    </PixelPanel>
  );
}
