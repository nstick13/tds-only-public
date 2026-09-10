"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { Badge } from "@/components/ui/Badge";
import { openSeasonAction, finalizeAndAdvanceAction } from "@/app/l/[slug]/commish/actions";
import type { Stage, LeagueMember } from "@/lib/types";

const STATUS_LABEL: Record<Stage["status"], string> = {
  upcoming: "Upcoming",
  draft_open: "Draft Open",
  locked: "Locked",
  finalized: "Finalized",
};

interface SeasonControlProps {
  slug: string;
  stages: Stage[];
  /** Seated managers only — the people the draft will actually deal to. */
  managers: LeagueMember[];
  currentStage: Stage | null;
  /** Seats in THIS league (6-10). */
  size: number;
}

/** Minimum seats for a draft that means anything. Mirrored in openSeasonAction. */
const MIN_MANAGERS = 2;

export function SeasonControl({
  slug,
  stages,
  managers,
  currentStage,
  size,
}: SeasonControlProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const firstStage = [...stages].sort((a, b) => a.ordinal - b.ordinal)[0];
  const seasonOpened = !!firstStage && firstStage.status !== "upcoming";

  const finalizableStages = stages
    .filter((s) => s.status !== "upcoming" && s.status !== "finalized")
    .sort((a, b) => a.ordinal - b.ordinal);

  const [selectedStageId, setSelectedStageId] = useState<string>(
    currentStage?.id ?? finalizableStages[0]?.id ?? "",
  );

  function handleOpenSeason() {
    setMessage(null);
    startTransition(async () => {
      const result = await openSeasonAction(slug);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  function handleFinalize() {
    if (selectedStageId === "") return;
    setMessage(null);
    startTransition(async () => {
      const result = await finalizeAndAdvanceAction(slug, selectedStageId);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Season Control</h2>

      <div className="flex flex-wrap items-center gap-3 font-mono text-base text-retro-offwhite/80">
        <span>Seated managers: {managers.length}/{size}</span>
        {currentStage ? (
          <span className="flex items-center gap-2">
            Current stage: {currentStage.name}
            <Badge
              status="Active"
              className="!bg-field !text-retro-offwhite !border-retro-offwhite"
            >
              {STATUS_LABEL[currentStage.status]}
            </Badge>
          </span>
        ) : (
          <span>Season complete — every stage finalized.</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <PixelButton
          onClick={handleOpenSeason}
          disabled={isPending || seasonOpened || managers.length < MIN_MANAGERS}
          title={
            managers.length < MIN_MANAGERS
              ? `Need at least ${MIN_MANAGERS} seated managers — invite people from the Members section below`
              : undefined
          }
        >
          Open Season (Week 1 Draft)
        </PixelButton>
        {seasonOpened ? (
          <span className="font-mono text-sm text-retro-offwhite/60">
            Season already opened.
          </span>
        ) : managers.length < MIN_MANAGERS ? (
          <span className="font-mono text-sm text-retro-yellow">
            {managers.length}/{size} seated — invite at least{" "}
            {MIN_MANAGERS} managers before opening.
          </span>
        ) : managers.length < size ? (
          <span className="font-mono text-sm text-retro-yellow">
            {managers.length}/{size} seated — it&apos;ll play fine short.
          </span>
        ) : null}
      </div>

      <div className="border-t-2 border-retro-offwhite/30 pt-4 flex flex-col gap-3">
        <h3 className="font-pixel text-xs text-retro-offwhite">Finalize &amp; Advance</h3>
        <p className="font-mono text-sm text-retro-offwhite/70">
          Computes standings for the chosen stage, finalizes it, then opens the next
          stage&apos;s draft seeded by those standings (last place picks first).
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="font-mono text-base bg-field border-2 border-retro-offwhite text-retro-offwhite px-2 py-2"
            value={selectedStageId}
            onChange={(e) => setSelectedStageId(e.target.value)}
            disabled={finalizableStages.length === 0}
          >
            {finalizableStages.length === 0 ? (
              <option value="">No stage ready to finalize</option>
            ) : (
              finalizableStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({STATUS_LABEL[s.status]})
                </option>
              ))
            )}
          </select>
          <PixelButton
            variant="danger"
            onClick={handleFinalize}
            disabled={isPending || selectedStageId === ""}
          >
            Finalize &amp; Advance
          </PixelButton>
        </div>
      </div>

      {message ? (
        <p
          className={[
            "font-mono text-sm",
            message.ok ? "text-retro-green" : "text-retro-red",
          ].join(" ")}
        >
          {message.text}
        </p>
      ) : null}
    </PixelPanel>
  );
}
