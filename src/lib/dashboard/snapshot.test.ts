import { describe, it, expect } from "vitest";
import { projectPublicDashboard } from "./snapshot";
import { createSnapshotScheduler } from "./snapshot-scheduler";
import type { Dashboard, Widget } from "@/lib/types/dashboard";
import type { ResultTable } from "@/lib/types/results";

function dbWidget(): Widget {
  return {
    id: "w_1",
    title: "Sales",
    sourceId: "src-secret-uuid",
    queryKind: "ir",
    ir: { version: 2, source: { table: "orders" } } as unknown as Widget["ir"],
    sql: "SELECT * FROM orders",
    viz: { type: "bar", xKey: "month" },
    layout: { x: 0, y: 0, w: 6, h: 6 },
    canvasLayout: { x: 10, y: 20, w: 300, h: 200 },
  };
}

describe("projectPublicDashboard", () => {
  it("strips every identifying field (sourceId / sql / ir) from widgets", () => {
    const d: Dashboard = {
      id: "d1",
      name: "Q3",
      widgets: [dbWidget()],
      elements: [{ id: "el_1", kind: "text", canvasLayout: { x: 0, y: 0, w: 200, h: 60 }, content: { kind: "text", text: "hi" } }],
      layoutMode: "canvas",
      canvas: { width: 1200, height: 800 },
    };
    const pub = projectPublicDashboard(d);
    const w = pub.widgets[0] as unknown as Record<string, unknown>;

    expect("sourceId" in w).toBe(false);
    expect("sql" in w).toBe(false);
    expect("ir" in w).toBe(false);
    expect("query" in w).toBe(false);
    // Kept: render-only fields.
    expect(w.id).toBe("w_1");
    expect(w.viz).toEqual({ type: "bar", xKey: "month" });
    expect(w.canvasLayout).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    // Decorations + layout mode carry over.
    expect(pub.layoutMode).toBe("canvas");
    expect(pub.elements?.[0].id).toBe("el_1");
  });

  it("does not serialize a sourceId anywhere in the public payload", () => {
    const d: Dashboard = { id: "d", name: "n", widgets: [dbWidget()] };
    const json = JSON.stringify(projectPublicDashboard(d));
    expect(json.includes("src-secret-uuid")).toBe(false);
    expect(json.toLowerCase().includes("select * from orders")).toBe(false);
  });
});

describe("createSnapshotScheduler", () => {
  const table: ResultTable = {
    columns: [{ name: "x", type: "string" }],
    rows: [["a"]],
    page: 0,
    pageSize: 1,
    totalRows: 1,
    source: "sql",
  };

  it("serves a frozen result by widget id, idle for unknown", () => {
    const s = createSnapshotScheduler({ w_1: table });
    expect(s.getSnapshot("w_1").status).toBe("data");
    expect(s.getSnapshot("w_1").table).toBe(table);
    expect(s.getSnapshot("missing").status).toBe("idle");
  });

  it("reports empty for a zero-row result and is a no-op on submit", () => {
    const empty: ResultTable = { ...table, rows: [], totalRows: 0 };
    const s = createSnapshotScheduler({ w_2: empty });
    expect(s.getSnapshot("w_2").status).toBe("empty");
    expect(() => s.submit({ id: "w_2" } as never)).not.toThrow();
  });

  it("returns a STABLE reference across calls (useSyncExternalStore contract)", () => {
    // A fresh object per call makes useSyncExternalStore re-render forever.
    const s = createSnapshotScheduler({ w_1: table });
    expect(s.getSnapshot("w_1")).toBe(s.getSnapshot("w_1"));
    expect(s.getSnapshot("missing")).toBe(s.getSnapshot("missing")); // shared IDLE
  });
});
