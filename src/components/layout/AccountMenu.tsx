"use client";

/**
 * Account control in the Topbar: shows the active org + signed-in email and a
 * sign-out button. Reads the session from the client `SessionProvider` seeded by
 * the `(app)` layout, so it renders without a flash.
 */

import { signOut, useSession } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AccountMenu() {
  const { data } = useSession();
  const email = data?.user?.email ?? null;

  return (
    <div className="flex items-center gap-2">
      {email ? (
        <span className="hidden max-w-[180px] truncate text-xs text-muted-foreground sm:inline">
          {email}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        title="Sign out"
        aria-label="Sign out"
        onClick={() => void signOut({ callbackUrl: "/login" })}
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  );
}
