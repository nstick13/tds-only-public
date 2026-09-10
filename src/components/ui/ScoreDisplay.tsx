import { HTMLAttributes } from "react";

/**
 * ScoreDisplay — big pixel-font number for scoreboards, totals, and
 * standings (e.g. a manager's weekly points, a live TD count). Use
 * instead of raw font-pixel spans so scoreboard numerals stay consistent.
 */
export interface ScoreDisplayProps extends HTMLAttributes<HTMLDivElement> {
  value: number | string;
  label?: string;
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES: Record<NonNullable<ScoreDisplayProps["size"]>, string> = {
  sm: "text-lg",
  md: "text-3xl",
  lg: "text-5xl",
};

export function ScoreDisplay({
  value,
  label,
  size = "md",
  className = "",
  ...props
}: ScoreDisplayProps) {
  return (
    <div className={["flex flex-col items-center gap-1", className].join(" ")} {...props}>
      <span className={["font-pixel text-retro-yellow", SIZE_CLASSES[size]].join(" ")}>
        {value}
      </span>
      {label ? (
        <span className="font-mono text-sm uppercase tracking-wide text-retro-offwhite">
          {label}
        </span>
      ) : null}
    </div>
  );
}
