/**
 * Client-side export of dashboards / widgets to PNG + PDF.
 *
 * Rendering happens entirely in the browser (html-to-image rasterizes a DOM
 * node; jsPDF lays the raster into a document) — no server round-trip, matching
 * the "compute stays client-side" invariant. Everything here touches the DOM and
 * is import-guarded so it never runs during SSR.
 */

import { toPng } from "html-to-image";

/** Turn a title into a safe file base name. */
function slug(name: string): string {
  return (name.trim() || "export").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export";
}

/** Trigger a browser download of a data URL. */
function download(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Resolve the page background so exports aren't transparent. */
function pageBackground(): string {
  if (typeof window === "undefined") return "#ffffff";
  const bg = getComputedStyle(document.body).backgroundColor;
  return bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff";
}

/** True for edit-only chrome that must never appear in a static export. */
function isExportChrome(el: Element): boolean {
  if (el instanceof HTMLElement && el.dataset.exportIgnore !== undefined) return true;
  // react-moveable / react-selecto inject control boxes as stage children.
  const cls = typeof el.className === "string" ? el.className : "";
  return /\b(moveable-|selecto-)/.test(cls);
}

/** Rasterize a node to a PNG data URL (2× for crispness). */
async function nodeToPng(node: HTMLElement): Promise<string> {
  return toPng(node, {
    pixelRatio: 2,
    backgroundColor: pageBackground(),
    filter: (el) => !isExportChrome(el),
    cacheBust: true,
  });
}

/** Load a data URL into an <img>, resolving once decoded. */
function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load the captured image."));
    img.src = src;
  });
}

/** Export one node (a widget tile) as a downloaded PNG. */
export async function exportNodeToPng(node: HTMLElement, title: string): Promise<void> {
  const dataUrl = await nodeToPng(node);
  download(dataUrl, `${slug(title)}.png`);
}

/**
 * Export a single canvas FRAME as a PNG. Frames don't contain their items in the
 * DOM (items are absolutely-positioned siblings on the stage), so we rasterize
 * the whole stage once and crop to the frame's logical box. `rect` is in the
 * same logical px as the stage; the measured pixel ratio makes the crop correct
 * at any devicePixelRatio.
 */
export async function exportFrameToPng(
  stageNode: HTMLElement,
  rect: { x: number; y: number; w: number; h: number },
  title: string,
): Promise<void> {
  const dataUrl = await nodeToPng(stageNode);
  const img = await loadImage(dataUrl);
  const ratio = stageNode.offsetWidth ? img.width / stageNode.offsetWidth : 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w * ratio));
  canvas.height = Math.max(1, Math.round(rect.h * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  // Base fill so any transparent gaps aren't black.
  ctx.fillStyle = pageBackground();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    img,
    rect.x * ratio,
    rect.y * ratio,
    rect.w * ratio,
    rect.h * ratio,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  download(canvas.toDataURL("image/png"), `${slug(title)}.png`);
}

/**
 * Export a node (the whole dashboard surface) as a PDF, paginating vertically
 * when the capture is taller than one page. Uses the captured aspect ratio to
 * fit the page width, then slices the tall image across pages.
 */
export async function exportNodeToPdf(node: HTMLElement, title: string): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const dataUrl = await nodeToPng(node);
  const img = await loadImage(dataUrl);

  const landscape = img.width >= img.height;
  const pdf = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // Scale the image to the page width; slice it across pages by shifting the
  // image's Y offset up by one page height each time.
  const scaled = (img.height * pageW) / img.width;
  let remaining = scaled;
  let offset = 0;
  while (remaining > 0) {
    pdf.addImage(dataUrl, "PNG", 0, offset ? -offset : 0, pageW, scaled);
    remaining -= pageH;
    if (remaining > 0) {
      pdf.addPage();
      offset += pageH;
    }
  }
  pdf.save(`${slug(title)}.pdf`);
}
