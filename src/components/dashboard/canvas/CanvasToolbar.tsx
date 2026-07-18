"use client";

/**
 * CanvasToolbar — the edit-mode strip above the canvas. Adds elements
 * (text/image/shape/line), exposes align + distribute for multi-selections, and
 * z-order + delete; when a SINGLE element is selected it also shows that
 * element's own controls (typography / image URL+fit / shape+fill+stroke /
 * line stroke+width).
 */

import * as React from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowLeft,
  ArrowRight,
  Bold,
  BringToFront,
  Frame,
  Group,
  Image as ImageIcon,
  Italic,
  Layers,
  Minus,
  Play,
  Ruler,
  SendToBack,
  Settings2,
  Square,
  Trash2,
  Type,
  Ungroup,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AlignEdge, DistributeAxis } from "@/lib/dashboard/align";
import type { CanvasConfig, CanvasElement, ElementContent } from "@/lib/types/dashboard";
import { DEFAULT_GRID_SIZE } from "@/lib/types/dashboard";

interface Props {
  selectionCount: number;
  /** The sole selected element (any kind), or null when 0 or ≥ 2 are selected. */
  element: CanvasElement | null;
  onAdd: (kind: CanvasElement["kind"]) => void;
  /** Add a named artboard (frame). */
  onAddFrame?: () => void;
  onUpdateContent: (content: ElementContent) => void;
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: DistributeAxis) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
  /** Whether the current selection can be grouped (≥2 non-frame items). */
  canGroup?: boolean;
  /** Whether the current selection contains a persisted group. */
  canUngroup?: boolean;
  onGroup?: () => void;
  onUngroup?: () => void;
  /** Current canvas surface config (size/background/grid/rulers). */
  canvas?: CanvasConfig;
  /** Patch the canvas surface config. */
  onUpdateCanvas?: (patch: Partial<Omit<CanvasConfig, "frames">>) => void;
  /** Enter full-screen frame-by-frame presentation. */
  onPresent?: () => void;
  /** Layers panel toggle (right sidebar). */
  layersOpen?: boolean;
  onToggleLayers?: () => void;
}

const HEX_FALLBACK = "#6366f1";
const hexOr = (c: string | undefined, fallback: string) =>
  c && c.startsWith("#") ? c : fallback;

export function CanvasToolbar({
  selectionCount,
  element,
  onAdd,
  onAddFrame,
  onUpdateContent,
  onAlign,
  onDistribute,
  onBringToFront,
  onSendToBack,
  onDelete,
  canGroup,
  canUngroup,
  onGroup,
  onUngroup,
  canvas,
  onUpdateCanvas,
  onPresent,
  layersOpen,
  onToggleLayers,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
      {/* Add elements */}
      {onAddFrame && (
        <AddButton icon={<Frame className="h-3.5 w-3.5" />} label="Frame" onClick={onAddFrame} />
      )}
      <AddButton icon={<Type className="h-3.5 w-3.5" />} label="Text" onClick={() => onAdd("text")} />
      <AddButton icon={<ImageIcon className="h-3.5 w-3.5" />} label="Image" onClick={() => onAdd("image")} />
      <AddButton icon={<Square className="h-3.5 w-3.5" />} label="Shape" onClick={() => onAdd("shape")} />
      <AddButton icon={<Minus className="h-3.5 w-3.5" />} label="Line" onClick={() => onAdd("line")} />

      {element ? (
        <>
          <Divider />
          <ElementControls content={element.content} onUpdateContent={onUpdateContent} />
        </>
      ) : null}

      {/* Align + distribute (multi-selection) */}
      {selectionCount >= 2 ? (
        <>
          <Divider />
          <div className="inline-flex rounded-md border border-border bg-background p-0.5">
            <IconBtn label="Align left" onClick={() => onAlign("left")}><AlignStartVertical className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn label="Align center" onClick={() => onAlign("hcenter")}><AlignCenterVertical className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn label="Align right" onClick={() => onAlign("right")}><AlignEndVertical className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn label="Align top" onClick={() => onAlign("top")}><AlignStartHorizontal className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn label="Align middle" onClick={() => onAlign("vmiddle")}><AlignCenterHorizontal className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn label="Align bottom" onClick={() => onAlign("bottom")}><AlignEndHorizontal className="h-3.5 w-3.5" /></IconBtn>
          </div>
          <div className="inline-flex rounded-md border border-border bg-background p-0.5">
            <IconBtn label="Distribute horizontally" disabled={selectionCount < 3} onClick={() => onDistribute("h")}>
              <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Distribute vertically" disabled={selectionCount < 3} onClick={() => onDistribute("v")}>
              <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
        </>
      ) : null}

      {/* Group / ungroup */}
      {(canGroup || canUngroup) && (onGroup || onUngroup) ? (
        <>
          <Divider />
          {canGroup && onGroup && (
            <Button variant="ghost" size="sm" className="h-8" onClick={onGroup} title="Group (⌘G)">
              <Group className="h-3.5 w-3.5" />
            </Button>
          )}
          {canUngroup && onUngroup && (
            <Button variant="ghost" size="sm" className="h-8" onClick={onUngroup} title="Ungroup (⌘⇧G)">
              <Ungroup className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      ) : null}

      {/* Z-order + delete */}
      {selectionCount > 0 ? (
        <>
          <Divider />
          <Button variant="ghost" size="sm" className="h-8" onClick={onBringToFront} title="Bring to front">
            <BringToFront className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={onSendToBack} title="Send to back">
            <SendToBack className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-destructive hover:bg-destructive/10"
            onClick={onDelete}
            title="Delete selection"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <span className="ml-1 text-xs text-muted-foreground">{selectionCount} selected</span>
        </>
      ) : (
        <span className="ml-1 text-xs text-muted-foreground">
          Drag to move · handles to resize/rotate · shift-click for multi-select
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {onPresent && (
          <Button variant="ghost" size="sm" className="h-8" onClick={onPresent} title="Present (full screen)">
            <Play className="h-3.5 w-3.5" />
            Present
          </Button>
        )}
        {canvas && onUpdateCanvas && (
          <CanvasSettings canvas={canvas} onUpdateCanvas={onUpdateCanvas} />
        )}
        {onToggleLayers && (
          <Button
            variant={layersOpen ? "secondary" : "ghost"}
            size="sm"
            className="h-8"
            onClick={onToggleLayers}
            title="Toggle layers panel"
          >
            <Layers className="h-3.5 w-3.5" />
            Layers
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * CanvasSettings — a popover editing the canvas SURFACE: pixel size, background,
 * and the alignment-grid / ruler helpers. These live on `CanvasConfig` (persisted
 * in the `canvas` jsonb) and drive the stage overlay + Moveable snapping.
 */
function CanvasSettings({
  canvas,
  onUpdateCanvas,
}: {
  canvas: CanvasConfig;
  onUpdateCanvas: (patch: Partial<Omit<CanvasConfig, "frames">>) => void;
}) {
  const gridSize = canvas.gridSize ?? DEFAULT_GRID_SIZE;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8" title="Canvas settings">
          <Settings2 className="h-3.5 w-3.5" />
          Canvas
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3">
        <p className="text-xs font-semibold text-foreground">Canvas</p>

        <div className="flex items-center gap-2">
          <NumField
            label="W"
            value={canvas.width}
            min={200}
            max={10000}
            onChange={(w) => onUpdateCanvas({ width: w })}
          />
          <NumField
            label="H"
            value={canvas.height}
            min={200}
            max={10000}
            onChange={(h) => onUpdateCanvas({ height: h })}
          />
        </div>

        <label className="flex items-center justify-between text-xs text-muted-foreground">
          Background
          <ColorField
            label="Canvas background"
            value={hexOr(canvas.background, "#ffffff")}
            onChange={(v) => onUpdateCanvas({ background: v })}
          />
        </label>

        <div className="h-px bg-border" />

        <div className="flex items-center gap-1.5">
          <Ruler className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Grid &amp; guides</span>
        </div>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          Show grid
          <input
            type="checkbox"
            checked={!!canvas.showGrid}
            onChange={(e) => onUpdateCanvas({ showGrid: e.target.checked })}
            className="h-3.5 w-3.5 accent-primary"
          />
        </label>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          Snap to grid
          <input
            type="checkbox"
            checked={!!canvas.snapToGrid}
            onChange={(e) => onUpdateCanvas({ snapToGrid: e.target.checked })}
            className="h-3.5 w-3.5 accent-primary"
          />
        </label>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          Show rulers
          <input
            type="checkbox"
            checked={!!canvas.showRulers}
            onChange={(e) => onUpdateCanvas({ showRulers: e.target.checked })}
            className="h-3.5 w-3.5 accent-primary"
          />
        </label>
        <label className="flex items-center justify-between text-xs text-muted-foreground">
          Grid size
          <Input
            type="number"
            min={2}
            max={200}
            value={gridSize}
            onChange={(e) =>
              onUpdateCanvas({ gridSize: Math.max(2, Math.min(200, Number(e.target.value) || DEFAULT_GRID_SIZE)) })
            }
            className="h-8 w-16"
            aria-label="Grid size"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}

/** Per-kind controls for the single selected element. */
function ElementControls({
  content,
  onUpdateContent,
}: {
  content: ElementContent;
  onUpdateContent: (content: ElementContent) => void;
}) {
  if (content.kind === "text") {
    const c = content;
    return (
      <>
        <div className="inline-flex rounded-md border border-border bg-background p-0.5">
          <IconToggle active={c.bold} label="Bold" onClick={() => onUpdateContent({ ...c, bold: !c.bold })}>
            <Bold className="h-3.5 w-3.5" />
          </IconToggle>
          <IconToggle active={c.italic} label="Italic" onClick={() => onUpdateContent({ ...c, italic: !c.italic })}>
            <Italic className="h-3.5 w-3.5" />
          </IconToggle>
        </div>
        <div className="inline-flex rounded-md border border-border bg-background p-0.5">
          {(["left", "center", "right"] as const).map((a) => (
            <IconToggle key={a} active={(c.align ?? "left") === a} label={`Align ${a}`} onClick={() => onUpdateContent({ ...c, align: a })}>
              {a === "left" ? <AlignLeft className="h-3.5 w-3.5" /> : a === "center" ? <AlignCenter className="h-3.5 w-3.5" /> : <AlignRight className="h-3.5 w-3.5" />}
            </IconToggle>
          ))}
        </div>
        <NumField label="Size" value={c.fontSize ?? 16} min={8} max={96} onChange={(n) => onUpdateContent({ ...c, fontSize: n })} />
        <ColorField label="Text color" value={hexOr(c.color, "#111827")} onChange={(v) => onUpdateContent({ ...c, color: v })} />
        <PillToggle active={c.markdown} label="MD" title="Render as Markdown" onClick={() => onUpdateContent({ ...c, markdown: !c.markdown })} />
      </>
    );
  }
  if (content.kind === "image") {
    const c = content;
    return (
      <>
        <Input
          value={c.url}
          onChange={(e) => onUpdateContent({ ...c, url: e.target.value })}
          placeholder="https://image-url…"
          className="h-8 w-56"
          aria-label="Image URL"
        />
        <Seg value={c.fit ?? "contain"} options={[["contain", "Fit"], ["cover", "Fill"]]} onChange={(v) => onUpdateContent({ ...c, fit: v as "contain" | "cover" })} />
      </>
    );
  }
  if (content.kind === "shape") {
    const c = content;
    return (
      <>
        <Seg value={c.shape} options={[["rect", "Rectangle"], ["ellipse", "Ellipse"]]} onChange={(v) => onUpdateContent({ ...c, shape: v as "rect" | "ellipse" })} />
        <ColorField label="Fill" value={hexOr(c.fill, HEX_FALLBACK)} onChange={(v) => onUpdateContent({ ...c, fill: v })} />
        <ColorField label="Stroke" value={hexOr(c.stroke, "#000000")} onChange={(v) => onUpdateContent({ ...c, stroke: v })} />
        <NumField label="Border" value={c.strokeWidth ?? 2} min={0} max={40} onChange={(n) => onUpdateContent({ ...c, strokeWidth: n })} />
        {c.shape === "rect" && (
          <NumField label="Radius" value={c.radius ?? 8} min={0} max={200} onChange={(n) => onUpdateContent({ ...c, radius: n })} />
        )}
        <NumField
          label="Opacity %"
          value={Math.round((c.opacity ?? 1) * 100)}
          min={0}
          max={100}
          onChange={(n) => onUpdateContent({ ...c, opacity: Math.max(0, Math.min(1, n / 100)) })}
        />
        <PillToggle active={c.shadow} label="Shadow" title="Drop shadow" onClick={() => onUpdateContent({ ...c, shadow: !c.shadow })} />
      </>
    );
  }
  // line
  const c = content;
  return (
    <>
      <ColorField label="Stroke" value={hexOr(c.stroke, "#111827")} onChange={(v) => onUpdateContent({ ...c, stroke: v })} />
      <NumField label="Width" value={c.strokeWidth ?? 2} min={1} max={40} onChange={(n) => onUpdateContent({ ...c, strokeWidth: n })} />
      <Seg
        value={c.dash ?? "solid"}
        options={[["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]]}
        onChange={(v) => onUpdateContent({ ...c, dash: v as "solid" | "dashed" | "dotted" })}
      />
      <div className="inline-flex rounded-md border border-border bg-background p-0.5">
        <IconToggle active={c.startArrow} label="Start arrow" onClick={() => onUpdateContent({ ...c, startArrow: !c.startArrow })}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </IconToggle>
        <IconToggle active={c.endArrow} label="End arrow" onClick={() => onUpdateContent({ ...c, endArrow: !c.endArrow })}>
          <ArrowRight className="h-3.5 w-3.5" />
        </IconToggle>
      </div>
    </>
  );
}

/** A small labeled on/off toggle (for boolean style flags without an icon). */
function PillToggle({ active, label, title, onClick }: { active?: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center rounded-md border border-border px-2 text-xs font-medium hover:bg-accent",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {label}
    </button>
  );
}

// ── small shared bits ──────────────────────────────────────────────────────

function AddButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="h-8" onClick={onClick}>
      {icon}
      {label}
    </Button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" />;
}

function NumField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="h-8 w-16"
        aria-label={label}
      />
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-8 cursor-pointer rounded border border-border bg-background p-0.5"
      aria-label={label}
      title={label}
    />
  );
}

function Seg({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-background p-0.5">
      {options.map(([val, lbl]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          className={cn(
            "inline-flex h-7 items-center rounded-sm px-2 text-xs hover:bg-accent",
            value === val && "bg-accent text-accent-foreground",
          )}
        >
          {lbl}
        </button>
      ))}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function IconToggle({ active, label, onClick, children }: { active?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-sm hover:bg-accent",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
