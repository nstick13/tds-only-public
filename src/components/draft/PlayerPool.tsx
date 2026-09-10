"use client";

import { useMemo, useState } from "react";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { Badge, type BadgeStatus } from "@/components/ui/Badge";
import type { Player } from "@/lib/types";
import { POSITIONS, ROSTER_SHAPE, type Position } from "@/lib/roster";
import { countSlot, isPlayerDraftable, reasonPlayerBlocked } from "@/components/draft/draftLogic";
import type { RosterPick } from "@/lib/types";

export interface PlayerPoolProps {
  players: Player[];
  isMyTurn: boolean;
  myPicks: Pick<RosterPick, "manager_id" | "slot_position">[];
  myManagerId: string | null;
  onDraft: (player: Player) => void;
  draftingPlayerId: string | null;
}

function badgeStatusFor(player: Player): BadgeStatus | null {
  if (player.status === "Active" || !player.status) return null;
  const normalized = player.status.toUpperCase();
  if (normalized === "OUT") return "OUT";
  if (normalized === "IR") return "IR";
  if (normalized === "QUESTIONABLE") return "Questionable";
  if (normalized === "DOUBTFUL") return "Doubtful";
  // PUP or any other free-text status from ESPN: fall back to a red badge
  // via OUT styling since it's treated as a hard-out.
  return "OUT";
}

/**
 * The available player pool: searchable, filterable by position, each
 * card shows team + status/bye badges and a Draft button whose enabled
 * state reflects every drafting rule (turn, roster caps, hard-out/bye).
 */
export function PlayerPool({
  players,
  isMyTurn,
  myPicks,
  myManagerId,
  onDraft,
  draftingPlayerId,
}: PlayerPoolProps) {
  const [positionFilter, setPositionFilter] = useState<Position | "ALL">("ALL");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return players.filter((p) => {
      if (positionFilter !== "ALL" && p.position !== positionFilter) return false;
      if (search.trim() && !p.name.toLowerCase().includes(search.trim().toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [players, positionFilter, search]);

  return (
    <PixelPanel raised className="flex flex-col gap-3">
      <h2 className="font-pixel text-xs text-retro-yellow">Player Pool</h2>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search players..."
          className="font-mono text-lg flex-1 bg-field border-2 border-retro-offwhite px-3 py-1 text-retro-offwhite placeholder:text-retro-offwhite/40 focus:outline-none focus:border-retro-yellow"
        />
        <div className="flex gap-1 flex-wrap">
          {(["ALL", ...POSITIONS] as const).map((pos) => (
            <button
              key={pos}
              onClick={() => setPositionFilter(pos)}
              className={[
                "font-pixel text-[10px] uppercase px-2 py-2 border-2",
                positionFilter === pos
                  ? "bg-retro-yellow text-field border-black"
                  : "bg-field text-retro-offwhite border-retro-offwhite hover:border-retro-yellow",
              ].join(" ")}
            >
              {pos}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 max-h-[32rem] overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <p className="font-mono text-lg text-retro-offwhite/60 text-center py-6">
            No players match.
          </p>
        ) : (
          filtered.map((player) => {
            const draftable = isPlayerDraftable(player);
            const blockedReason = reasonPlayerBlocked(player);
            const slotFull = myManagerId
              ? countSlot(myPicks, myManagerId, player.position) >=
                ROSTER_SHAPE[player.position]
              : false;
            const canDraft = isMyTurn && draftable && !slotFull;
            const status = badgeStatusFor(player);
            const isDrafting = draftingPlayerId === player.id;

            return (
              <div
                key={player.id}
                className="flex items-center justify-between gap-3 border-2 border-retro-offwhite/40 bg-field px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-lg text-retro-offwhite truncate">
                      {player.name}
                    </span>
                    <span className="font-pixel text-[9px] text-retro-yellow">
                      {player.position}
                    </span>
                    <span className="font-mono text-base text-retro-offwhite/60">
                      {player.nfl_team ?? "FA"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {status ? <Badge status={status} /> : null}
                    {player.on_bye ? <Badge status="Bye" /> : null}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <PixelButton
                    variant="primary"
                    className="!px-3 !py-2 text-[10px]"
                    disabled={!canDraft || isDrafting}
                    onClick={() => onDraft(player)}
                    title={
                      !isMyTurn
                        ? "Not your turn"
                        : slotFull
                          ? `${player.position} slot full`
                          : blockedReason ?? undefined
                    }
                  >
                    {isDrafting ? "Drafting..." : "Draft"}
                  </PixelButton>
                  {slotFull && isMyTurn ? (
                    <span className="font-mono text-sm text-retro-red">Slot full</span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </PixelPanel>
  );
}
