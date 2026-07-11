"use client";

/**
 * Home route (`/`) — the project/workspace overview. The engine, sources, and
 * query workspace now live in the (app) layout's WorkspaceProvider, so this page
 * is a thin consumer that renders the overview surface.
 */

import { HomeView } from "@/components/home/HomeView";

export default function HomePage() {
  return <HomeView />;
}
