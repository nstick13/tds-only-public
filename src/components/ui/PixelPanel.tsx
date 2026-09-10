import { HTMLAttributes } from "react";

/**
 * PixelPanel — bordered box/card primitive used to group content
 * (player cards, roster slots, panels, modals). Use instead of ad-hoc
 * divs with borders so spacing/border weight stays consistent app-wide.
 */
export interface PixelPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds the hard drop-shadow used for "raised" panels (cards, modals). */
  raised?: boolean;
}

export function PixelPanel({
  raised = false,
  className = "",
  ...props
}: PixelPanelProps) {
  return (
    <div
      className={[
        "bg-field-light border-4 border-retro-offwhite p-4",
        raised ? "shadow-pixel" : "",
        className,
      ].join(" ")}
      {...props}
    />
  );
}
