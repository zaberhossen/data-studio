/**
 * Org member + invitation store (Postgres / Drizzle).
 *
 * All owner-facing methods are org-scoped (`requireOrg`) and admin-gated
 * (`assertCanAdmin`), so an admin can only ever manage their OWN org and can
 * never touch another tenant. On top of the pure role rules in
 * `lib/types/members.ts` this layer enforces the DB-dependent invariants:
 *   - the last owner can never be demoted or removed (an org always has an owner);
 *   - a member can't change or remove their own role/seat here;
 *   - admins can't act on owners or grant the owner role.
 *
 * `getInviteByToken` is the only unauthenticated read (the token is the
 * capability, like a share link) and `acceptInvite` additionally verifies the
 * accepting user's email matches the invited address, so a leaked link can't be
 * redeemed by someone else.
 *
 * SERVER-ONLY.
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invitations, memberships, organizations, users } from "@/lib/db/schema";
import {
  assertCanAdmin,
  ForbiddenError,
  requireOrg,
  type AuthContext,
  type MemberRole,
} from "@/lib/db/scope";
import {
  assignableRoles,
  canActOnTarget,
  isValidEmail,
  type InvitePreview,
  type OrgInvite,
  type OrgMember,
} from "@/lib/types/members";
import { logAudit } from "@/lib/server/audit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string) => UUID_RE.test(id);

/** Pending invites expire after two weeks. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** A 400-shaped error for user-fixable input problems (bad email, dup member). */
export class InputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export class MemberStore {
  // ── Members ──────────────────────────────────────────────────────────────

  async listMembers(ctx: AuthContext): Promise<OrgMember[]> {
    assertCanAdmin(ctx);
    const rows = await db()
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        name: users.name,
        email: users.email,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(requireOrg(memberships.orgId, ctx))
      .orderBy(memberships.createdAt);

    return rows.map((r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      name: r.name,
      email: r.email,
      role: r.role as MemberRole,
      createdAt: r.createdAt.toISOString(),
      isSelf: r.userId === ctx.userId,
    }));
  }

  /** Count owners in the caller's org (for last-owner protection). */
  private async ownerCount(ctx: AuthContext): Promise<number> {
    const [row] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(requireOrg(memberships.orgId, ctx), eq(memberships.role, "owner")));
    return row?.n ?? 0;
  }

  private async loadMembership(ctx: AuthContext, membershipId: string) {
    const [row] = await db()
      .select({ id: memberships.id, userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(requireOrg(memberships.orgId, ctx), eq(memberships.id, membershipId)))
      .limit(1);
    return row ?? null;
  }

  async changeRole(
    ctx: AuthContext,
    membershipId: string,
    role: MemberRole,
  ): Promise<OrgMember | null> {
    assertCanAdmin(ctx);
    if (!isUuid(membershipId)) return null;

    const target = await this.loadMembership(ctx, membershipId);
    if (!target) return null;
    const targetRole = target.role as MemberRole;

    if (target.userId === ctx.userId) {
      throw new ForbiddenError("You can't change your own role.");
    }
    if (!canActOnTarget(ctx.role, targetRole)) {
      throw new ForbiddenError("You don't have permission to modify this member.");
    }
    if (!assignableRoles(ctx.role).includes(role)) {
      throw new ForbiddenError(`You can't assign the "${role}" role.`);
    }
    // Never demote the final owner.
    if (targetRole === "owner" && role !== "owner" && (await this.ownerCount(ctx)) <= 1) {
      throw new InputError("This is the only owner — promote another owner first.");
    }

    await db()
      .update(memberships)
      .set({ role })
      .where(and(requireOrg(memberships.orgId, ctx), eq(memberships.id, membershipId)));

    void logAudit({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "member.role_change",
      entityType: "membership",
      entityId: membershipId,
      metadata: { userId: target.userId, from: targetRole, to: role },
    });

    const [updated] = await db()
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        name: users.name,
        email: users.email,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(requireOrg(memberships.orgId, ctx), eq(memberships.id, membershipId)))
      .limit(1);
    if (!updated) return null;
    return {
      membershipId: updated.membershipId,
      userId: updated.userId,
      name: updated.name,
      email: updated.email,
      role: updated.role as MemberRole,
      createdAt: updated.createdAt.toISOString(),
      isSelf: false,
    };
  }

  async removeMember(ctx: AuthContext, membershipId: string): Promise<boolean> {
    assertCanAdmin(ctx);
    if (!isUuid(membershipId)) return false;

    const target = await this.loadMembership(ctx, membershipId);
    if (!target) return false;
    const targetRole = target.role as MemberRole;

    if (target.userId === ctx.userId) {
      throw new ForbiddenError("You can't remove yourself from the org.");
    }
    if (!canActOnTarget(ctx.role, targetRole)) {
      throw new ForbiddenError("You don't have permission to remove this member.");
    }
    if (targetRole === "owner" && (await this.ownerCount(ctx)) <= 1) {
      throw new InputError("This is the only owner — the org must keep one.");
    }

    const deleted = await db()
      .delete(memberships)
      .where(and(requireOrg(memberships.orgId, ctx), eq(memberships.id, membershipId)))
      .returning({ id: memberships.id });
    if (deleted.length === 0) return false;

    void logAudit({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "member.remove",
      entityType: "membership",
      entityId: membershipId,
      metadata: { userId: target.userId, role: targetRole },
    });
    return true;
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  async listInvites(ctx: AuthContext): Promise<OrgInvite[]> {
    assertCanAdmin(ctx);
    const rows = await db()
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        token: invitations.token,
        invitedByName: users.name,
        invitedByEmail: users.email,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .leftJoin(users, eq(invitations.invitedBy, users.id))
      .where(
        and(
          requireOrg(invitations.orgId, ctx),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .orderBy(desc(invitations.createdAt));

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role as MemberRole,
      token: r.token,
      invitedByName: r.invitedByName ?? r.invitedByEmail ?? null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    }));
  }

  async createInvite(
    ctx: AuthContext,
    emailRaw: string,
    role: MemberRole,
    now: Date = new Date(),
  ): Promise<OrgInvite> {
    assertCanAdmin(ctx);
    const email = emailRaw.trim().toLowerCase();
    if (!isValidEmail(email)) throw new InputError("Enter a valid email address.");
    if (!assignableRoles(ctx.role).includes(role)) {
      throw new ForbiddenError(`You can't invite someone as "${role}".`);
    }

    // Already a member of this org?
    const [existing] = await db()
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(requireOrg(memberships.orgId, ctx), sql`lower(${users.email}) = ${email}`))
      .limit(1);
    if (existing) throw new InputError("That person is already a member.");

    // Supersede any prior pending invite for the same address (idempotent re-invite).
    await db()
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          requireOrg(invitations.orgId, ctx),
          sql`lower(${invitations.email}) = ${email}`,
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    const [row] = await db()
      .insert(invitations)
      .values({
        orgId: ctx.orgId,
        email,
        role,
        token: newToken(),
        invitedBy: ctx.userId,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      })
      .returning();

    void logAudit({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "member.invite",
      entityType: "invitation",
      entityId: row.id,
      metadata: { email, role },
    });

    return {
      id: row.id,
      email: row.email,
      role: row.role as MemberRole,
      token: row.token,
      invitedByName: null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }

  async revokeInvite(ctx: AuthContext, id: string, now: Date = new Date()): Promise<boolean> {
    assertCanAdmin(ctx);
    if (!isUuid(id)) return false;
    const rows = await db()
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          requireOrg(invitations.orgId, ctx),
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (rows.length === 0) return false;
    void logAudit({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "member.invite_revoke",
      entityType: "invitation",
      entityId: id,
    });
    return true;
  }

  /** UNAUTHENTICATED preview of a token (the token is the capability). */
  async getInviteByToken(token: string, now: Date = new Date()): Promise<InvitePreview> {
    const notFound: InvitePreview = { status: "not_found", orgName: null, email: null, role: null };
    if (!token || token.length < 16) return notFound;

    const [row] = await db()
      .select({
        email: invitations.email,
        role: invitations.role,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        expiresAt: invitations.expiresAt,
        orgName: organizations.name,
      })
      .from(invitations)
      .innerJoin(organizations, eq(invitations.orgId, organizations.id))
      .where(eq(invitations.token, token))
      .limit(1);
    if (!row) return notFound;

    const base = { orgName: row.orgName, email: row.email, role: row.role as MemberRole };
    if (row.acceptedAt) return { status: "accepted", ...base };
    if (row.revokedAt) return { status: "revoked", ...base };
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      return { status: "expired", ...base };
    }
    return { status: "valid", ...base };
  }

  /**
   * Accept an invite as the authenticated caller. Verifies the caller's email
   * matches the invited address, then adds (or confirms) their membership in the
   * inviting org. Returns the org id to switch into, or throws a typed error.
   */
  async acceptInvite(ctx: AuthContext, token: string, now: Date = new Date()): Promise<{ orgId: string }> {
    if (!token || token.length < 16) throw new InputError("Invalid invitation link.");

    const [invite] = await db()
      .select()
      .from(invitations)
      .where(eq(invitations.token, token))
      .limit(1);
    if (!invite) throw new InputError("This invitation no longer exists.");
    if (invite.acceptedAt) throw new InputError("This invitation has already been accepted.");
    if (invite.revokedAt) throw new InputError("This invitation has been revoked.");
    if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
      throw new InputError("This invitation has expired.");
    }

    // The link is bound to the invited email — a leaked link can't be redeemed by another user.
    const [me] = await db()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    if (!me || me.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
      throw new ForbiddenError(`This invitation was sent to ${invite.email}. Sign in with that account to accept.`);
    }

    await db().transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.orgId, invite.orgId), eq(memberships.userId, ctx.userId)))
        .limit(1);
      if (!existing) {
        await tx
          .insert(memberships)
          .values({ orgId: invite.orgId, userId: ctx.userId, role: invite.role });
      }
      await tx
        .update(invitations)
        .set({ acceptedAt: now, acceptedBy: ctx.userId })
        .where(eq(invitations.id, invite.id));
    });

    void logAudit({
      orgId: invite.orgId,
      actorUserId: ctx.userId,
      action: "member.join",
      entityType: "invitation",
      entityId: invite.id,
      metadata: { role: invite.role },
    });

    return { orgId: invite.orgId };
  }
}

let store: MemberStore | null = null;
export function getMemberStore(): MemberStore {
  if (!store) store = new MemberStore();
  return store;
}
