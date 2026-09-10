"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { updateDisplayNameAction } from "./actions";

interface DisplayNameFormProps {
  slug: string;
  leagueName: string;
  initialName: string;
}

/**
 * Sets the name this ONE league sees on the draft board and standings.
 *
 * Naming the league in the copy is not padding: someone in three leagues
 * arriving from three different nav bars needs to know which of their names
 * they are about to change.
 */
export function DisplayNameForm({ slug, leagueName, initialName }: DisplayNameFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    const formData = new FormData();
    formData.set("displayName", name);

    startTransition(async () => {
      const result = await updateDisplayNameAction(slug, formData);
      setMessage({ text: result.message, ok: result.success });
      if (result.success) router.refresh();
    });
  }

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h1 className="font-pixel text-lg text-retro-yellow">Display Name</h1>

      <p className="font-mono text-lg text-retro-offwhite/80">
        What {leagueName} sees on the draft board and standings. It&apos;s set
        per league, so changing it here leaves your other leagues alone.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 font-mono text-lg">
          Display Name
          <input
            type="text"
            required
            minLength={2}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-field border-2 border-retro-offwhite px-3 py-2 font-mono text-lg text-retro-offwhite"
            autoComplete="nickname"
          />
        </label>

        {message ? (
          <p
            className={[
              "font-mono text-base",
              message.ok ? "text-retro-green" : "text-retro-red",
            ].join(" ")}
          >
            {message.text}
          </p>
        ) : null}

        <PixelButton type="submit" disabled={isPending}>
          {isPending ? "Saving..." : "Save"}
        </PixelButton>
      </form>
    </PixelPanel>
  );
}
