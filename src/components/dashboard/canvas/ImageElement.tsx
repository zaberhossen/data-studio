"use client";

/**
 * ImageElement — a URL-referenced image (no upload backend in M8). Empty URL
 * shows a placeholder prompting the editor to set one from the toolbar.
 */

import * as React from "react";
import { ImageIcon } from "lucide-react";
import type { ImageContent } from "@/lib/types/dashboard";

export function ImageElement({ content, editable }: { content: ImageContent; editable: boolean }) {
  if (!content.url) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-muted-foreground">
        <ImageIcon className="h-5 w-5" />
        {editable ? <span className="text-[11px]">Set an image URL in the toolbar</span> : null}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={content.url}
      alt=""
      draggable={false}
      className="h-full w-full select-none rounded-md"
      style={{ objectFit: content.fit ?? "contain" }}
    />
  );
}
