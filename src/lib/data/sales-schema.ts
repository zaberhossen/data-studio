/**
 * Field schema for the mock sales dataset.
 *
 * Describes each column in `generateSalesData()` ([`mock-source.ts`]) as a
 * UI `Field`. When real connectors land, a `/api/datasources/[id]/schema`
 * response would produce this same `Field[]` shape and everything downstream
 * (query builder, field browser) stays unchanged.
 */

import type { Field } from "@/lib/query/schema";

export const SALES_FIELDS: Field[] = [
  { name: "region", label: "Region", role: "dimension", dataType: "string" },
  { name: "category", label: "Category", role: "dimension", dataType: "string" },
  { name: "channel", label: "Channel", role: "dimension", dataType: "string" },
  { name: "year", label: "Year", role: "dimension", dataType: "number" },
  {
    name: "is_enterprise",
    label: "Enterprise",
    role: "dimension",
    dataType: "boolean",
  },
  { name: "revenue", label: "Revenue", role: "metric", dataType: "number" },
  { name: "units", label: "Units", role: "metric", dataType: "number" },
];
