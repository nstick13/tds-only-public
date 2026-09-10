"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelButton } from "@/components/ui/PixelButton";
import { acceptInviteAction } from "./actions";

/**
 * The accept step. A button rather than something that fires on page load:
 * joining a league is a commitment, and an invite link forwarded into a group
 * chat gets opened by people who only wanted to look.
 *
 * Redirects into the league on success — including for someone who is already
 * a member, since accept_invite is idempotent and hands back their existing
 * membership without consuming a use.
 */
export function JoinButton({ code, seatsLeft }: { code: string; seatsLeft: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleJoin() {
    setError(null);
    startTransition(async () => {
      const result = await acceptInviteAction(code);
      if (!result.ok || !result.slug) {
        setError(result.error ?? "Couldn't join that league.");
        return;
      }
      router.push(`/l/${result.slug}`);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <PixelButton type="button" onClick={handleJoin} disabled={isPending} className="w-fit">
        {isPending
          ? "Joining..."
          : seatsLeft > 0
            ? "Take a Seat"
            : "Join as a Spectator"}
      </PixelButton>

      {error ? <p className="font-mono text-base text-retro-red">{error}</p> : null}
    </div>
  );
}
