/**
 * Edge-safe Auth.js config.
 *
 * This half carries NO database access and NO Node-only providers, so it can run
 * in the middleware (edge) runtime. The middleware uses the `authorized` callback
 * here to gate routes; the full config (`src/auth.ts`) adds the Credentials
 * provider + DB-backed callbacks for the Node runtime.
 */

import type { NextAuthConfig } from "next-auth";

/** Path prefixes reachable WITHOUT authentication. */
const PUBLIC_PREFIXES = ["/login", "/signup", "/public", "/embed"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export const authConfig = {
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [], // Credentials is added in the Node-only src/auth.ts
  callbacks: {
    /**
     * Route gate for the middleware. Return true to allow, false to bounce to
     * the sign-in page, or a Response to redirect explicitly.
     */
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = Boolean(auth?.user);
      const { pathname } = nextUrl;

      // Note: /api/* is excluded by the middleware matcher (those routes
      // self-authenticate), so we only decide page navigations here.
      const onAuthPage = pathname === "/login" || pathname === "/signup";
      if (onAuthPage) {
        // Signed-in users have no business on login/signup — send them home.
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }

      if (isPublicPath(pathname)) return true;

      // Everything else requires a session.
      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
