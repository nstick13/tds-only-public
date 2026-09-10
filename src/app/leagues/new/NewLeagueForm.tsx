"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { slugify } from "@/lib/league";
import { createLeagueAction } from "./actions";

/**
 * Create-a-league form. One field, because one field is all the RPC needs —
 * the season comes from the date and the slug from the name.
 *
 * The live web-address preview is not decoration: the slug is the league's
 * permanent URL, and "Sunday Beers ⚽" quietly becoming `sunday-beers` (or
 * nothing usable at all) is much better understood before pressing the button
 * than after.
 */
export function NewLeagueForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const preview = slugify(name);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const formData = new FormData();
    formData.set("name", name);

    startTransition(async () => {
      const result = await createLeagueAction(formData);
      if (!result.ok || !result.slug) {
        setError(result.error ?? "Couldn't create the league.");
        return;
      }
      // Land in the new league with the invite code in tow — the league page
      // turns it into the loud "share this" panel. Getting the link in front
      // of the commissioner immediately is the entire point of this flow; a
      // league of one is not a league.
      router.push(
        `/l/${result.slug}?created=${encodeURIComponent(result.inviteCode ?? "")}`,
      );
    });
  }

  return (
    <PixelPanel raised className="flex flex-col gap-5">
      <h1 className="font-pixel text-lg text-retro-yellow">Create a League</h1>

      <p className="font-mono text-lg text-retro-offwhite/80">
        You&apos;ll be its commissioner and take seat 1. Everyone else joins from
        an invite link you share next.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 font-mono text-lg text-retro-offwhite">
          League Name
          <input
            type="text"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sunday Beers"
            autoFocus
            className="bg-field border-2 border-retro-offwhite px-3 py-2 font-mono text-lg text-retro-offwhite placeholder:text-retro-offwhite/40 focus:outline-none focus:border-retro-yellow"
          />
        </label>

        <p className="font-mono text-base text-retro-offwhite/60">
          {name.trim() === "" ? (
            <>Web address: /l/&hellip;</>
          ) : preview ? (
            <>
              Web address: <span className="text-retro-offwhite">/l/{preview}</span>
            </>
          ) : (
            <span className="text-retro-red">
              That name has no letters or digits to build a web address from.
            </span>
          )}
        </p>

        {error ? (
          <p className="font-mono text-base text-retro-red">{error}</p>
        ) : null}

        <PixelButton type="submit" disabled={isPending || !preview} className="w-fit">
          {isPending ? "Creating..." : "Create League"}
        </PixelButton>
      </form>
    </PixelPanel>
  );
}
