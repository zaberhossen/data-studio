"use client";

/**
 * TextElement — a free-text canvas label. Double-click (in edit mode) swaps the
 * static text for a textarea; blur/⌘-Enter commits. Style (size/align/bold/
 * italic/color) is driven from the canvas toolbar when this element is selected.
 * Text wears an ink token by default (dataviz: text never wears a series color).
 */

import * as React from "react";
import type { TextContent } from "@/lib/types/dashboard";
import { renderMarkdown } from "@/lib/dashboard/markdown";

interface Props {
  content: TextContent;
  editable: boolean;
  onChange: (content: TextContent) => void;
}

export function TextElement({ content, editable, onChange }: Props) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(content.text);
  const ref = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the editable draft from props when entering edit mode
      setDraft(content.text);
      // Focus + select on the next tick so the textarea is mounted.
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [editing, content.text]);

  const commit = () => {
    setEditing(false);
    if (draft !== content.text) onChange({ ...content, text: draft });
  };

  const style: React.CSSProperties = {
    fontSize: content.fontSize ?? 16,
    fontWeight: content.bold ? 600 : 400,
    fontStyle: content.italic ? "italic" : "normal",
    textAlign: content.align ?? "left",
    color: content.color ?? "hsl(var(--foreground))",
    lineHeight: 1.35,
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          if (e.key === "Escape") setEditing(false);
          e.stopPropagation();
        }}
        // Keep the textarea from initiating a canvas drag/select.
        onMouseDown={(e) => e.stopPropagation()}
        className="h-full w-full resize-none border-0 bg-transparent p-1 outline-none focus:ring-1 focus:ring-ring"
        style={style}
      />
    );
  }

  // Markdown mode renders parsed nodes; `whitespace-pre-wrap` is dropped so list
  // / heading block spacing applies. Plain mode preserves literal whitespace.
  if (content.markdown && content.text) {
    return (
      <div
        className="h-full w-full overflow-auto break-words p-1"
        style={style}
        onDoubleClick={editable ? () => setEditing(true) : undefined}
      >
        {renderMarkdown(content.text)}
      </div>
    );
  }

  return (
    <div
      className="h-full w-full overflow-hidden whitespace-pre-wrap break-words p-1"
      style={style}
      onDoubleClick={editable ? () => setEditing(true) : undefined}
    >
      {content.text || (editable ? "Double-click to edit" : "")}
    </div>
  );
}
