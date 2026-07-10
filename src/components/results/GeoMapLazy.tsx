"use client";

/**
 * GeoMapLazy — code-splits the choropleth (react-simple-maps + ~200KB of
 * topojson) so it only loads when a `map` widget renders. Client-only (the map
 * lib touches the DOM), with a light loading fallback.
 */

import dynamic from "next/dynamic";

export const GeoMapLazy = dynamic(
  () => import("./GeoMap").then((m) => m.GeoMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading map…
      </div>
    ),
  },
);
