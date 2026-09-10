import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getMyLeagues } from "@/lib/league/context";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { PixelLink } from "@/components/ui/PixelLink";
import { Badge } from "@/components/ui/Badge";
import { MAX_LEAGUE_SIZE, MIN_LEAGUE_SIZE } from "@/lib/league";

/**
 * The instance home page, and the only route with two completely different
 * jobs: pitch the game to a stranger, and be a league switcher for everyone
 * else. It deliberately does NOT redirect a one-league member straight into
 * their league — the "create a league" and invite-acceptance paths both land
 * here, and a redirect would make the second league invisible.
 */
export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return <SignedOut />;

  const leagues = await getMyLeagues();

  return (
    <main className="min-h-screen max-w-3xl mx-auto px-4 py-10 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-pixel text-lg text-retro-yellow">TD&apos;s Only</h1>
        <form action="/auth/sign-out" method="post">
          <PixelButton variant="secondary" type="submit" className="!px-3 !py-2 text-[10px]">
            Sign Out
          </PixelButton>
        </form>
      </header>

      <PixelPanel raised className="flex flex-col gap-4">
        <h2 className="font-pixel text-base text-retro-yellow">Your Leagues</h2>

        {leagues.length === 0 ? (
          <p className="font-mono text-lg text-retro-offwhite/80">
            You&apos;re not in a league yet. Start one and share the invite link, or
            open a link someone already sent you.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {leagues.map(({ league, membership }) => (
              <li key={league.id}>
                <Link
                  href={`/l/${league.slug}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-2 border-retro-offwhite/40 bg-field px-3 py-3 hover:border-retro-yellow transition-colors"
                >
                  <span className="font-pixel text-xs text-retro-offwhite flex-1 min-w-0 truncate">
                    {league.name}
                  </span>
                  {membership.is_commissioner ? (
                    <Badge status="Active" className="!bg-retro-yellow">
                      Commish
                    </Badge>
                  ) : null}
                  <span className="font-mono text-base text-retro-offwhite/70">
                    {league.season} &middot;{" "}
                    {membership.seat !== null
                      ? `seat ${membership.seat}`
                      : "spectator"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <PixelLink href="/leagues/new" className="w-fit">
          Create a League
        </PixelLink>
      </PixelPanel>
    </main>
  );
}

/** The pitch. Someone arriving from a shared link has never heard of this. */
function SignedOut() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <PixelPanel raised className="w-full max-w-lg flex flex-col gap-5">
        <h1 className="font-pixel text-lg text-retro-yellow">TD&apos;s Only</h1>

        <p className="font-mono text-lg text-retro-offwhite">
          Fantasy football stripped to the one thing everybody actually watches
          for: touchdowns. Rushing and receiving TDs are worth a point, passing
          TDs a half. Nothing else scores.
        </p>

        <ul className="font-mono text-lg text-retro-offwhite/80 flex flex-col gap-1 list-disc pl-5">
          <li>
            {MIN_LEAGUE_SIZE}&ndash;{MAX_LEAGUE_SIZE} managers, a fresh snake draft every single week
          </li>
          <li>Rosters wipe clean each week — last week&apos;s stars are back in the pool</li>
          <li>Finish last, pick first: the next draft is seeded worst-to-first</li>
        </ul>

        <p className="font-mono text-lg text-retro-offwhite/80">
          Sign in with Google to start a league or join one you were invited to.
        </p>

        <PixelLink href="/login" className="w-fit">
          Sign In with Google
        </PixelLink>
      </PixelPanel>
    </main>
  );
}
