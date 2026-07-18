// Input primitive — Supabase control styling: filled control surface (no
// shadow), stronger rest border that darkens on hover, and the same neutral
// 2px focus outline the Button uses, so every control focuses identically.
// Height matches the Button size ramp (sm = 34px).
import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-[34px] w-full rounded-md border border-strong bg-surface-100 px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/70 hover:border-stronger focus-visible:border-stronger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
