"use client";

/**
 * Route error boundary for public/embed pages. Keeps a crash from a shared or
 * embedded dashboard from blanking the frame; no app chrome here, so the message
 * stands alone.
 */

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-md border border-border bg-card p-6 text-center">
        <p className="text-sm font-semibold text-foreground">This content couldn&apos;t be loaded</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The shared view ran into a problem.
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={reset}>
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    </div>
  );
}
