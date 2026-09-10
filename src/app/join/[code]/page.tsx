import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelLink } from "@/components/ui/PixelLink";
import { JoinButton } from "./JoinButton";

/**
 * /join/[code] — what an invite link opens.
 *
 * Everything here comes from `get_invite_preview`, which is security definer
 * for a reason: the visitor is by definition not a member yet, so they cannot
 * read `leagues` at all. The preview exposes only a league name and a seat
 * count — never the roster, never who is in it — so a leaked or forwarded
 * link reveals nothing beyond what the sender already told them.
 */

/** One row of get_invite_preview. Zero rows means the code doesn't exist. */
interface InvitePreview {
  league_name: string;
  season: number;
  seats_taken: number;
  seats_total: number;
  valid: boolean;
  /** 'revoked' | 'expired' | 'used_up', or null when valid. */
  reason: string | null;
}

/**
 * What to say about a link that no longer works. Each case is a different
 * fix, so each gets its own sentence rather than one shrug for all three.
 */
const REASON_COPY: Record<string, string> = {
  revoked:
    "This invite link was revoked. Ask the commissioner for a new one — the old link can't be un-revoked.",
  expired:
    "This invite link has expired. Ask the commissioner to mint a fresh one; it takes them one click.",
  used_up:
    "This invite link has been used as many times as it was meant to be. Ask the commissioner for another.",
};

export default async function JoinPage({ params }: { params: { code: string } }) {
  const { code } = params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // get_invite_preview is granted to `authenticated` only, so a signed-out
  // visitor genuinely cannot be shown the league's name — and shouldn't be:
  // an unauthenticated preview endpoint would let anyone brute-force codes to
  // enumerate league names. Sign in first, carrying the code through the OAuth
  // round trip so they land back here rather than on a blank home page.
  if (!user) {
    return (
      <Shell>
        <h1 className="font-pixel text-lg text-retro-yellow">You&apos;ve been invited</h1>
        <p className="font-mono text-lg text-retro-offwhite">
          Sign in with Google and we&apos;ll bring you straight back to this
          invite. Signing in is also signing up — there&apos;s no separate step.
        </p>
        <PixelLink
          href={`/login?next=${encodeURIComponent(`/join/${code}`)}`}
          className="w-fit"
        >
          Sign In to Continue
        </PixelLink>
      </Shell>
    );
  }

  const { data, error } = await supabase.rpc("get_invite_preview", { p_code: code });
  const preview = (Array.isArray(data) ? data : [data])[0] as InvitePreview | undefined;

  if (error || !preview) {
    return (
      <Shell>
        <h1 className="font-pixel text-lg text-retro-yellow">Invite not found</h1>
        <p className="font-mono text-lg text-retro-offwhite">
          That link doesn&apos;t match any invite. Check it was copied in full —
          invite codes are long and easy to truncate in a chat app.
        </p>
        <BackHome />
      </Shell>
    );
  }

  if (!preview.valid) {
    return (
      <Shell>
        <h1 className="font-pixel text-lg text-retro-yellow">{preview.league_name}</h1>
        <p className="font-mono text-lg text-retro-offwhite">
          {REASON_COPY[preview.reason ?? ""] ?? "This invite link is no longer valid."}
        </p>
        <BackHome />
      </Shell>
    );
  }

  const seatsLeft = Math.max(0, preview.seats_total - preview.seats_taken);

  return (
    <Shell>
      <h1 className="font-pixel text-lg text-retro-yellow">{preview.league_name}</h1>

      <p className="font-mono text-lg text-retro-offwhite">
        {preview.season} season &middot; {preview.seats_taken} of{" "}
        {preview.seats_total} seats taken
      </p>

      {seatsLeft > 0 ? (
        <p className="font-mono text-lg text-retro-offwhite/80">
          Join and you&apos;ll be handed the lowest free seat, which makes you a
          manager: you draft a roster every week and you&apos;re scored on
          touchdowns only.
        </p>
      ) : (
        // Not an error state. They clicked a link they were given, and
        // bouncing them for arriving ninth would be the wrong call — the
        // commissioner can free a seat later. Say plainly what they get.
        <p className="font-mono text-lg text-retro-offwhite/80">
          All {preview.seats_total} seats are taken, so you&apos;ll join as a
          spectator: you can see every draft, roster and scoreboard, but you
          won&apos;t hold a team. If someone drops, the commissioner can hand
          you their seat.
        </p>
      )}

      <JoinButton code={code} seatsLeft={seatsLeft} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <PixelPanel raised className="w-full max-w-lg flex flex-col gap-5">
        {children}
      </PixelPanel>
    </main>
  );
}

function BackHome() {
  return (
    <Link
      href="/"
      className="font-mono text-base text-retro-offwhite/60 hover:text-retro-yellow w-fit"
    >
      &larr; Your leagues
    </Link>
  );
}
