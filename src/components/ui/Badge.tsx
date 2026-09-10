import { HTMLAttributes } from "react";

/**
 * Badge — small colored status pill, primarily for player injury/roster
 * status (Active/OUT/Questionable/Bye), matching the old prototype's
 * badge colors but restyled with hard borders for the retro system.
 */
export type BadgeStatus =
  | "Active"
  | "Questionable"
  | "Doubtful"
  | "OUT"
  | "IR"
  | "Bye";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status: BadgeStatus;
}

const STATUS_CLASSES: Record<BadgeStatus, string> = {
  Active: "bg-retro-green text-field border-black",
  Questionable: "bg-retro-yellow text-field border-black",
  Doubtful: "bg-retro-yellow text-field border-black",
  OUT: "bg-retro-red text-retro-offwhite border-black",
  IR: "bg-retro-red text-retro-offwhite border-black",
  Bye: "bg-field text-retro-offwhite border-retro-offwhite",
};

export function Badge({ status, className = "", ...props }: BadgeProps) {
  return (
    <span
      className={[
        "font-pixel text-[10px] uppercase px-2 py-1 border-2 inline-block whitespace-nowrap",
        STATUS_CLASSES[status],
        className,
      ].join(" ")}
      {...props}
    >
      {props.children ?? status}
    </span>
  );
}
