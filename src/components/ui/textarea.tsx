// Textarea primitive — mirrors the Input control styling (filled surface,
// strong border, neutral 2px focus outline).
import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[68px] w-full rounded-md border border-strong bg-surface-100 px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground/70 hover:border-stronger focus-visible:border-stronger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
