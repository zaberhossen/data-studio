import * as React from "react";

/** Centered card frame shared by the login + signup pages. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      {children}
    </div>
  );
}
