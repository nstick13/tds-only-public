"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { Badge } from "@/components/ui/Badge";
import {
  removeMemberAction,
  updateLeagueSizeAction,
  updateMemberAction,
} from "@/app/l/[slug]/commish/actions";
import { memberName, type LeagueMember } from "@/lib/types";
import { LEAGUE_SIZES } from "@/lib/league";

interface MemberAdminProps {
  slug: string;
  members: LeagueMember[];
  /** The signed-in commissioner, so the table can refuse to let them break themselves. */
  currentUserId: string;
  /** Seats in THIS league (6-10). Not a global constant any more. */
  size: number;
}

/**
 * Seats, commissioners, and who's still in the league.
 *
 * This panel is the public app's replacement for a step the private one
 * simply didn't have a UI for: "open Supabase Studio and edit the profiles
 * table". A stranger who starts a league here has no Studio and no business
 * needing one, so everything a league's setup actually requires — hand
 * someone a seat, bench them, promote a co-commissioner, remove a leaver —
 * has to be a button.
 *
 * Seat and is_player are one control, not two. A CHECK constraint requires
 * them to agree, and the draft derives its round count from the seated
 * managers, so "seated" and "benched" is the real distinction: clearing a
 * seat benches someone without removing them, and they keep watching.
 */
export function MemberAdmin({
  slug,
  members,
  currentUserId,
  size,
}: MemberAdminProps) {
  // Depends on the league's size, so it cannot be module-level any more.
  const seatOptions: (number | null)[] = [
    null,
    ...Array.from({ length: size }, (_, i) => i + 1),
  ];

  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  /** user_id of the row awaiting a second click to confirm removal. */
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const seatsTaken = members.filter((m) => m.seat !== null).length;

  function run(label: string, fn: () => Promise<{ success: boolean; message: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      setMessage({ text: `${label}: ${result.message}`, ok: result.success });
      if (result.success) {
        setConfirmingRemoval(null);
        router.refresh();
      }
    });
  }

  function handleSeat(member: LeagueMember, value: string) {
    const seat = value === "" ? null : Number(value);
    if (seat === member.seat) return;
    run(memberName(member), () =>
      updateMemberAction({ slug, userId: member.user_id, seat }),
    );
  }

  function handleCommissioner(member: LeagueMember, next: boolean) {
    run(memberName(member), () =>
      updateMemberAction({ slug, userId: member.user_id, is_commissioner: next }),
    );
  }

  function handleRemove(member: LeagueMember) {
    // Two clicks, no modal. Removing someone mid-season is rare and
    // irreversible-ish (they need a fresh invite to come back), but a dialog
    // for it would be heavier than the rest of this page.
    if (confirmingRemoval !== member.user_id) {
      setConfirmingRemoval(member.user_id);
      return;
    }
    run(memberName(member), () => removeMemberAction(slug, member.user_id));
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Members</h2>
      <p className="font-mono text-sm text-retro-offwhite/70">
        {seatsTaken} of {size} seats filled. A member without a seat is a
        spectator: they see everything and draft nothing. Clearing a seat
        benches someone without removing them.
      </p>

      {/* Resizing lives here rather than on the create form alone, because the
          case that matters is discovered late: you planned for eight, six
          turned up, and a real six-manager league beats two empty seats and a
          short draft every week. Shrinking past an occupied seat is refused —
          by a database trigger, so it holds even if someone accepts an invite
          at the same instant. */}
      <div className="flex flex-wrap items-center gap-2 border-t-2 border-retro-offwhite/10 pt-3">
        <span className="font-mono text-sm text-retro-offwhite/70">
          League seats:
        </span>
        {LEAGUE_SIZES.map((n) => (
          <button
            key={n}
            type="button"
            disabled={isPending}
            onClick={() => run(`${n} seats`, () => updateLeagueSizeAction(slug, n))}
            aria-pressed={size === n}
            className={[
              "font-pixel text-[10px] px-2 py-1 border-2 transition-colors disabled:opacity-50",
              size === n
                ? "bg-retro-yellow text-field border-retro-yellow"
                : "text-retro-offwhite border-retro-offwhite/40 hover:border-retro-offwhite",
            ].join(" ")}
          >
            {n}
          </button>
        ))}
        {seatsTaken > 0 ? (
          <span className="font-mono text-sm text-retro-offwhite/50">
            can&apos;t go below {seatsTaken}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full font-mono text-base text-retro-offwhite border-collapse">
          <thead>
            <tr className="text-left border-b-2 border-retro-offwhite/40 font-pixel text-[10px] uppercase text-retro-offwhite/70">
              <th className="py-2 pr-3">Member</th>
              <th className="py-2 pr-3">Seat</th>
              <th className="py-2 pr-3">Commish</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isMe = member.user_id === currentUserId;
              const confirming = confirmingRemoval === member.user_id;

              return (
                <tr key={member.user_id} className="border-b-2 border-retro-offwhite/10">
                  <td className="py-2 pr-3">
                    {memberName(member)}
                    {isMe ? (
                      <span className="text-retro-offwhite/50"> (you)</span>
                    ) : null}
                    {member.seat === null ? (
                      <Badge
                        status="Bye"
                        className="ml-2 !text-[9px] !px-1 !py-0.5"
                      >
                        Spectator
                      </Badge>
                    ) : null}
                  </td>

                  <td className="py-2 pr-3">
                    <select
                      className="bg-field border-2 border-retro-offwhite text-retro-offwhite px-1 py-1"
                      value={member.seat ?? ""}
                      disabled={isPending}
                      onChange={(e) => handleSeat(member, e.target.value)}
                    >
                      {seatOptions.map((seat) => (
                        <option key={seat ?? "none"} value={seat ?? ""}>
                          {seat ?? "— benched —"}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td className="py-2 pr-3 text-center">
                    <input
                      type="checkbox"
                      checked={member.is_commissioner}
                      disabled={isPending}
                      onChange={(e) => handleCommissioner(member, e.target.checked)}
                      aria-label={`${memberName(member)} is a commissioner`}
                    />
                  </td>

                  <td className="py-2 pr-3">
                    {isMe ? (
                      // Self-removal would risk leaving the league with no
                      // commissioner, which nothing can undo from inside the app.
                      <span className="text-retro-offwhite/40 text-sm">—</span>
                    ) : (
                      <PixelButton
                        variant={confirming ? "danger" : "secondary"}
                        className="!px-2 !py-1 text-[10px]"
                        onClick={() => handleRemove(member)}
                        disabled={isPending}
                      >
                        {confirming ? "Really remove?" : "Remove"}
                      </PixelButton>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
