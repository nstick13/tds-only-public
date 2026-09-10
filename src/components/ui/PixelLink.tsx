import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * PixelLink — a navigation link wearing PixelButton's clothes.
 *
 * The multi-league flows are full of "go somewhere" CTAs (create a league,
 * accept an invite, open the league you just made) where a <button> would be
 * wrong: they navigate, so they must be real anchors that middle-click, open
 * in a new tab, and announce themselves as links. Rather than teach
 * PixelButton to render as something other than a button, this shares the one
 * thing that actually needs to match — the class list.
 */
export type PixelLinkVariant = "primary" | "secondary" | "danger";

/** Kept in step with PixelButton by hand; the two are read side by side. */
const VARIANT_CLASSES: Record<PixelLinkVariant, string> = {
  primary: "bg-retro-yellow text-field border-black hover:brightness-95",
  secondary:
    "bg-field text-retro-offwhite border-retro-offwhite hover:bg-field-light",
  danger: "bg-retro-red text-retro-offwhite border-black hover:brightness-95",
};

export interface PixelLinkProps extends ComponentProps<typeof Link> {
  variant?: PixelLinkVariant;
}

export function PixelLink({
  variant = "primary",
  className = "",
  ...props
}: PixelLinkProps) {
  return (
    <Link
      className={[
        "inline-block font-pixel text-xs sm:text-sm uppercase px-4 py-3 border-4 text-center",
        "shadow-pixel active:translate-x-[2px] active:translate-y-[2px] active:shadow-pixel-sm",
        "transition-transform",
        VARIANT_CLASSES[variant],
        className,
      ].join(" ")}
      {...props}
    />
  );
}
