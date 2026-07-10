"use client";

/**
 * ResizableSplit — a two-pane split with a draggable divider. Supports vertical
 * (stacked: `first` on top, `second` below) and horizontal (side-by-side)
 * orientation. The first pane's size is a percentage held in local state and
 * clamped to [min, 100-min].
 *
 * Kept dependency-free (no react-resizable-panels) — a single pointer handler
 * drives the divider, which is enough for the editor/results split.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

interface ResizableSplitProps {
  orientation?: "vertical" | "horizontal";
  first: React.ReactNode;
  second: React.ReactNode;
  /** Initial size of the first pane, in percent. */
  defaultSize?: number;
  /** Minimum size of either pane, in percent. */
  minSize?: number;
  className?: string;
}

export function ResizableSplit({
  orientation = "vertical",
  first,
  second,
  defaultSize = 55,
  minSize = 15,
  className,
}: ResizableSplitProps) {
  const isVertical = orientation === "vertical";
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState(defaultSize);
  const [dragging, setDragging] = React.useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = isVertical
      ? ((e.clientY - rect.top) / rect.height) * 100
      : ((e.clientX - rect.left) / rect.width) * 100;
    setSize(Math.min(100 - minSize, Math.max(minSize, pct)));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 min-w-0",
        isVertical ? "flex-col" : "flex-row",
        className,
      )}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={isVertical ? { height: `${size}%` } : { width: `${size}%` }}
      >
        {first}
      </div>

      <div
        role="separator"
        aria-orientation={isVertical ? "horizontal" : "vertical"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          "group relative shrink-0 bg-border transition-colors hover:bg-brand/60",
          isVertical ? "h-px w-full cursor-row-resize" : "h-full w-px cursor-col-resize",
          dragging && "bg-brand",
        )}
      >
        {/* Larger invisible hit area for easier grabbing. */}
        <span
          className={cn(
            "absolute",
            isVertical
              ? "inset-x-0 -top-1.5 h-3.5"
              : "inset-y-0 -left-1.5 w-3.5",
          )}
        />
      </div>

      <div
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        style={isVertical ? undefined : undefined}
      >
        {second}
      </div>
    </div>
  );
}
