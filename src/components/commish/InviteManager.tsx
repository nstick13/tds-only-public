"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { InviteLink } from "@/components/league/InviteLink";
import { createInviteAction, revokeInviteAction } from "@/app/l/[slug]/commish/actions";
import { timeAgo, timeUntil } from "@/lib/timeAgo";
import type { LeagueInvite } from "@/lib/types";

interface InviteManagerProps {
  slug: string;
  /** Newest first. Commissioner-readable only — an invite code IS a credential. */
  invites: LeagueInvite[];
}

type InviteState = "live" | "revoked" | "expired" | "used up";

function stateOf(invite: LeagueInvite, now: number): InviteState {
  if (invite.revoked_at) return "revoked";
  if (invite.expires_at && new Date(invite.expires_at).getTime() < now) return "expired";
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return "used up";
  return "live";
}

/**
 * Invite links: mint one, copy it, revoke it.
 *
 * The normal flow is one link pasted into a group chat for seven people, so
 * invites are multi-use by default and the newest live one is what the panel
 * puts in front of you. Older ones stay listed because a revoke is only
 * useful if you can tell which link you're revoking — and revoking is the one
 * thing that makes a leaked link safe, since a code is the whole credential
 * for getting into a league.
 */
export function InviteManager({ slug, invites }: InviteManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const now = Date.now();

  const live = invites.filter((i) => stateOf(i, now) === "live");
  const past = invites.filter((i) => stateOf(i, now) !== "live");

  function handleCreate() {
    setMessage(null);
    startTransition(async () => {
      const result = await createInviteAction(slug);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  function handleRevoke(code: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await revokeInviteAction(slug, code);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Invite Links</h2>
      <p className="font-mono text-sm text-retro-offwhite/70">
        Anyone who opens a live link joins and takes the lowest free seat.
        Links last 7 days. Revoke one that ended up somewhere it shouldn&apos;t
        have — that is the only way to un-share it.
      </p>

      {live.length === 0 ? (
        <p className="font-mono text-base text-retro-offwhite/60">
          No live invite links. Mint one to add managers.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {live.map((invite) => (
            <li key={invite.code} className="flex flex-col gap-2">
              <InviteLink code={invite.code} />
              <div className="flex flex-wrap items-center gap-3 font-mono text-sm text-retro-offwhite/60">
                <span>
                  Used {invite.uses} time{invite.uses === 1 ? "" : "s"}
                  {invite.max_uses != null ? ` of ${invite.max_uses}` : ""}
                </span>
                {invite.expires_at ? (
                  <span>Expires {timeUntil(invite.expires_at)}</span>
                ) : (
                  <span>No expiry</span>
                )}
                <PixelButton
                  variant="secondary"
                  className="!px-2 !py-1 text-[10px]"
                  onClick={() => handleRevoke(invite.code)}
                  disabled={isPending}
                >
                  Revoke
                </PixelButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <PixelButton onClick={handleCreate} disabled={isPending} className="w-fit">
        {isPending ? "Working..." : "New Invite Link"}
      </PixelButton>

      {past.length > 0 ? (
        <div className="flex flex-col gap-1 border-t-2 border-retro-offwhite/20 pt-3">
          <h3 className="font-pixel text-[10px] uppercase text-retro-offwhite/60">
            No longer working
          </h3>
          {past.map((invite) => (
            <p key={invite.code} className="font-mono text-sm text-retro-offwhite/50">
              <span className="text-retro-offwhite/70">{stateOf(invite, now)}</span>
              {" — "}
              minted {timeAgo(invite.created_at)}, used {invite.uses} time
              {invite.uses === 1 ? "" : "s"}
            </p>
          ))}
        </div>
      ) : null}

      {message ? (
        <p
          className={["font-mono text-sm", message.ok ? "text-retro-green" : "text-retro-red"].join(
            " ",
          )}
        >
          {message.text}
        </p>
      ) : null}
    </PixelPanel>
  );
}
