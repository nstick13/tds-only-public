import { requireLeague } from "@/lib/league/context";
import { DisplayNameForm } from "./DisplayNameForm";
import { NotificationToggle } from "@/components/settings/NotificationToggle";

/**
 * Per-league settings: the name this league sees, and push notifications.
 *
 * The two are scoped differently and the page says so out loud, because the
 * difference is genuinely surprising: the display name is per league (it
 * lives on league_members), while notifications are per browser and cover
 * every league you're in at once.
 */
export default async function SettingsPage({
  params,
}: {
  params: { slug: string };
}) {
  const { league, membership } = await requireLeague(params.slug);

  // Without VAPID keys nothing can be sent, so the toggle is hidden rather
  // than offering a switch that silently does nothing.
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";

  return (
    <div className="max-w-md mx-auto w-full flex flex-col gap-6">
      <DisplayNameForm
        slug={league.slug}
        leagueName={league.name}
        initialName={membership.display_name ?? ""}
      />
      {vapidPublicKey ? (
        <NotificationToggle vapidPublicKey={vapidPublicKey} />
      ) : null}
    </div>
  );
}
