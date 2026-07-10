/**
 * Mock data source — stands in for a CSV/JSON upload or a connected
 * PostgreSQL/MySQL table. In production this module would be replaced by a
 * `/api/datasources/[id]/rows` fetch; the shape it returns (Row[]) is identical
 * either way, so nothing downstream changes.
 */

import type { Row } from "@/lib/types/analytics";

const REGIONS = ["APAC", "EMEA", "NA", "LATAM"] as const;
const CATEGORIES = ["Hardware", "Software", "Services", "Cloud"] as const;
const CHANNELS = ["Direct", "Partner", "Online"] as const;

/**
 * Deterministic pseudo-random generator (mulberry32) so the dataset is stable
 * across reloads — important for demos and snapshot tests.
 */
function rng(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate `count` synthetic sales rows. Default 200k to stress the engine. */
export function generateSalesData(count = 200_000): Row[] {
  const rand = rng(42);
  const rows: Row[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const region = REGIONS[Math.floor(rand() * REGIONS.length)];
    const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
    const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)];

    rows[i] = {
      id: i + 1,
      region,
      category,
      channel,
      // Revenue 100–10,100, skewed by category for visual variety.
      revenue: Math.round(
        (rand() * 10_000 + 100) * (category === "Cloud" ? 1.6 : 1),
      ),
      units: Math.floor(rand() * 500) + 1,
      year: 2021 + Math.floor(rand() * 5),
      is_enterprise: rand() > 0.6,
    };
  }
  return rows;
}

/** Columns the UI can group by (dimensions). */
export const DIMENSIONS = ["region", "category", "channel", "year"] as const;

/** Numeric columns the UI can aggregate (metrics). */
export const METRICS = ["revenue", "units"] as const;
