"use client";

/**
 * CanvasPresent — a full-screen, frame-by-frame presentation of a canvas
 * dashboard (Figma "present" / slideshow). Each frame becomes a slide, scaled to
 * fit the screen; ←/→ (or Space) step, Esc exits. When the dashboard has no
 * frames the whole canvas is shown as a single slide.
 *
 * Rendering reuses `CanvasStage` in VIEW mode (no Moveable/Selecto), so widgets
 * stay live (scheduler-backed) — we only wrap it in a fit-to-frame transform.
 * It renders inside the dashboard tree, so the filter context flows through.
 */

import * as React from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { CanvasConfig, CanvasElement, CanvasFrame, Widget } from "@/lib/types/dashboard";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { CanvasStage } from "./CanvasStage";

interface Slide {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

interface Props {
  widgets: Widget[];
  elements: CanvasElement[];
  frames: CanvasFrame[];
  canvas: CanvasConfig;
  scheduler: QueryScheduler;
  onClose: () => void;
}

const NOOP = () => {};
/** Screen padding + reserved control-bar height when fitting a slide. */
const PAD = 48;
const CONTROLS_H = 64;

export function CanvasPresent({ widgets, elements, frames, canvas, scheduler, onClose }: Props) {
  const slides = React.useMemo<Slide[]>(() => {
    const visible = frames.filter((f) => !f.hidden);
    if (visible.length === 0) {
      return [{ x: 0, y: 0, w: canvas.width, h: canvas.height, name: "Canvas" }];
    }
    // Present in reading order: top-to-bottom, then left-to-right.
    return [...visible]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, name: f.name }));
  }, [frames, canvas.width, canvas.height]);

  const [index, setIndex] = React.useState(0);
  const [fit, setFit] = React.useState({ scale: 1, tx: 0, ty: 0 });

  const clampedIndex = Math.min(index, slides.length - 1);
  const slide = slides[clampedIndex];

  const next = React.useCallback(() => setIndex((i) => Math.min(i + 1, slides.length - 1)), [slides.length]);
  const prev = React.useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // Fit the active slide to the viewport (recomputed on slide change + resize).
  React.useEffect(() => {
    const recompute = () => {
      const availW = window.innerWidth - PAD * 2;
      const availH = window.innerHeight - PAD * 2 - CONTROLS_H;
      const scale = Math.max(0.05, Math.min(availW / slide.w, availH / slide.h));
      const tx = (window.innerWidth - slide.w * scale) / 2 - slide.x * scale;
      const ty = (window.innerHeight - CONTROLS_H - slide.h * scale) / 2 - slide.y * scale;
      setFit({ scale, tx, ty });
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [slide]);

  // Keyboard navigation.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/95">
      {/* The fit-to-slide stage. pointer-events pass through to live widgets. */}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${fit.tx}px, ${fit.ty}px) scale(${fit.scale})` }}
      >
        <CanvasStage
          widgets={widgets}
          elements={elements}
          frames={frames}
          canvas={canvas}
          scheduler={scheduler}
          editable={false}
          selectedIds={EMPTY}
          onSelectedIdsChange={NOOP}
          onCommit={NOOP}
          onEditWidget={NOOP}
          onDuplicateWidget={NOOP}
          onRemoveWidget={NOOP}
          onUpdateElementContent={NOOP}
        />
      </div>

      {/* Control bar */}
      <div className="absolute inset-x-0 bottom-0 flex h-16 items-center justify-center gap-3 bg-gradient-to-t from-black/70 to-transparent text-white">
        <button
          type="button"
          className="rounded-full p-2 hover:bg-white/10 disabled:opacity-30"
          onClick={prev}
          disabled={clampedIndex === 0}
          aria-label="Previous slide"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="min-w-[8rem] text-center text-sm">
          <span className="font-medium">{slide.name}</span>
          <span className="ml-2 text-white/60">
            {clampedIndex + 1} / {slides.length}
          </span>
        </span>
        <button
          type="button"
          className="rounded-full p-2 hover:bg-white/10 disabled:opacity-30"
          onClick={next}
          disabled={clampedIndex === slides.length - 1}
          aria-label="Next slide"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
        aria-label="Exit presentation (Esc)"
        title="Exit presentation (Esc)"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

const EMPTY: string[] = [];
