import type { ReactNode } from "react";
import Link from "next/link";
import { requireLeague } from "@/lib/league/context";
import { memberName } from "@/lib/types";
import { PixelButton } from "@/components/ui/PixelButton";
import { DataFreshness } from "@/components/DataFreshness";

/**
 * The league shell. Every route under /l/[slug] renders inside this layout,
 * which resolves the slug ONCE via requireLeague() — sending a signed-out
 * visitor to /login, and 404ing anyone who isn't a member without saying
 * whether the league exists.
 *
 * Because that happens here, pages below can trust `membership` is non-null
 * and skip re-checking. Server ACTIONS cannot: an action is its own request
 * and gets no layout, so each one re-resolves the slug from its own route
 * params (see draft/actions.ts and commish/actions.ts).
 */
export default async function LeagueLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { slug: string };
}) {
  const { league, membership } = await requireLeague(params.slug);
  const base = `/l/${league.slug}`;

  // Two destinations plus admin. The league page carries this week's
  // standings, the season table and every past week, each expandable down to
  // rosters — which is what separate My Roster / Standings / History tabs
  // would each be showing a slice of.
  const navLinks = [
    { href: `${base}/draft`, label: "Draft" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-field-dark border-b-4 border-retro-offwhite">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col">
            <Link
              href={base}
              className="font-pixel text-xs sm:text-sm text-retro-yellow leading-relaxed"
            >
              {league.name}
            </Link>
            {/* The way back out. Someone in several leagues needs an exit from
                every page, not just a browser Back button, and the season
                doubles as a reminder of which year's league this is. */}
            <Link
              href="/"
              className="font-mono text-sm text-retro-offwhite/60 hover:text-retro-yellow w-fit"
            >
              {league.season} &middot; switch league
            </Link>
          </div>

          <nav className="flex flex-wrap items-center gap-2 sm:gap-3 font-pixel text-[10px] sm:text-xs uppercase">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="px-2 py-2 border-2 border-transparent text-retro-offwhite hover:border-retro-offwhite hover:text-retro-yellow transition-colors"
              >
                {link.label}
              </Link>
            ))}
            {membership.is_commissioner ? (
              <Link
                href={`${base}/commish`}
                className="px-2 py-2 border-2 border-retro-yellow text-retro-yellow hover:bg-retro-yellow hover:text-field transition-colors"
              >
                Commish
              </Link>
            ) : null}
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href={`${base}/settings`}
              className="font-mono text-base text-retro-offwhite hover:text-retro-yellow underline decoration-transparent hover:decoration-current hidden sm:inline"
              title="Settings — change the name this league sees"
            >
              {memberName(membership)}
            </Link>
            <form action="/auth/sign-out" method="post">
              <PixelButton variant="secondary" type="submit" className="!px-3 !py-2 text-[10px]">
                Sign Out
              </PixelButton>
            </form>
          </div>
        </div>
      </header>

      <DataFreshness />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
