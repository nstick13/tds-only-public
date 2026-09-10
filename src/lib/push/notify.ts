import "server-only";
import { leagueUserIds, sendToUsers } from "./send";

/**
 * The app's notification vocabulary. Two events: something needs you in the
 * draft, and a week is in the books. No live scoring alerts — TDs land
 * through the normal sync and show up on the league page.
 *
 * EVERY NOTIFICATION NAMES ITS LEAGUE. Push subscriptions are per user, not
 * per league (see send.ts), so someone in three leagues gets all three on the
 * same device with nothing but the copy to tell them apart. "You're on the
 * clock" alone is useless to that person; "Sunday Beers — you're on the
 * clock" tells them which app to open and which chat to apologize in. The
 * tags carry the league id for the same reason: a tag collision would let one
 * league's alert silently replace another's on the lock screen.
 *
 * Every function here is fire-and-forget. Callers should NOT await these in a
 * way that can fail their action: a pick that saved must report success even
 * if Apple's push service is down. sendToUsers() already swallows its own
 * errors; these wrappers keep that contract.
 */

/** Identifies which league is talking, for both the copy and the tap target. */
export interface LeagueRef {
  id: string;
  slug: string;
  name: string;
}

/** A stage's draft just opened — everyone in the league hears about it. */
export async function notifyDraftOpen(
  league: LeagueRef,
  stageName: string,
): Promise<void> {
  const userIds = await leagueUserIds(league.id);
  await sendToUsers(userIds, {
    title: `${league.name} — ${stageName} draft is open`,
    body: "Rosters are wiped. Get in and draft.",
    url: `/l/${league.slug}/draft`,
    // One draft-open notification per stage per league; a re-send replaces it.
    tag: `draft-open:${league.id}:${stageName}`,
  });
}

/** One manager is on the clock. Sent to that manager only. */
export async function notifyOnTheClock(
  league: LeagueRef,
  managerId: string,
  stageName: string,
  pickNumber: number,
): Promise<void> {
  await sendToUsers([managerId], {
    title: `${league.name} — you're on the clock`,
    body: `${stageName}, pick #${pickNumber} is yours.`,
    url: `/l/${league.slug}/draft`,
    // Replaces any earlier on-the-clock alert for THIS league rather than
    // stacking a column of them over a 56-pick draft — but never replaces
    // another league's, which is a different draft the manager still owes.
    tag: `on-the-clock:${league.id}`,
  });
}

/** A week has been finalized — league-wide, with the winner in the body. */
export async function notifyWeekFinal(
  league: LeagueRef,
  stageName: string,
  winnerName: string | null,
  winnerPoints: number | null,
): Promise<void> {
  const userIds = await leagueUserIds(league.id);
  const body = winnerName
    ? `${winnerName} takes it with ${winnerPoints?.toFixed(1)} pts.`
    : "Final standings are up.";

  await sendToUsers(userIds, {
    title: `${league.name} — ${stageName} is final`,
    body,
    url: `/l/${league.slug}`,
    tag: `final:${league.id}:${stageName}`,
  });
}
