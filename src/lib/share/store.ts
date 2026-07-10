"use client";

/**
 * Client seam for share links (API-backed). Mirrors the other store seams: the
 * UI depends only on this async surface. Creating a link POSTs a frozen snapshot
 * the caller captured from the scheduler.
 */

import type { DashboardSnapshot, ShareLinkMeta } from "@/lib/types/share";

export class ApiShareStore {
  async list(dashboardId: string): Promise<ShareLinkMeta[]> {
    const res = await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/share`);
    if (!res.ok) throw new Error(await errText(res, "Failed to load share links."));
    return (await res.json()) as ShareLinkMeta[];
  }

  async create(
    dashboardId: string,
    snapshot: DashboardSnapshot,
    expiresAt?: string | null,
  ): Promise<ShareLinkMeta> {
    const res = await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, expiresAt: expiresAt ?? null }),
    });
    if (!res.ok) throw new Error(await errText(res, "Failed to create the share link."));
    return (await res.json()) as ShareLinkMeta;
  }

  async revoke(id: string): Promise<void> {
    const res = await fetch(`/api/share-links/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(await errText(res, "Failed to revoke the share link."));
    }
  }
}

async function errText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body?.error ?? fallback;
  } catch {
    return fallback;
  }
}

let store: ApiShareStore | null = null;
export function getShareStore(): ApiShareStore {
  if (!store) store = new ApiShareStore();
  return store;
}

/** The public URL for a token (client-only; uses the current origin). */
export function publicUrlFor(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/public/${token}`;
}
