/**
 * /public/[token] — the full-page public share view (unauthenticated). Renders
 * the frozen snapshot for a share token; the client component does the fetch.
 */

import { PublicDashboardView } from "@/components/dashboard/PublicDashboardView";

export const dynamic = "force-dynamic";

export default async function PublicSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicDashboardView token={token} />;
}
