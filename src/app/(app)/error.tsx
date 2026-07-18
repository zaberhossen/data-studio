"use client";

/**
 * Route error boundary for the authed shell. Next.js renders this when a page or
 * its data throws, keeping the app chrome alive and offering a recoverable retry
 * instead of a blank screen.
 */

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Surface for local debugging; a real telemetry sink lands in M15.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-md border border-destructive/40 bg-destructive/5 p-6 text-center">
        <p className="text-sm font-semibold text-destructive">Something went wrong</p>
        <p className="mt-1 whitespace-pre-wrap text-xs text-destructive/90">
          {error.message || "An unexpected error occurred."}
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={reset}>
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    </div>
  );
}
