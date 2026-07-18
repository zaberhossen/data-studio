"use client";

/**
 * CanvasViewport — the pan/zoom camera around the canvas stage.
 *
 * Figma-style navigation:
 *   • wheel / trackpad scroll  → pan
 *   • ⌘/Ctrl + wheel (pinch)   → zoom to the cursor
 *   • Space-drag or middle-mouse drag → pan
 *   • bottom-right cluster     → −  %  +  and Fit
 *
 * PERFORMANCE CONTRACT: the camera lives in a ref and is applied straight to
 * the inner element's CSS transform — panning/zooming causes ZERO React
 * re-renders (the % readout is written via textContent). react-moveable
 * computes gesture deltas through the ancestor transform matrix, so item
 * drag/resize keeps working at any zoom.
 */

import * as React from "react";
import { Maximize, Minus, Plus } from "lucide-react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const FIT_PADDING = 48;
/** Thickness of each ruler strip (px). */
const RULER_SIZE = 22;

interface CanvasViewportProps {
  /** Logical size of the content being framed (the stage). */
  contentWidth: number;
  contentHeight: number;
  /** Draw measurement rulers along the top/left edges, synced to the camera. */
  showRulers?: boolean;
  children: React.ReactNode;
}

/** A "nice" ruler step (logical units) that renders ~50–90px apart on screen. */
function niceStep(scale: number): number {
  const raw = 70 / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow * scale >= 45) return m * pow;
  }
  return 10 * pow;
}

export function CanvasViewport({
  contentWidth,
  contentHeight,
  showRulers = false,
  children,
}: CanvasViewportProps) {
  const outerRef = React.useRef<HTMLDivElement>(null);
  const innerRef = React.useRef<HTMLDivElement>(null);
  const labelRef = React.useRef<HTMLSpanElement>(null);
  const hRulerRef = React.useRef<HTMLCanvasElement>(null);
  const vRulerRef = React.useRef<HTMLCanvasElement>(null);
  const view = React.useRef({ x: 0, y: 0, scale: 1 });
  const spaceDown = React.useRef(false);
  const pan = React.useRef<{ pointerId: number; startX: number; startY: number; ox: number; oy: number } | null>(null);

  // Rulers are redrawn imperatively from `apply()` (via this ref) so panning /
  // zooming never triggers a React render — preserving the camera perf contract.
  const drawRulers = React.useRef<() => void>(() => {});

  const apply = React.useCallback(() => {
    const v = view.current;
    if (innerRef.current) {
      innerRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    }
    if (labelRef.current) {
      labelRef.current.textContent = `${Math.round(v.scale * 100)}%`;
    }
    drawRulers.current();
  }, []);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  /** Zoom so the viewport point (cx, cy) stays fixed under the cursor. */
  const zoomAt = React.useCallback(
    (cx: number, cy: number, factor: number) => {
      const v = view.current;
      const next = clampScale(v.scale * factor);
      if (next === v.scale) return;
      v.x = cx - ((cx - v.x) / v.scale) * next;
      v.y = cy - ((cy - v.y) / v.scale) * next;
      v.scale = next;
      apply();
    },
    [apply],
  );

  const zoomCentered = React.useCallback(
    (factor: number) => {
      const rect = outerRef.current?.getBoundingClientRect();
      if (!rect) return;
      zoomAt(rect.width / 2, rect.height / 2, factor);
    },
    [zoomAt],
  );

  const fit = React.useCallback(() => {
    const rect = outerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const v = view.current;
    v.scale = clampScale(
      Math.min(
        (rect.width - FIT_PADDING) / contentWidth,
        (rect.height - FIT_PADDING) / contentHeight,
        1,
      ),
    );
    v.x = (rect.width - contentWidth * v.scale) / 2;
    v.y = Math.max((rect.height - contentHeight * v.scale) / 2, FIT_PADDING / 2);
    apply();
  }, [contentWidth, contentHeight, apply]);

  // Initial camera: content centered horizontally at 100%.
  React.useEffect(() => {
    const rect = outerRef.current?.getBoundingClientRect();
    if (!rect) return;
    view.current.x = Math.max((rect.width - contentWidth) / 2, FIT_PADDING / 2);
    view.current.y = FIT_PADDING / 2;
    apply();
    // Run once — later content growth must not yank the user's camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wheel: pan, or zoom-to-cursor with ⌘/Ctrl (pinch arrives as ctrl+wheel).
  React.useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = outer.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.01));
      } else {
        view.current.x -= e.deltaX;
        view.current.y -= e.deltaY;
        apply();
      }
    };
    outer.addEventListener("wheel", onWheel, { passive: false });
    return () => outer.removeEventListener("wheel", onWheel);
  }, [zoomAt, apply]);

  // Space key arms hand-pan (ignored while typing in a field).
  React.useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        spaceDown.current = true;
        if (outerRef.current) outerRef.current.style.cursor = "grab";
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
        if (outerRef.current && !pan.current) outerRef.current.style.cursor = "";
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Rulers: size the two <canvas> strips to the viewport (DPR-aware) and paint
  // ticks in canvas-logical units mapped through the current camera. Re-armed
  // whenever `showRulers` toggles; the paint itself runs from `apply()`.
  React.useEffect(() => {
    if (!showRulers) {
      drawRulers.current = () => {};
      return;
    }
    const outer = outerRef.current;
    if (!outer) return;

    const css = getComputedStyle(outer);
    const ink = css.getPropertyValue("--muted-foreground").trim();
    const face = css.getPropertyValue("--muted").trim();
    const edge = css.getPropertyValue("--border").trim();
    const tickColor = ink ? `hsl(${ink})` : "#94a3b8";
    const faceColor = face ? `hsl(${face})` : "#f1f5f9";
    const edgeColor = edge ? `hsl(${edge})` : "#e2e8f0";

    const draw = () => {
      const rect = outer.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const v = view.current;
      const step = niceStep(v.scale);

      // horizontal (top) ruler — spans [RULER_SIZE .. width]; internal x=0 ↔ outer x=RULER_SIZE
      const hc = hRulerRef.current;
      const wLen = Math.max(0, rect.width - RULER_SIZE);
      if (hc) {
        hc.width = Math.round(wLen * dpr);
        hc.height = Math.round(RULER_SIZE * dpr);
        const ctx = hc.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, wLen, RULER_SIZE);
          ctx.fillStyle = faceColor;
          ctx.fillRect(0, 0, wLen, RULER_SIZE);
          ctx.strokeStyle = edgeColor;
          ctx.beginPath();
          ctx.moveTo(0, RULER_SIZE - 0.5);
          ctx.lineTo(wLen, RULER_SIZE - 0.5);
          ctx.stroke();
          ctx.fillStyle = tickColor;
          ctx.strokeStyle = tickColor;
          ctx.font = "9px ui-monospace, monospace";
          ctx.textBaseline = "top";
          // First visible logical tick (outer x=RULER_SIZE ⇒ internal x=0)
          const startC = Math.ceil((RULER_SIZE - v.x) / v.scale / step) * step;
          ctx.beginPath();
          for (let c = startC; ; c += step) {
            const ix = v.x + c * v.scale - RULER_SIZE;
            if (ix > wLen) break;
            if (ix < 0) continue;
            ctx.moveTo(ix + 0.5, RULER_SIZE - 6);
            ctx.lineTo(ix + 0.5, RULER_SIZE);
            ctx.fillText(String(Math.round(c)), ix + 2, 2);
          }
          ctx.stroke();
        }
      }

      // vertical (left) ruler — spans [RULER_SIZE .. height]; internal y=0 ↔ outer y=RULER_SIZE
      const vc = vRulerRef.current;
      const hLen = Math.max(0, rect.height - RULER_SIZE);
      if (vc) {
        vc.width = Math.round(RULER_SIZE * dpr);
        vc.height = Math.round(hLen * dpr);
        const ctx = vc.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, RULER_SIZE, hLen);
          ctx.fillStyle = faceColor;
          ctx.fillRect(0, 0, RULER_SIZE, hLen);
          ctx.strokeStyle = edgeColor;
          ctx.beginPath();
          ctx.moveTo(RULER_SIZE - 0.5, 0);
          ctx.lineTo(RULER_SIZE - 0.5, hLen);
          ctx.stroke();
          ctx.fillStyle = tickColor;
          ctx.strokeStyle = tickColor;
          ctx.font = "9px ui-monospace, monospace";
          ctx.textBaseline = "top";
          const startC = Math.ceil((RULER_SIZE - v.y) / v.scale / step) * step;
          ctx.beginPath();
          for (let c = startC; ; c += step) {
            const iy = v.y + c * v.scale - RULER_SIZE;
            if (iy > hLen) break;
            if (iy < 0) continue;
            ctx.moveTo(RULER_SIZE - 6, iy + 0.5);
            ctx.lineTo(RULER_SIZE, iy + 0.5);
            // Labels rotated to read along the vertical axis.
            ctx.save();
            ctx.translate(2, iy + 2);
            ctx.rotate(Math.PI / 2);
            ctx.fillText(String(Math.round(c)), 0, -RULER_SIZE + 2);
            ctx.restore();
          }
          ctx.stroke();
        }
      }
    };

    drawRulers.current = draw;
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(outer);
    return () => {
      ro.disconnect();
      drawRulers.current = () => {};
    };
  }, [showRulers]);

  // Space-drag / middle-mouse pan. Capture phase so Selecto never sees it.
  React.useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const onPointerDown = (e: PointerEvent) => {
      const wantsPan = e.button === 1 || (e.button === 0 && spaceDown.current);
      if (!wantsPan) return;
      e.preventDefault();
      e.stopPropagation();
      outer.setPointerCapture(e.pointerId);
      pan.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        ox: view.current.x,
        oy: view.current.y,
      };
      outer.style.cursor = "grabbing";
    };
    const onPointerMove = (e: PointerEvent) => {
      const p = pan.current;
      if (!p || e.pointerId !== p.pointerId) return;
      view.current.x = p.ox + (e.clientX - p.startX);
      view.current.y = p.oy + (e.clientY - p.startY);
      apply();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pan.current?.pointerId !== e.pointerId) return;
      pan.current = null;
      outer.style.cursor = spaceDown.current ? "grab" : "";
    };

    outer.addEventListener("pointerdown", onPointerDown, { capture: true });
    outer.addEventListener("pointermove", onPointerMove);
    outer.addEventListener("pointerup", onPointerUp);
    outer.addEventListener("pointercancel", onPointerUp);
    return () => {
      outer.removeEventListener("pointerdown", onPointerDown, { capture: true });
      outer.removeEventListener("pointermove", onPointerMove);
      outer.removeEventListener("pointerup", onPointerUp);
      outer.removeEventListener("pointercancel", onPointerUp);
    };
  }, [apply]);

  return (
    <div ref={outerRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface-100/50">
      <div
        ref={innerRef}
        style={{ width: contentWidth, transformOrigin: "0 0", willChange: "transform" }}
      >
        {children}
      </div>

      {/* Rulers (edit-mode helper): float over the top/left edges, camera-synced */}
      {showRulers && (
        <>
          <canvas
            ref={hRulerRef}
            className="pointer-events-none absolute top-0 z-10"
            style={{ left: RULER_SIZE, height: RULER_SIZE, right: 0 }}
          />
          <canvas
            ref={vRulerRef}
            className="pointer-events-none absolute left-0 z-10"
            style={{ top: RULER_SIZE, width: RULER_SIZE, bottom: 0 }}
          />
          <div
            className="pointer-events-none absolute left-0 top-0 z-10 border-b border-r border-border bg-muted"
            style={{ width: RULER_SIZE, height: RULER_SIZE }}
          />
        </>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm">
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomCentered(1 / 1.25)}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span
          ref={labelRef}
          className="min-w-[3rem] text-center font-mono text-xs text-muted-foreground"
        >
          100%
        </span>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomCentered(1.25)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Fit to view"
          title="Fit to view"
          onClick={fit}
        >
          <Maximize className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
