"use client";

/**
 * LineElement — a horizontal rule centered in its box; rotate the element (via
 * Moveable) to make it diagonal or vertical. Supports solid/dashed/dotted
 * strokes (native CSS border styles) and optional arrowheads at either end
 * (CSS triangles). Stroke defaults to a recessive chrome token.
 */

import * as React from "react";
import type { LineContent } from "@/lib/types/dashboard";

export function LineElement({ content }: { content: LineContent }) {
  const width = content.strokeWidth ?? 2;
  const color = content.stroke ?? "var(--viz-axis)";
  const dash = content.dash ?? "solid";
  // Arrowhead size scales with the stroke; keep it readable at thin widths.
  const arrow = Math.max(6, width * 2.5);

  const triangle = (dir: "left" | "right"): React.CSSProperties => ({
    width: 0,
    height: 0,
    borderTop: `${arrow}px solid transparent`,
    borderBottom: `${arrow}px solid transparent`,
    [dir === "right" ? "borderLeft" : "borderRight"]: `${arrow * 1.4}px solid ${color}`,
  });

  return (
    <div className="flex h-full w-full items-center">
      {content.startArrow && <div style={triangle("left")} />}
      <div
        className="flex-1"
        style={{
          height: 0,
          borderTop: `${width}px ${dash} ${color}`,
        }}
      />
      {content.endArrow && <div style={triangle("right")} />}
    </div>
  );
}
