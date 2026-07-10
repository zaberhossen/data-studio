/**
 * /embed/[token] — the chrome-less, iframe-able share view (unauthenticated).
 *
 * Same frozen snapshot as `/public/[token]`, but with no header — meant to be
 * embedded in another site. `frame-ancestors` (set in next.config) permits the
 * iframe here while every other route keeps `X-Frame-Options: DENY`.
 */

import { PublicDashboardView } from "@/components/dashboard/PublicDashboardView";

export const dynamic = "force-dynamic";

export default async function EmbedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicDashboardView token={token} embed />;
}
