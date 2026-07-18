// Skeleton primitive — pulsing surface block for loading states.
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-300", className)}
      {...props}
    />
  );
}

export { Skeleton };
