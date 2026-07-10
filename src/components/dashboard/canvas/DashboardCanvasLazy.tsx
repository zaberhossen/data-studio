"use client";

/**
 * DashboardCanvasLazy — code-splits the canvas editor (react-moveable +
 * react-selecto are client-only and heavy). `ssr: false` keeps them out of the
 * server render entirely; the grid path is unaffected.
 */

import dynamic from "next/dynamic";

export const DashboardCanvasLazy = dynamic(
  () => import("./DashboardCanvas").then((m) => m.DashboardCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading canvas…
      </div>
    ),
  },
);
