/**
 * Public route-group layout — for share/embed pages reachable WITHOUT auth.
 *
 * Deliberately carries NO SessionProvider / analytics engine / app chrome: a
 * public viewer is unauthenticated and renders a frozen snapshot only. The root
 * layout still supplies <html>/<body>, fonts, and the theme script.
 */

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
