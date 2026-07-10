"use client";

/**
 * LineElement — a horizontal rule centered in its box; rotate the element (via
 * Moveable) to make it diagonal or vertical. Stroke defaults to a recessive
 * chrome token.
 */

import * as React from "react";
import type { LineContent } from "@/lib/types/dashboard";

export function LineElement({ content }: { content: LineContent }) {
  return (
    <div className="flex h-full w-full items-center">
      <div
        style={{
          width: "100%",
          height: content.strokeWidth ?? 2,
          background: content.stroke ?? "var(--viz-axis)",
          borderRadius: 999,
        }}
      />
    </div>
  );
}
