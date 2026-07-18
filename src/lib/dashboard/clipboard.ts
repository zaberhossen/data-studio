/**
 * Canvas clipboard — copy/paste of widgets + decoration elements, across
 * dashboards and (via localStorage) across reloads and tabs.
 *
 * Only serializable declarative data is stored (a `Widget` carries its query
 * definition + viz + boxes; an element carries its content + boxes) — never
 * rows or results, matching the dashboard model's golden rule. Ids are NOT
 * stored meaningfully: the paste side always re-mints them.
 */

import type { CanvasElement, Widget } from "@/lib/types/dashboard";

export interface CanvasClipboard {
  widgets: Widget[];
  elements: CanvasElement[];
}

const KEY = "data-studio:canvas-clipboard";

// A module mirror so same-tab paste works even where localStorage is blocked.
let memory: CanvasClipboard | null = null;

export function writeClipboard(payload: CanvasClipboard): void {
  memory = payload;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Private mode / quota — the in-memory mirror still serves this session.
  }
}

export function readClipboard(): CanvasClipboard | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as CanvasClipboard;
  } catch {
    // fall through to the memory mirror
  }
  return memory;
}

export function hasClipboard(): boolean {
  const c = readClipboard();
  return !!c && (c.widgets.length > 0 || c.elements.length > 0);
}
