"use client";

/**
 * MembersView — the /members page: org member + invitation management for
 * owners/admins. Non-admins get a restricted panel (the API also 403s them).
 *
 * Members table: role is an inline Select (constrained to the roles the actor
 * may assign, and locked on your own seat / on owners you can't touch); a Remove
 * action per row. Invitations: an invite form (email + role) that mints a
 * shareable accept link (no mailer wired — the admin copies the link), plus a
 * list of pending invites with copy-link + revoke.
 */

import * as React from "react";
import { useSession } from "next-auth/react";
import { Check, Copy, Loader2, Mail, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";
import {
  assignableRoles,
  canActOnTarget,
  canManageMembers,
  isValidEmail,
  roleLabel,
  type MemberRole,
  type OrgInvite,
  type OrgMember,
} from "@/lib/types/members";

function inviteUrl(token: string): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/invite/${token}`;
}

async function readError(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: string };
    return b.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function MembersView() {
  const { data: session } = useSession();
  const actorRole = session?.user?.role ?? null;
  const isAdmin = canManageMembers(actorRole);

  const [members, setMembers] = React.useState<OrgMember[]>([]);
  const [invites, setInvites] = React.useState<OrgInvite[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<OrgMember | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mRes, iRes] = await Promise.all([
        fetch("/api/orgs/members", { cache: "no-store" }),
        fetch("/api/orgs/members/invites", { cache: "no-store" }),
      ]);
      if (!mRes.ok) throw new Error(await readError(mRes));
      if (!iRes.ok) throw new Error(await readError(iRes));
      setMembers((await mRes.json()) as OrgMember[]);
      setInvites((await iRes.json()) as OrgInvite[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load members.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!isAdmin) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to load for non-admins
      setLoading(false);
      return;
    }
    void load();
  }, [isAdmin, load]);

  const changeRole = async (m: OrgMember, role: MemberRole) => {
    if (role === m.role) return;
    setBusyId(m.membershipId);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/members/${m.membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const updated = (await res.json()) as OrgMember;
      setMembers((prev) =>
        prev.map((x) => (x.membershipId === m.membershipId ? { ...x, role: updated.role } : x)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change role.");
    } finally {
      setBusyId(null);
    }
  };

  const removeMember = async (m: OrgMember) => {
    setBusyId(m.membershipId);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/members/${m.membershipId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(await readError(res));
      setMembers((prev) => prev.filter((x) => x.membershipId !== m.membershipId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member.");
    } finally {
      setBusyId(null);
    }
  };

  const revokeInvite = async (inv: OrgInvite) => {
    setBusyId(inv.id);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/members/invites/${inv.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(await readError(res));
      setInvites((prev) => prev.filter((x) => x.id !== inv.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invitation.");
    } finally {
      setBusyId(null);
    }
  };

  const onInvited = (inv: OrgInvite) => {
    setInvites((prev) => [inv, ...prev.filter((x) => x.email !== inv.email)]);
  };

  if (!isAdmin) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Admins only</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Member management is available to organization owners and admins.
          </p>
        </div>
      </div>
    );
  }

  const roleOptions = actorRole ? assignableRoles(actorRole) : [];

  return (
    <div className="mx-auto h-full max-w-4xl overflow-auto p-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">
          Manage who belongs to this organization and what they can do.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <InviteForm
        actorRole={actorRole}
        roleOptions={roleOptions}
        onInvited={onInvited}
        onError={setError}
      />

      {/* ── Members ─────────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold">
          Members {members.length > 0 && <span className="text-muted-foreground">· {members.length}</span>}
        </h2>
        <div className="overflow-hidden rounded-md border border-border">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading members…
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="w-40 px-3 py-2 font-medium">Role</th>
                  <th className="w-16 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const canAct = actorRole ? canActOnTarget(actorRole, m.role) && !m.isSelf : false;
                  const busy = busyId === m.membershipId;
                  // The dropdown offers the roles the actor may assign, always
                  // including the member's current role so it renders.
                  const opts = Array.from(new Set([m.role, ...roleOptions]));
                  return (
                    <tr key={m.membershipId} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">
                          {m.name ?? m.email}
                          {m.isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                        </div>
                        {m.name && <div className="text-xs text-muted-foreground">{m.email}</div>}
                      </td>
                      <td className="px-3 py-2">
                        {canAct ? (
                          <Select value={m.role} onValueChange={(v) => void changeRole(m, v as MemberRole)}>
                            <SelectTrigger className="h-8 w-32" disabled={busy}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {opts.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {roleLabel(r)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="inline-flex h-8 items-center rounded-md bg-muted px-2.5 text-xs font-medium text-muted-foreground">
                            {roleLabel(m.role)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canAct && (
                          <button
                            type="button"
                            aria-label={`Remove ${m.email}`}
                            title="Remove from org"
                            disabled={busy}
                            onClick={() => setRemoving(m)}
                            className="text-muted-foreground transition-colors hover:text-destructive"
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ── Pending invitations ─────────────────────────────────────────── */}
      {invites.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold">
            Pending invitations <span className="text-muted-foreground">· {invites.length}</span>
          </h2>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{inv.email}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {roleLabel(inv.role)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <CopyLinkButton token={inv.token} />
                        <button
                          type="button"
                          aria-label={`Revoke invitation for ${inv.email}`}
                          title="Revoke"
                          disabled={busyId === inv.id}
                          onClick={() => void revokeInvite(inv)}
                          className="p-1 text-muted-foreground transition-colors hover:text-destructive"
                        >
                          {busyId === inv.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            No email is sent — copy each invite link and share it with the person. They accept by
            signing in with the invited email address.
          </p>
        </section>
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove member?"
        description={
          removing
            ? `${removing.name ?? removing.email} will lose access to this organization. This can't be undone.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) void removeMember(removing);
          setRemoving(null);
        }}
      />
    </div>
  );
}

function InviteForm({
  actorRole,
  roleOptions,
  onInvited,
  onError,
}: {
  actorRole: MemberRole | null;
  roleOptions: MemberRole[];
  onInvited: (inv: OrgInvite) => void;
  onError: (msg: string | null) => void;
}) {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<MemberRole>("viewer");
  const [pending, setPending] = React.useState(false);
  const [justInvited, setJustInvited] = React.useState<OrgInvite | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email.trim())) {
      onError("Enter a valid email address.");
      return;
    }
    setPending(true);
    onError(null);
    try {
      const res = await fetch("/api/orgs/members/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const inv = (await res.json()) as OrgInvite;
      onInvited(inv);
      setJustInvited(inv);
      setEmail("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to send invitation.");
    } finally {
      setPending(false);
    }
  };

  const options = actorRole ? roleOptions : [];

  return (
    <form onSubmit={submit} className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="invite-email" className="mb-1 block text-xs font-medium text-muted-foreground">
            Invite by email
          </label>
          <Input
            id="invite-email"
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="w-32">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
          <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
            <SelectTrigger className="h-[38px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={pending || !email.trim()}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Invite
        </Button>
      </div>

      {justInvited && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Invite link for {justInvited.email}:</span>
          <code className="flex-1 truncate font-mono text-xs">{inviteUrl(justInvited.token)}</code>
          <CopyLinkButton token={justInvited.token} withLabel />
        </div>
      )}
    </form>
  );
}

function CopyLinkButton({ token, withLabel }: { token: string; withLabel?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select the visible link */
    }
  };
  return (
    <Button type="button" variant="outline" size="xs" onClick={() => void copy()}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {withLabel ? (copied ? "Copied" : "Copy") : <span className="sr-only">Copy invite link</span>}
    </Button>
  );
}
