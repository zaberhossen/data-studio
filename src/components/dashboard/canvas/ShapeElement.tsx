"use client";

/**
 * ShapeElement — a filled rectangle or ellipse with an optional stroke. Fills
 * default to a categorical viz token so decoration stays on-palette.
 */

import * as React from "react";
import type { ShapeContent } from "@/lib/types/dashboard";

export function ShapeElement({ content }: { content: ShapeContent }) {
  const width = content.strokeWidth ?? 2;
  const style: React.CSSProperties = {
    background: content.fill ?? "var(--viz-1)",
    border: content.stroke ? `${width}px solid ${content.stroke}` : undefined,
    borderRadius: content.shape === "ellipse" ? "50%" : (content.radius ?? 8),
    opacity: content.opacity ?? 1,
    boxShadow: content.shadow ? "0 4px 12px rgba(0,0,0,0.18)" : undefined,
  };
  return <div className="h-full w-full" style={style} />;
}
