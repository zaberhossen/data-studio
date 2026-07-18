import { SessionProvider } from "next-auth/react";

/**
 * Standalone layout for the invite-accept page. It sits OUTSIDE the (app) shell
 * (an invitee may be signed out) but still needs `useSession()`, so it wraps the
 * page in a bare SessionProvider that fetches the session client-side — null
 * when signed out, populated when signed in.
 */
export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
