"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { createClient } from "@/lib/supabase/client";
import { updateDraftOrderAction } from "@/app/l/[slug]/commish/actions";
import { memberName, type Stage, type LeagueMember, type DraftOrderRow } from "@/lib/types";

interface DraftOrderEditorProps {
  slug: string;
  stages: Stage[];
  /** Seated managers, in seat order — one round of the snake is exactly this many picks. */
  managers: LeagueMember[];
}

/**
 * View/edit a stage's draft order. Editing works at the round-1-seed level
 * (reorder the managers, up/down) and re-snakes every pick on save — simpler
 * than a free-for-all editor over all 56 cells, and it matches how the seed
 * actually drives the snake.
 */
export function DraftOrderEditor({ slug, stages, managers }: DraftOrderEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const editableStages = useMemo(
    () => [...stages].sort((a, b) => a.ordinal - b.ordinal).filter((s) => s.status !== "upcoming"),
    [stages],
  );

  const [selectedStageId, setSelectedStageId] = useState<string>(
    editableStages[0]?.id ?? "",
  );
  const [order, setOrder] = useState<DraftOrderRow[]>([]);
  const [loading, setLoading] = useState(false);

  const managerName = (id: string | null) => {
    const member = managers.find((m) => m.user_id === id);
    return member ? memberName(member) : "Unassigned";
  };

  // One round is one pick per seated manager, so the seed the editor shows is
  // the first `managers.length` picks — not a hardcoded 8, which would show a
  // half-empty list (or truncate) in a league running short.
  const roundSize = managers.length;

  useEffect(() => {
    if (selectedStageId === "") {
      setOrder([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const supabase = createClient();
    supabase
      .from("draft_order")
      .select("*")
      .eq("stage_id", selectedStageId)
      .order("pick_number", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setOrder(data as DraftOrderRow[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedStageId]);

  const roundOne = order.slice(0, roundSize);

  function move(index: number, dir: -1 | 1) {
    const next = [...roundOne];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder([...next, ...order.slice(roundSize)]);
  }

  function handleSave() {
    if (selectedStageId === "") return;
    const roundOneOrder = roundOne.map((r) => r.manager_id).filter((id): id is string => !!id);
    if (roundOneOrder.length !== roundSize) {
      setMessage({ text: "Round-1 order is incomplete — reload and try again.", ok: false });
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await updateDraftOrderAction(slug, selectedStageId, roundOneOrder);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Draft Order</h2>
      <p className="font-mono text-sm text-retro-offwhite/70">
        Reorder the round-1 seed with the arrows, then save — the whole snake
        regenerates from it. Only works before any picks are made this stage.
      </p>

      <select
        className="font-mono text-base bg-field border-2 border-retro-offwhite text-retro-offwhite px-2 py-2 w-fit"
        value={selectedStageId}
        onChange={(e) => setSelectedStageId(e.target.value)}
      >
        <option value="">Select a stage</option>
        {editableStages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      {loading ? (
        <p className="font-mono text-sm text-retro-offwhite/60">Loading...</p>
      ) : selectedStageId !== "" && roundOne.length === 0 ? (
        <p className="font-mono text-sm text-retro-offwhite/60">
          No draft order for this stage yet.
        </p>
      ) : roundOne.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {roundOne.map((row, i) => (
            <li
              key={row.pick_number}
              className="flex items-center gap-3 font-mono text-base text-retro-offwhite"
            >
              <span className="font-pixel text-xs text-retro-offwhite/50 w-8">
                #{i + 1}
              </span>
              <span className="flex-1">{managerName(row.manager_id)}</span>
              <PixelButton
                variant="secondary"
                className="!px-2 !py-1 text-[10px]"
                onClick={() => move(i, -1)}
                disabled={i === 0}
              >
                Up
              </PixelButton>
              <PixelButton
                variant="secondary"
                className="!px-2 !py-1 text-[10px]"
                onClick={() => move(i, 1)}
                disabled={i === roundOne.length - 1}
              >
                Down
              </PixelButton>
            </li>
          ))}
        </ol>
      ) : null}

      {roundOne.length > 0 ? (
        <PixelButton onClick={handleSave} disabled={isPending} className="w-fit">
          Save Draft Order
        </PixelButton>
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
