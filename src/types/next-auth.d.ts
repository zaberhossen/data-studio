/**
 * Module augmentation: attach the active org + role to the session and JWT so
 * `auth()` and `requireAuthContext()` can read them without another DB round-trip.
 */

import type { DefaultSession } from "next-auth";
import type { MemberRole } from "@/lib/db/scope";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      orgId: string | null;
      role: MemberRole | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    orgId: string | null;
    role: MemberRole | null;
  }
}
