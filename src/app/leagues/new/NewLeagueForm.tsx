"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import {
  DEFAULT_LEAGUE_SIZE,
  LEAGUE_SIZES,
  estimatedDraftMinutes,
  qbPressure,
  slugify,
} from "@/lib/league";
import { createLeagueAction } from "./actions";

/**
 * Create-a-league form: a name and a size. The season comes from the date and
 * the slug from the name.
 *
 * The live web-address preview is not decoration: the slug is the league's
 * permanent URL, and "Sunday Beers ⚽" quietly becoming `sunday-beers` (or
 * nothing usable at all) is much better understood before pressing the button
 * than after.
 *
 * Size shows its consequences as you move it, rather than listing 6-10 and
 * leaving you to guess. The two consequences are real and non-obvious:
 *
 *   - QUARTERBACKS. Rosters carry two, and the pool is exclusive per week, so
 *     a league needs size x 2 startable QBs at once against roughly 26 in a
 *     bye week. Nobody works that out from a dropdown.
 *   - DRAFT LENGTH. This is a live draft EVERY week. Ten managers is about
 *     seven minutes longer than eight, every week, with everyone present —
 *     which is the thing that actually kills leagues.
 */
export function NewLeagueForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [size, setSize] = useState(DEFAULT_LEAGUE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const preview = slugify(name);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const formData = new FormData();
    formData.set("name", name);
    formData.set("size", String(size));

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

        <fieldset className="flex flex-col gap-2">
          <legend className="font-mono text-lg text-retro-offwhite">
            Managers
          </legend>
          <div className="flex flex-wrap gap-2">
            {LEAGUE_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setSize(n)}
                aria-pressed={size === n}
                className={[
                  "font-pixel text-xs px-3 py-2 border-2 transition-colors",
                  size === n
                    ? "bg-retro-yellow text-field border-retro-yellow"
                    : "text-retro-offwhite border-retro-offwhite/40 hover:border-retro-offwhite",
                ].join(" ")}
              >
                {n}
              </button>
            ))}
          </div>

          <p className="font-mono text-base text-retro-offwhite/70">
            {size} managers &middot; {size * 7} picks &middot; about{" "}
            {estimatedDraftMinutes(size)} min per draft, every week.
          </p>

          {qbPressure(size).tight ? (
            // Deliberately not a blocker. It is a real tradeoff, not a
            // mistake, and a commissioner who wants a bigger league should be
            // allowed one as long as they know what they are buying.
            <p className="font-mono text-base text-retro-red">
              Tight on quarterbacks: {qbPressure(size).needed} needed of roughly{" "}
              {qbPressure(size).available} startable in a bye week, so the last
              picks each week will be backups.
            </p>
          ) : (
            <p className="font-mono text-base text-retro-offwhite/50">
              Comfortable on quarterbacks &mdash; {qbPressure(size).needed} needed
              of roughly {qbPressure(size).available} startable in a bye week.
            </p>
          )}

          <p className="font-mono text-base text-retro-offwhite/50">
            You can change this later from the Commish page, until seats fill up.
          </p>
        </fieldset>

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
