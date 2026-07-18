/**
 * Org member + invitation shapes shared between the server store and the client
 * management UI, plus the PURE role-permission helpers that both sides use.
 *
 * Client-safe: types + total functions only, no server imports. The DB-dependent
 * guards (last-owner protection, self-checks) live in `lib/server/member-store.ts`
 * and build on the pure helpers here.
 */

import type { MemberRole } from "@/lib/db/scope";

export type { MemberRole };

/** A member of the caller's org, projected for the management table. */
export interface OrgMember {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: MemberRole;
  /** ISO-8601. */
  createdAt: string;
  /** True for the caller's own membership (can't self-modify). */
  isSelf: boolean;
}

/** A pending (unaccepted, unrevoked) invitation. */
export interface OrgInvite {
  id: string;
  email: string;
  role: MemberRole;
  /** The opaque accept token — the admin shares the link built from it. */
  token: string;
  invitedByName: string | null;
  /** ISO-8601. */
  createdAt: string;
  expiresAt: string | null;
}

export type InviteStatus = "valid" | "revoked" | "expired" | "accepted" | "not_found";

/** What an accept page learns about a token before the user acts (no leakage beyond this). */
export interface InvitePreview {
  status: InviteStatus;
  orgName: string | null;
  email: string | null;
  role: MemberRole | null;
}

/** Every role, most-privileged first (for stable dropdown ordering). */
export const ALL_ROLES: readonly MemberRole[] = ["owner", "admin", "editor", "viewer"];

const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

export function roleLabel(role: MemberRole): string {
  return ROLE_LABELS[role];
}

/** Only owners + admins may reach the member-management surface. */
export function canManageMembers(role: MemberRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Whether an actor may modify or remove a member who currently holds
 * `targetRole`. Owners may act on anyone; admins on everyone EXCEPT owners
 * (admins can neither demote, remove, nor be created above an owner).
 */
export function canActOnTarget(actorRole: MemberRole, targetRole: MemberRole): boolean {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return targetRole !== "owner";
  return false;
}

/**
 * Roles an actor may assign — when inviting or changing a member's role. Owners
 * may grant any role (including transferring ownership); admins may grant
 * admin/editor/viewer but never owner.
 */
export function assignableRoles(actorRole: MemberRole): MemberRole[] {
  if (actorRole === "owner") return ["owner", "admin", "editor", "viewer"];
  if (actorRole === "admin") return ["admin", "editor", "viewer"];
  return [];
}

/** Loose but effective email shape check (mirrors the signup validator). */
export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
