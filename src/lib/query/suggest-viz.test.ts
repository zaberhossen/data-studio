import { describe, it, expect } from "vitest";
import { suggestVizType } from "./suggest-viz";
import type { IrDraft, DraftDimension, DraftMetric } from "./ir-draft";
import type { Field } from "./schema";

/** Minimal IrDraft — suggestVizType only reads dimensions + metrics. */
function draft(partial: { dimensions?: DraftDimension[]; metrics?: DraftMetric[] }): IrDraft {
  return {
    dimensions: partial.dimensions ?? [],
    metrics: partial.metrics ?? [],
    filters: [],
    having: [],
    sort: [],
    limit: 0,
    offset: 0,
  };
}

const dim = (column: string, temporal?: DraftDimension["temporal"]): DraftDimension => ({
  id: `d_${column}`,
  column,
  ...(temporal ? { temporal } : {}),
});
const metric = (fn: DraftMetric["fn"] = "count", column = ""): DraftMetric => ({
  id: `m_${fn}_${column}`,
  fn,
  column,
});

const field = (name: string, dataType: Field["dataType"]): Field => ({
  name,
  label: name,
  role: dataType === "number" ? "metric" : "dimension",
  dataType,
});

const FIELDS: Field[] = [
  field("category", "string"),
  field("created", "date"),
  field("amount", "number"),
];

describe("suggestVizType", () => {
  it("raw listing (no dims, no metrics) → table", () => {
    expect(suggestVizType(draft({}), FIELDS)).toBe("table");
  });

  it("metrics but no dimensions → kpi (single number)", () => {
    expect(suggestVizType(draft({ metrics: [metric("sum", "amount")] }), FIELDS)).toBe("kpi");
  });

  it("one categorical dimension → bar", () => {
    expect(
      suggestVizType(draft({ dimensions: [dim("category")], metrics: [metric()] }), FIELDS),
    ).toBe("bar");
  });

  it("one date-typed dimension → line (temporal shape)", () => {
    expect(
      suggestVizType(draft({ dimensions: [dim("created")], metrics: [metric()] }), FIELDS),
    ).toBe("line");
  });

  it("one dimension with a temporal bucket → line even if the field isn't date-typed", () => {
    expect(
      suggestVizType(draft({ dimensions: [dim("category", "month")], metrics: [metric()] }), FIELDS),
    ).toBe("line");
  });

  it("two categorical dimensions → bar (grouped)", () => {
    expect(
      suggestVizType(
        draft({ dimensions: [dim("category"), dim("category")], metrics: [metric()] }),
        FIELDS,
      ),
    ).toBe("bar");
  });

  it("two dimensions led by time → line", () => {
    expect(
      suggestVizType(
        draft({ dimensions: [dim("created"), dim("category")], metrics: [metric()] }),
        FIELDS,
      ),
    ).toBe("line");
  });

  it("ignores blank-column dimensions when judging shape", () => {
    // a half-built dimension (no column) shouldn't flip a metric-only draft off kpi
    expect(suggestVizType(draft({ dimensions: [dim("")], metrics: [metric("sum", "amount")] }), FIELDS)).toBe(
      "kpi",
    );
  });
});
