"use server";

/**
 * Server actions for the Credentials auth flow.
 *
 * `signup` provisions a brand-new tenant: it creates the user, an organization,
 * and an `owner` membership in a single transaction, then signs the user in. All
 * three succeed or none do — a half-created user with no org can never sign in
 * (there'd be no active org, and `requireAuthContext` would reject them).
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memberships, organizations, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { signIn } from "@/auth";

export interface SignupState {
  error: string | null;
}

const MIN_PASSWORD = 8;

export async function signup(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const orgName =
    String(formData.get("org") ?? "").trim() ||
    `${name || email.split("@")[0] || "My"} workspace`;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < MIN_PASSWORD) {
    return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }

  const existing = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing[0]) {
    return { error: "An account with this email already exists." };
  }

  const passwordHash = await hashPassword(password);
  const slug = await uniqueSlug(orgName);

  try {
    await db().transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ name: name || null, email, passwordHash })
        .returning({ id: users.id });

      const [org] = await tx
        .insert(organizations)
        .values({ name: orgName, slug })
        .returning({ id: organizations.id });

      await tx
        .insert(memberships)
        .values({ orgId: org.id, userId: user.id, role: "owner" });
    });
  } catch {
    return { error: "Could not create your account. Please try again." };
  }

  // Throws a redirect (NEXT_REDIRECT) on success — sends the user to the app.
  await signIn("credentials", { email, password, redirectTo: "/" });
  return { error: null };
}

/** A URL-safe, unique org slug derived from the org name. */
async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const clash = await db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.slug} = ${candidate}`)
      .limit(1);
    if (!clash[0]) return candidate;
  }
  // Extremely unlikely fall-through: force uniqueness.
  return `${base}-${randomSuffix()}${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
