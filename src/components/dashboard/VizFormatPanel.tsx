"use client";

/**
 * VizFormatPanel — the format/style controls bound to a `WidgetViz`.
 *
 * Sections appear contextually by chart type (stacking, donut, legend, axis
 * titles/scale, combo line-series, number format, conditional formatting, KPI
 * goal/trend, pivot column). Every control emits a `Partial<WidgetViz>` patch;
 * it stores config only — never touches data.
 */

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Field } from "@/lib/query/schema";
import type { ConditionalRule, WidgetViz } from "@/lib/types/query";

interface Props {
  viz: WidgetViz;
  fields: Field[];
  onChange: (patch: Partial<WidgetViz>) => void;
}

const CARTESIAN = new Set(["bar", "line", "area", "combo"]);
const STACKABLE = new Set(["bar", "area"]);

export function VizFormatPanel({ viz, fields, onChange }: Props) {
  const t = viz.type;
  const numericFields = fields.filter((f) => f.dataType === "number");
  const nf = viz.numberFormat ?? {};
  const patchNf = (p: Partial<NonNullable<WidgetViz["numberFormat"]>>) =>
    onChange({ numberFormat: { ...nf, ...p } });

  return (
    <div className="space-y-5">
      {/* ── Series / layout ─────────────────────────────────────────── */}
      {STACKABLE.has(t) && (
        <Row label="Stacking">
          <Seg
            value={viz.stack ?? "none"}
            options={[
              ["none", "None"],
              ["stacked", "Stacked"],
              ["percent", "100%"],
            ]}
            onChange={(v) => onChange({ stack: v as WidgetViz["stack"] })}
          />
        </Row>
      )}

      {t === "pie" && (
        <Row label="Shape">
          <Seg
            value={viz.donut ? "donut" : "pie"}
            options={[
              ["pie", "Pie"],
              ["donut", "Donut"],
            ]}
            onChange={(v) => onChange({ donut: v === "donut" })}
          />
        </Row>
      )}

      {t === "combo" && numericFields.length > 0 && (
        <Row label="Lines" hint="Measures drawn as a line (rest are bars)">
          <div className="flex flex-wrap gap-1.5">
            {numericFields.map((f) => {
              const on = viz.lineKeys?.includes(f.name) ?? false;
              return (
                <Button
                  key={f.name}
                  type="button"
                  size="sm"
                  variant={on ? "secondary" : "outline"}
                  className="h-7"
                  onClick={() => {
                    const set = new Set(viz.lineKeys ?? []);
                    if (on) set.delete(f.name);
                    else set.add(f.name);
                    onChange({ lineKeys: [...set] });
                  }}
                >
                  {f.label}
                </Button>
              );
            })}
          </div>
        </Row>
      )}

      {t === "pivot" && (
        <Row label="Column dimension">
          <ColumnSelect
            value={viz.columnKey}
            fields={fields.filter((f) => f.dataType !== "number")}
            placeholder="(none — totals)"
            onChange={(v) => onChange({ columnKey: v })}
          />
        </Row>
      )}

      {t === "gauge" && (
        <Row label="Gauge range" hint="Empty max → auto (a nice value above the datum, or the goal)">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Min
              <Input
                type="number"
                value={viz.gaugeMin ?? ""}
                onChange={(e) => onChange({ gaugeMin: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="h-8 w-24"
                aria-label="Gauge min"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Max
              <Input
                type="number"
                value={viz.gaugeMax ?? ""}
                onChange={(e) => onChange({ gaugeMax: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="h-8 w-24"
                aria-label="Gauge max"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Goal
              <Input
                type="number"
                value={viz.goal ?? ""}
                onChange={(e) => onChange({ goal: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="h-8 w-24"
                aria-label="Gauge goal"
              />
            </label>
          </div>
        </Row>
      )}

      {t === "map" && (
        <>
          <Row label="Basemap">
            <Seg
              value={viz.mapScope ?? "world"}
              options={[
                ["world", "World"],
                ["us", "US states"],
              ]}
              onChange={(v) => onChange({ mapScope: v as WidgetViz["mapScope"] })}
            />
          </Row>
          <Row label="Region column" hint="Country / US-state name to match shapes">
            <ColumnSelect
              value={viz.regionKey}
              fields={fields.filter((f) => f.dataType !== "number")}
              placeholder="(first text column)"
              onChange={(v) => onChange({ regionKey: v })}
            />
          </Row>
        </>
      )}

      {/* ── Legend + axes (cartesian charts) ────────────────────────── */}
      {CARTESIAN.has(t) && (
        <>
          <Row label="Legend">
            <Seg
              value={viz.legend ?? "bottom"}
              options={[
                ["bottom", "Bottom"],
                ["top", "Top"],
                ["right", "Right"],
                ["none", "Off"],
              ]}
              onChange={(v) => onChange({ legend: v as WidgetViz["legend"] })}
            />
          </Row>
          <Row label="Axis titles">
            <div className="flex gap-2">
              <Input
                value={viz.xTitle ?? ""}
                onChange={(e) => onChange({ xTitle: e.target.value || undefined })}
                placeholder="X title"
                className="h-8"
              />
              <Input
                value={viz.yTitle ?? ""}
                onChange={(e) => onChange({ yTitle: e.target.value || undefined })}
                placeholder="Y title"
                className="h-8"
              />
            </div>
          </Row>
          <Row label="Y scale">
            <Seg
              value={viz.yScale ?? "linear"}
              options={[
                ["linear", "Linear"],
                ["log", "Log"],
              ]}
              onChange={(v) => onChange({ yScale: v as WidgetViz["yScale"] })}
            />
          </Row>
        </>
      )}

      {/* ── Number format (everything except scatter) ───────────────── */}
      {t !== "scatter" && (
        <Row label="Number format">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={nf.style ?? "plain"} onValueChange={(v) => patchNf({ style: v as typeof nf.style })}>
              <SelectTrigger className="h-8 w-32" aria-label="Number style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plain">Plain</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="currency">Currency</SelectItem>
                <SelectItem value="percent">Percent</SelectItem>
              </SelectContent>
            </Select>
            {nf.style === "currency" && (
              <Input
                value={nf.currency ?? "USD"}
                onChange={(e) => patchNf({ currency: e.target.value.toUpperCase() || undefined })}
                className="h-8 w-20"
                aria-label="Currency code"
              />
            )}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Decimals
              <Input
                type="number"
                min={0}
                max={6}
                value={nf.decimals ?? ""}
                onChange={(e) =>
                  patchNf({ decimals: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })
                }
                className="h-8 w-16"
                aria-label="Decimals"
              />
            </label>
          </div>
        </Row>
      )}

      {/* ── KPI goal + trend ────────────────────────────────────────── */}
      {t === "kpi" && (
        <Row label="KPI">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Goal
              <Input
                type="number"
                value={viz.goal ?? ""}
                onChange={(e) => onChange({ goal: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="h-8 w-28"
                aria-label="Goal target"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={viz.showTrend ?? false}
                onChange={(e) => onChange({ showTrend: e.target.checked })}
              />
              Show trend vs. previous
            </label>
          </div>
        </Row>
      )}

      {/* ── Conditional formatting (table + kpi + gauge) ────────────── */}
      {(t === "table" || t === "kpi" || t === "gauge") && (
        <ConditionalEditor
          rules={viz.conditional ?? []}
          columns={fields.map((f) => f.name)}
          kpi={t === "kpi" || t === "gauge"}
          onChange={(rules) => onChange({ conditional: rules.length ? rules : undefined })}
        />
      )}
    </div>
  );
}

// ── Conditional-formatting rule list ───────────────────────────────────────

const STATUS_COLORS: Array<[string, string]> = [
  ["good", "Good (green)"],
  ["warning", "Warning (amber)"],
  ["serious", "Serious (orange)"],
  ["critical", "Critical (red)"],
];
const OPS: Array<[ConditionalRule["op"], string]> = [
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["eq", "="],
  ["between", "between"],
];

function ConditionalEditor({
  rules,
  columns,
  kpi,
  onChange,
}: {
  rules: ConditionalRule[];
  columns: string[];
  kpi: boolean;
  onChange: (rules: ConditionalRule[]) => void;
}) {
  const update = (i: number, patch: Partial<ConditionalRule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () =>
    onChange([...rules, { op: "gt", value: 0, color: "good", column: kpi ? undefined : columns[0] }]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Conditional formatting
        </span>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">No rules — values render in the default ink.</p>
      ) : (
        <div className="space-y-1.5">
          {rules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              {!kpi && (
                <ColumnSelect
                  value={r.column}
                  fields={columns.map((c) => ({ name: c, label: c }))}
                  placeholder="Any column"
                  onChange={(v) => update(i, { column: v })}
                />
              )}
              <Select value={r.op} onValueChange={(v) => update(i, { op: v as ConditionalRule["op"] })}>
                <SelectTrigger className="h-8 w-24" aria-label="Operator">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map(([op, label]) => (
                    <SelectItem key={op} value={op}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                value={r.value}
                onChange={(e) => update(i, { value: Number(e.target.value) })}
                className="h-8 w-20"
                aria-label="Value"
              />
              {r.op === "between" && (
                <Input
                  type="number"
                  value={r.value2 ?? ""}
                  onChange={(e) => update(i, { value2: Number(e.target.value) })}
                  className="h-8 w-20"
                  aria-label="Upper bound"
                />
              )}
              <Select value={r.color} onValueChange={(v) => update(i, { color: v })}>
                <SelectTrigger className="h-8 w-36" aria-label="Color">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_COLORS.map(([val, label]) => (
                    <SelectItem key={val} value={val}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Remove rule"
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Small shared controls ───────────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Seg({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
      {options.map(([val, label]) => (
        <Button
          key={val}
          type="button"
          size="sm"
          variant={value === val ? "secondary" : "ghost"}
          className="h-7"
          onClick={() => onChange(val)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function ColumnSelect({
  value,
  fields,
  placeholder,
  onChange,
}: {
  value: string | undefined;
  fields: Array<{ name: string; label: string }>;
  placeholder: string;
  onChange: (v: string | undefined) => void;
}) {
  const NONE = "__none";
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
      <SelectTrigger className="h-8 w-40" aria-label="Column">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {fields.map((f) => (
          <SelectItem key={f.name} value={f.name}>
            {f.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
