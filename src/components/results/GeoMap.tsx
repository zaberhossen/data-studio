"use client";

/**
 * GeoMap — a choropleth over a world-countries or US-states basemap
 * (react-simple-maps + bundled topojson atlases). A region-name column keys each
 * shape to a numeric value; magnitude is a single-hue sequential ramp (dataviz:
 * sequential = one hue light→dark). Regions with no datum stay a neutral surface.
 *
 * Heavy (topojson + d3-geo), so it is imported lazily by its consumers — this
 * module holds the static atlas imports so they land in the split chunk.
 *
 * Fed `{label,value}[]` via `categoryValues`, where `label` is the region name.
 */

import * as React from "react";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import worldTopo from "world-atlas/countries-110m.json";
import usTopo from "us-atlas/states-10m.json";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";
import { categoryValues } from "@/lib/viz/chart-data";
import { sequentialColor } from "@/lib/viz/palette";
import { makeNumberFormatter } from "@/lib/viz/format";

const NO_DATA = "hsl(var(--muted))";
const STROKE = "hsl(var(--card))";

interface Props {
  table: ResultTable;
  viz: WidgetViz;
}

const SCOPES = {
  world: { topo: worldTopo, objectName: "countries", projection: "geoEqualEarth", scale: 150 },
  us: { topo: usTopo, objectName: "states", projection: "geoAlbersUsa", scale: 900 },
} as const;

const norm = (s: string) => s.trim().toLowerCase();

export function GeoMap({ table, viz }: Props) {
  const scope = viz.mapScope === "us" ? "us" : "world";
  const cfg = SCOPES[scope];
  const fmt = React.useMemo(() => makeNumberFormatter(viz.numberFormat), [viz.numberFormat]);

  const [hover, setHover] = React.useState<{ name: string; value: number | null; x: number; y: number } | null>(null);

  const { valueByName, min, max } = React.useMemo(() => {
    const rows = categoryValues(table, viz, viz.regionKey);
    const m = new Map<string, number>();
    for (const r of rows) m.set(norm(r.label), r.value);
    const vals = rows.map((r) => r.value).filter((v) => Number.isFinite(v));
    return {
      valueByName: m,
      min: vals.length ? Math.min(...vals) : 0,
      max: vals.length ? Math.max(...vals) : 0,
    };
  }, [table, viz]);

  const span = Math.max(1e-9, max - min);
  const fillFor = (v: number | undefined) =>
    v == null ? NO_DATA : sequentialColor((v - min) / span);

  if (valueByName.size === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No regions to map — pick a region-name column.
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ComposableMap
          projection={cfg.projection}
          projectionConfig={{ scale: cfg.scale }}
          width={800}
          height={420}
          style={{ width: "100%", height: "100%" }}
        >
          <Geographies geography={cfg.topo}>
            {({ geographies }: { geographies: Array<{ rsmKey: string; properties: { name?: string } }> }) =>
              geographies.map((geo) => {
                const name = geo.properties?.name ?? "";
                const value = valueByName.get(norm(name));
                return (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill={fillFor(value)}
                    stroke={STROKE}
                    strokeWidth={0.4}
                    style={{
                      default: { outline: "none" },
                      hover: { outline: "none", opacity: 0.85, cursor: "default" },
                      pressed: { outline: "none" },
                    }}
                    onMouseEnter={(e: React.MouseEvent) =>
                      setHover({ name, value: value ?? null, x: e.clientX, y: e.clientY })
                    }
                    onMouseMove={(e: React.MouseEvent) =>
                      setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))
                    }
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })
            }
          </Geographies>
        </ComposableMap>
      </div>

      <MapLegend min={min} max={max} fmt={fmt} />

      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="font-medium">{hover.name}</div>
          <div className="tabular-nums text-muted-foreground">
            {hover.value == null ? "no data" : fmt(hover.value)}
          </div>
        </div>
      )}
    </div>
  );
}

/** A compact sequential-ramp legend with min/max endpoints. */
function MapLegend({ min, max, fmt }: { min: number; max: number; fmt: (v: unknown) => string }) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => sequentialColor(t));
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-[11px] tabular-nums text-muted-foreground">
      <span>{fmt(min)}</span>
      <span
        className="h-2 w-28 rounded-full"
        style={{ background: `linear-gradient(to right, ${stops.join(", ")})` }}
      />
      <span>{fmt(max)}</span>
    </div>
  );
}

export default GeoMap;
