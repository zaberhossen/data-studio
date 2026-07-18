"use client";

/**
 * /invite/[token] — accept an org invitation.
 *
 * Public route (an invitee may be signed out). Fetches a preview of the token,
 * then: signed out → prompts sign-in/sign-up (round-tripping back here via
 * `?callbackUrl`); signed in → an Accept button that POSTs the accept, switches
 * the active org via the session, and lands in the app. All the real guards
 * (email must match, not revoked/expired/accepted) live server-side.
 */

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthShell } from "@/components/auth/AuthShell";
import { roleLabel, type InvitePreview } from "@/lib/types/members";

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const router = useRouter();
  const { data: session, status, update } = useSession();

  const [preview, setPreview] = React.useState<InvitePreview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [accepting, setAccepting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/invites/${token}`, { cache: "no-store" });
        const data = (await res.json()) as InvitePreview;
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setError("Could not load this invitation.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${token}`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Could not accept the invitation.");
      }
      const { orgId } = (await res.json()) as { orgId: string };
      await update({ orgId });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the invitation.");
      setAccepting(false);
    }
  };

  const callbackUrl = `/invite/${token}`;
  const signedIn = status === "authenticated" && Boolean(session?.user);

  return (
    <AuthShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-secondary">
            <Building2 className="h-5 w-5 text-foreground" />
          </div>
          <CardTitle>Organization invitation</CardTitle>
          <CardDescription>
            {loading
              ? "Loading invitation…"
              : preview?.status === "valid"
                ? `You've been invited to join ${preview.orgName} as ${roleLabel(preview.role!)}.`
                : "This invitation can't be used."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3 text-sm">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Please wait…
            </div>
          ) : preview?.status !== "valid" ? (
            <p className="text-muted-foreground">
              {preview?.status === "accepted" && "This invitation has already been accepted."}
              {preview?.status === "revoked" && "This invitation has been revoked."}
              {preview?.status === "expired" && "This invitation has expired."}
              {(preview?.status === "not_found" || !preview) &&
                "This invitation link is invalid."}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                The invitation was sent to <span className="font-medium text-foreground">{preview.email}</span>.
                Accept it with that account.
              </p>
              {error && <p className="text-destructive">{error}</p>}
            </>
          )}
        </CardContent>

        {!loading && preview?.status === "valid" && (
          <CardFooter className="flex-col items-stretch gap-2">
            {signedIn ? (
              <Button onClick={() => void accept()} disabled={accepting}>
                {accepting && <Loader2 className="h-4 w-4 animate-spin" />}
                Accept invitation
              </Button>
            ) : (
              <>
                <Button asChild>
                  <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}>Sign in to accept</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/signup">Create an account</Link>
                </Button>
              </>
            )}
          </CardFooter>
        )}
      </Card>
    </AuthShell>
  );
}
