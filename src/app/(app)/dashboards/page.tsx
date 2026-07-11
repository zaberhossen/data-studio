"use client";

/** Dashboards route (`/dashboards`). */

import { DashboardPanel } from "@/components/dashboard/DashboardPanel";
import { useEngine, useSources } from "@/app/(app)/WorkspaceProvider";

export default function DashboardsPage() {
  const engine = useEngine();
  const sources = useSources();
  return <DashboardPanel engine={engine} sources={sources} />;
}
