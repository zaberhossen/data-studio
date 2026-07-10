/**
 * Route protection. Runs the edge-safe `authConfig` (no DB, no Node providers)
 * and defers the allow/deny decision to its `authorized` callback. The matcher
 * skips Next internals, static assets, and the auth API so those never pay the
 * middleware cost; public share/embed pages are allowed by the callback.
 */

import NextAuth from "next-auth";
import authConfig from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export default middleware(() => {
  // Allow/deny is decided by authConfig.callbacks.authorized; returning nothing
  // lets the request proceed when authorized returns true.
  return;
});

export const config = {
  // Gate PAGES only. All /api routes self-authenticate via `resolveAuth`, so they
  // return JSON 401s instead of HTML login redirects. Also skip Next internals
  // and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"],
};
