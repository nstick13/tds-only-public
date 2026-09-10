"use client";

import { useEffect, useState } from "react";
import { PixelButton } from "@/components/ui/PixelButton";

/**
 * A shareable invite link, with a copy button.
 *
 * The absolute URL is built in the browser from window.location.origin
 * rather than on the server. A server-rendered origin has to be guessed from
 * headers, and behind Vercel's proxy that guess lands on an internal host —
 * producing a link that works for nobody. The origin the commissioner is
 * looking at is by definition the one they can share.
 *
 * Renders the code alone until hydration so the value is never missing, just
 * not yet clickable.
 */
export function InviteLink({ code }: { code: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const url = origin ? `${origin}/join/${code}` : `/join/${code}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure context, permissions).
      // The link is right there on screen to select by hand, so this is a
      // missing convenience rather than a failure worth an error message.
    }
  }

  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
      <code className="flex-1 min-w-0 break-all border-2 border-retro-offwhite/40 bg-field px-3 py-2 font-mono text-base text-retro-offwhite">
        {url}
      </code>
      <PixelButton
        type="button"
        variant="secondary"
        className="!px-3 !py-2 text-[10px] shrink-0"
        onClick={copy}
      >
        {copied ? "Copied" : "Copy"}
      </PixelButton>
    </div>
  );
}
