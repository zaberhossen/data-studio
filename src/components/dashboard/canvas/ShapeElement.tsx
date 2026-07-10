"use client";

/**
 * ShapeElement — a filled rectangle or ellipse with an optional stroke. Fills
 * default to a categorical viz token so decoration stays on-palette.
 */

import * as React from "react";
import type { ShapeContent } from "@/lib/types/dashboard";

export function ShapeElement({ content }: { content: ShapeContent }) {
  const style: React.CSSProperties = {
    background: content.fill ?? "var(--viz-1)",
    border: content.stroke ? `2px solid ${content.stroke}` : undefined,
    borderRadius: content.shape === "ellipse" ? "50%" : 8,
  };
  return <div className="h-full w-full" style={style} />;
}
