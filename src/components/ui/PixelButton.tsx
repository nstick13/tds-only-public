import { ButtonHTMLAttributes, forwardRef } from "react";

/**
 * PixelButton — the app's standard button primitive: chunky border,
 * hard drop shadow, uppercase pixel-font label. Use for all primary/
 * secondary actions instead of raw <button> so styling stays consistent.
 *
 * variant "primary" = yellow (main CTAs), "secondary" = outline on navy,
 * "danger" = red (destructive actions, e.g. commissioner overrides).
 */
export interface PixelButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
}

const VARIANT_CLASSES: Record<NonNullable<PixelButtonProps["variant"]>, string> = {
  primary: "bg-retro-yellow text-field border-black hover:brightness-95",
  secondary:
    "bg-field text-retro-offwhite border-retro-offwhite hover:bg-field-light",
  danger: "bg-retro-red text-retro-offwhite border-black hover:brightness-95",
};

export const PixelButton = forwardRef<HTMLButtonElement, PixelButtonProps>(
  function PixelButton({ variant = "primary", className = "", ...props }, ref) {
    return (
      <button
        ref={ref}
        className={[
          "font-pixel text-xs sm:text-sm uppercase px-4 py-3 border-4",
          "shadow-pixel active:translate-x-[2px] active:translate-y-[2px] active:shadow-pixel-sm",
          "transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-x-0 disabled:active:translate-y-0 disabled:active:shadow-pixel",
          VARIANT_CLASSES[variant],
          className,
        ].join(" ")}
        {...props}
      />
    );
  },
);
