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
  Bold,
  BringToFront,
  Image as ImageIcon,
  Italic,
  Minus,
  SendToBack,
  Square,
  Trash2,
  Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AlignEdge, DistributeAxis } from "@/lib/dashboard/align";
import type { CanvasElement, ElementContent } from "@/lib/types/dashboard";

interface Props {
  selectionCount: number;
  /** The sole selected element (any kind), or null when 0 or ≥ 2 are selected. */
  element: CanvasElement | null;
  onAdd: (kind: CanvasElement["kind"]) => void;
  onUpdateContent: (content: ElementContent) => void;
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: DistributeAxis) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
}

const HEX_FALLBACK = "#6366f1";
const hexOr = (c: string | undefined, fallback: string) =>
  c && c.startsWith("#") ? c : fallback;

export function CanvasToolbar({
  selectionCount,
  element,
  onAdd,
  onUpdateContent,
  onAlign,
  onDistribute,
  onBringToFront,
  onSendToBack,
  onDelete,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
      {/* Add elements */}
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
    </div>
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
      </>
    );
  }
  // line
  const c = content;
  return (
    <>
      <ColorField label="Stroke" value={hexOr(c.stroke, "#111827")} onChange={(v) => onUpdateContent({ ...c, stroke: v })} />
      <NumField label="Width" value={c.strokeWidth ?? 2} min={1} max={40} onChange={(n) => onUpdateContent({ ...c, strokeWidth: n })} />
    </>
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
