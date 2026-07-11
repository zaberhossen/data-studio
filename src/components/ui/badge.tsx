// Standard shadcn/ui Badge primitive — used for filter chips + status pills.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        muted:
          "border-transparent bg-muted text-muted-foreground",
        // Supabase-style plan/env pills.
        plan: "border-border bg-transparent px-1.5 py-0 text-[10px] uppercase tracking-wide text-muted-foreground",
        warning:
          "border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
