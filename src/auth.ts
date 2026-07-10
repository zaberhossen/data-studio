/**
 * Full Auth.js config (Node runtime).
 *
 * Extends the edge-safe `authConfig` with the Credentials provider (email +
 * password against our `users` table) and DB-backed JWT/session callbacks that
 * carry the active org + role. Sessions use the JWT strategy — required because
 * the Credentials provider cannot persist database sessions in Auth.js. OAuth +
 * the Drizzle adapter + database sessions can be layered on in a later milestone.
 *
 * SERVER-ONLY (imports the DB pool + node:crypto password helpers).
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memberships, users } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import type { MemberRole } from "@/lib/db/scope";
import authConfig from "@/auth.config";

/** Resolve a user's default (first) org membership → { orgId, role }. */
async function defaultMembership(
  userId: string,
): Promise<{ orgId: string; role: MemberRole } | null> {
  const rows = await db()
    .select({ orgId: memberships.orgId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const email = typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : "";
        const password = typeof raw?.password === "string" ? raw.password : "";
        if (!email || !password) return null;

        const rows = await db()
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1);
        const user = rows[0];
        if (!user?.passwordHash) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        return { id: user.id, name: user.name, email: user.email, image: user.image };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger, session }) {
      const t = token as typeof token & {
        id?: string;
        orgId?: string | null;
        role?: MemberRole | null;
      };
      // On sign-in, stamp the user id + resolve the active org/role.
      if (user?.id) {
        t.id = user.id;
        const m = await defaultMembership(user.id);
        t.orgId = m?.orgId ?? null;
        t.role = m?.role ?? null;
      }
      // Allow an explicit org switch via session update (multi-org users).
      if (trigger === "update" && session && typeof session === "object") {
        const nextOrg = (session as { orgId?: string }).orgId;
        if (nextOrg && t.id) {
          const rows = await db()
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.userId, t.id), eq(memberships.orgId, nextOrg)))
            .limit(1);
          if (rows[0]) {
            t.orgId = nextOrg;
            t.role = rows[0].role;
          }
        }
      }
      return t;
    },
    async session({ session, token }) {
      const t = token as {
        id?: string;
        orgId?: string | null;
        role?: MemberRole | null;
      };
      if (session.user) {
        session.user.id = t.id ?? "";
        session.user.orgId = t.orgId ?? null;
        session.user.role = t.role ?? null;
      }
      return session;
    },
  },
});
