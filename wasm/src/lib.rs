//! # Analytics Engine (Rust → WASM)
//!
//! This crate is the performance core of Data Studio. It receives a raw dataset
//! (an array of JSON row objects, exactly as a SQL driver or CSV parser would
//! produce) plus a declarative `Query`, and returns a chart-ready payload.
//!
//! The heavy work — filtering hundreds of thousands of rows, grouping, and
//! aggregating — runs here on a background Web Worker thread so the React main
//! thread stays at a locked 60 FPS.
//!
//! ## Data flow
//! ```text
//!   JS rows (JSON)  ─►  Vec<Row>  ─►  filter  ─►  group_by  ─►  aggregate  ─►  ChartPayload  ─►  JS
//! ```

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Value model
// ---------------------------------------------------------------------------

/// A single cell. We accept the shapes a real DB / CSV pipeline emits.
/// Using an untagged enum lets serde infer the variant directly from the JSON.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Cell {
    Number(f64),
    Bool(bool),
    Text(String),
    Null,
}

impl Cell {
    /// Best-effort numeric coercion used by aggregations. Text that parses as a
    /// number is honored ("42" -> 42.0); everything non-numeric yields `None`.
    fn as_number(&self) -> Option<f64> {
        match self {
            Cell::Number(n) => Some(*n),
            Cell::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Cell::Text(s) => s.trim().parse::<f64>().ok(),
            Cell::Null => None,
        }
    }

    /// Stable string form used for grouping keys and label rendering.
    fn as_key(&self) -> String {
        match self {
            Cell::Number(n) => {
                // Render integers cleanly (2024 not 2024.0) for nicer labels.
                if n.fract() == 0.0 && n.is_finite() {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                }
            }
            Cell::Bool(b) => b.to_string(),
            Cell::Text(s) => s.clone(),
            Cell::Null => "∅".to_string(),
        }
    }
}

/// A row is a column-name → cell map, mirroring a DB result row.
type Row = HashMap<String, Cell>;

// ---------------------------------------------------------------------------
// Query model (the "language" the frontend speaks to the engine)
// ---------------------------------------------------------------------------

/// Comparison operators for the WHERE-style filter stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains, // substring match (case-insensitive), text columns
    InList,   // value present in `values`
}

/// A single filter predicate, e.g. `region = "APAC"` or `revenue >= 1000`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Filter {
    pub column: String,
    pub operator: Operator,
    /// Scalar comparison target (used by all operators except `in_list`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Cell>,
    /// Set membership target (used by `in_list`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<Cell>>,
}

/// Aggregation functions for the metric (Y-axis).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AggFn {
    Sum,
    Avg,
    Count,
    Min,
    Max,
}

/// The metric to compute per group. `column` is ignored for `count`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Aggregation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    pub func: AggFn,
}

/// How to sort the resulting groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

/// The full declarative query sent from the frontend.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Query {
    /// Predicates ANDed together. Empty = no filtering.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<Filter>,
    /// The dimension (X-axis). Each distinct value becomes one chart label.
    pub group_by: String,
    /// The metric (Y-axis).
    pub aggregation: Aggregation,
    /// Optional sort applied to the aggregated metric.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<SortDir>,
    /// Optional cap on number of groups returned (top-N after sorting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

// ---------------------------------------------------------------------------
// Output model (chart-ready, Recharts-friendly)
// ---------------------------------------------------------------------------

/// One bar/point: `{ label: "APAC", value: 48210.0 }`.
#[derive(Debug, Clone, Serialize)]
pub struct DataPoint {
    pub label: String,
    pub value: f64,
}

/// The payload returned to JS, ready to feed straight into Recharts.
#[derive(Debug, Clone, Serialize)]
pub struct ChartPayload {
    pub points: Vec<DataPoint>,
    /// Rows that survived filtering (before grouping) — useful for the UI footer.
    pub rows_matched: usize,
    /// Total rows scanned — lets the UI show "12k of 1.2M rows".
    pub rows_total: usize,
    /// Human-readable metric name, e.g. "SUM(revenue)".
    pub metric_label: String,
}

// ---------------------------------------------------------------------------
// Filter stage
// ---------------------------------------------------------------------------

/// Returns true if `row` satisfies `filter`.
fn matches_filter(row: &Row, filter: &Filter) -> bool {
    let cell = match row.get(&filter.column) {
        Some(c) => c,
        None => return false, // missing column never matches
    };

    match filter.operator {
        Operator::Contains => {
            let target = match &filter.value {
                Some(Cell::Text(t)) => t.to_lowercase(),
                _ => return false,
            };
            cell.as_key().to_lowercase().contains(&target)
        }
        Operator::InList => match &filter.values {
            Some(list) => {
                let key = cell.as_key();
                list.iter().any(|v| v.as_key() == key)
            }
            None => false,
        },
        // Ordered / equality comparisons. Prefer numeric comparison when both
        // sides are numeric; otherwise fall back to string comparison.
        op => {
            let target = match &filter.value {
                Some(v) => v,
                None => return false,
            };
            match (cell.as_number(), target.as_number()) {
                (Some(a), Some(b)) => compare_numeric(a, b, op),
                _ => compare_string(&cell.as_key(), &target.as_key(), op),
            }
        }
    }
}

fn compare_numeric(a: f64, b: f64, op: Operator) -> bool {
    match op {
        Operator::Eq => a == b,
        Operator::Neq => a != b,
        Operator::Gt => a > b,
        Operator::Gte => a >= b,
        Operator::Lt => a < b,
        Operator::Lte => a <= b,
        _ => false,
    }
}

fn compare_string(a: &str, b: &str, op: Operator) -> bool {
    match op {
        Operator::Eq => a == b,
        Operator::Neq => a != b,
        Operator::Gt => a > b,
        Operator::Gte => a >= b,
        Operator::Lt => a < b,
        Operator::Lte => a <= b,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Aggregation stage
// ---------------------------------------------------------------------------

/// Running accumulator for a single group. Keeps just enough state to compute
/// any of the supported aggregation functions in a single pass.
#[derive(Default)]
struct Accumulator {
    sum: f64,
    count: u64,        // count of numeric (non-null) values
    rows: u64,         // count of rows in the group (for COUNT(*))
    min: Option<f64>,
    max: Option<f64>,
}

impl Accumulator {
    fn push(&mut self, value: Option<f64>) {
        self.rows += 1;
        if let Some(v) = value {
            self.sum += v;
            self.count += 1;
            self.min = Some(self.min.map_or(v, |m| m.min(v)));
            self.max = Some(self.max.map_or(v, |m| m.max(v)));
        }
    }

    fn finalize(&self, func: AggFn) -> f64 {
        match func {
            AggFn::Sum => self.sum,
            AggFn::Count => self.rows as f64,
            AggFn::Avg => {
                if self.count == 0 {
                    0.0
                } else {
                    self.sum / self.count as f64
                }
            }
            AggFn::Min => self.min.unwrap_or(0.0),
            AggFn::Max => self.max.unwrap_or(0.0),
        }
    }
}

fn metric_label(agg: &Aggregation) -> String {
    let col = agg.column.as_deref().unwrap_or("*");
    match agg.func {
        AggFn::Sum => format!("SUM({col})"),
        AggFn::Avg => format!("AVG({col})"),
        AggFn::Count => "COUNT(*)".to_string(),
        AggFn::Min => format!("MIN({col})"),
        AggFn::Max => format!("MAX({col})"),
    }
}

// ---------------------------------------------------------------------------
// Core pipeline (pure Rust — unit-testable without WASM)
// ---------------------------------------------------------------------------

/// Runs filter → group_by → aggregate → sort → limit. This is the function the
/// WASM boundary wraps; keeping it pure makes it trivial to unit test natively.
fn run_query(rows: &[Row], query: &Query) -> ChartPayload {
    let rows_total = rows.len();

    // Stage 1: FILTER. Single pass, all predicates ANDed.
    // We preserve group insertion order so unsorted output is deterministic.
    let mut groups: HashMap<String, Accumulator> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut rows_matched = 0usize;

    let metric_col = query.aggregation.column.as_deref();

    for row in rows {
        if !query.filters.iter().all(|f| matches_filter(row, f)) {
            continue;
        }
        rows_matched += 1;

        // Stage 2: GROUP BY the dimension column.
        let key = row
            .get(&query.group_by)
            .map(Cell::as_key)
            .unwrap_or_else(|| "∅".to_string());

        // Stage 3: feed the metric value into this group's accumulator.
        let value = metric_col.and_then(|c| row.get(c)).and_then(Cell::as_number);

        let acc = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Accumulator::default()
        });
        acc.push(value);
    }

    // Finalize each group into a data point.
    let mut points: Vec<DataPoint> = order
        .into_iter()
        .map(|label| {
            let value = groups[&label].finalize(query.aggregation.func);
            DataPoint { label, value }
        })
        .collect();

    // Stage 4: SORT (by metric value) if requested.
    if let Some(dir) = query.sort {
        points.sort_by(|a, b| match dir {
            SortDir::Asc => a.value.partial_cmp(&b.value).unwrap_or(std::cmp::Ordering::Equal),
            SortDir::Desc => b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal),
        });
    }

    // Stage 5: LIMIT (top-N).
    if let Some(limit) = query.limit {
        points.truncate(limit);
    }

    ChartPayload {
        points,
        rows_matched,
        rows_total,
        metric_label: metric_label(&query.aggregation),
    }
}

// ---------------------------------------------------------------------------
// WASM boundary
// ---------------------------------------------------------------------------

/// Called once when the module loads (wasm-bindgen `start`). Wires up readable
/// panic messages in the browser console during development.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// The single public entry point exposed to the Web Worker.
///
/// * `rows_js`  — `JsValue` holding an array of row objects (the dataset).
/// * `query_js` — `JsValue` holding the `Query` object.
///
/// Returns a `JsValue` holding the `ChartPayload`. Errors (bad shape) come back
/// as a rejected `Result`, which surfaces as a thrown JS exception.
#[wasm_bindgen]
pub fn aggregate(rows_js: JsValue, query_js: JsValue) -> Result<JsValue, JsValue> {
    // Deserialize JS → Rust. serde-wasm-bindgen avoids a JSON.stringify round-trip.
    let rows: Vec<Row> = serde_wasm_bindgen::from_value(rows_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse dataset: {e}")))?;
    let query: Query = serde_wasm_bindgen::from_value(query_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse query: {e}")))?;

    let payload = run_query(&rows, &query);

    // Serialize Rust → JS. The Serializer with `serialize_maps_as_objects` keeps
    // the output as plain JS objects/arrays (not ES Maps), which React expects.
    serialize_payload(&payload)
}

// ---------------------------------------------------------------------------
// Persistent dataset (load once, query many)
// ---------------------------------------------------------------------------
//
// The one-shot `aggregate()` above re-deserializes the entire dataset on every
// call — fine for a single query, but wasteful when the UI re-queries the same
// data as the user tweaks controls. Worse, repeated multi-hundred-thousand-row
// deserializations grow WASM linear memory (which never shrinks), so per-call
// time climbs over a session.
//
// Instead, the UI calls `load_dataset()` ONCE; the rows are deserialized a
// single time and parked in thread-local memory. Each subsequent `query()` only
// ships the small `Query` across the boundary and reuses the parked rows.
//
// Workers are single-threaded, so a `thread_local!` is effectively a per-worker
// global — exactly the scope we want.
thread_local! {
    static DATASET: RefCell<Vec<Row>> = const { RefCell::new(Vec::new()) };
}

/// Shared serialization of a `ChartPayload` into a plain JS object.
fn serialize_payload(payload: &ChartPayload) -> Result<JsValue, JsValue> {
    payload
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {e}")))
}

/// Deserialize the dataset once and store it in worker memory. Returns the row
/// count so the UI can confirm what landed. Replaces any previously loaded data.
#[wasm_bindgen]
pub fn load_dataset(rows_js: JsValue) -> Result<usize, JsValue> {
    let rows: Vec<Row> = serde_wasm_bindgen::from_value(rows_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to load dataset: {e}")))?;
    let n = rows.len();
    DATASET.with(|d| *d.borrow_mut() = rows);
    Ok(n)
}

/// Run a query against the previously `load_dataset`-ed rows. Only the `Query`
/// crosses the JS boundary here — the heavy dataset stays parked in WASM memory.
#[wasm_bindgen]
pub fn query(query_js: JsValue) -> Result<JsValue, JsValue> {
    let q: Query = serde_wasm_bindgen::from_value(query_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse query: {e}")))?;
    DATASET.with(|d| {
        let payload = run_query(&d.borrow(), &q);
        serialize_payload(&payload)
    })
}

// ---------------------------------------------------------------------------
// Builder ↔ SQL bridge (pure Rust — unit-testable without WASM)
// ---------------------------------------------------------------------------
//
// A TRANSLATION layer, not an execution layer. It converts between the
// declarative `Query` (visual builder) and a SQL string in both directions.
// It reuses the existing `Query` struct above — no parallel model.
//
//   • query_to_sql  — deterministic; always succeeds.
//   • sql_to_query  — best-effort; returns `Unsupported(reason)` for valid SQL
//                     outside the builder's subset, and a parse error only for
//                     genuinely malformed SQL.
mod bridge {
    use super::{AggFn, Aggregation, Cell, Filter, Operator, Query, SortDir};
    use sqlparser::ast::{
        BinaryOperator, DuplicateTreatment, Expr, Function, FunctionArg, FunctionArgExpr,
        FunctionArguments, GroupByExpr, SelectItem, SetExpr, Statement, TableFactor, UnaryOperator,
        Value,
    };
    use sqlparser::dialect::GenericDialect;
    use sqlparser::parser::{Parser, ParserError};

    /// The table the single dataset is registered under (matches DuckDB's).
    pub const DATASET_TABLE: &str = "dataset";

    /// Outcome of `sql_to_query` for *valid* SQL.
    #[derive(Debug)]
    pub enum Bridged {
        /// SQL fits the builder subset; here is the equivalent `Query`.
        Mapped(Query),
        /// Valid SQL, but not representable in the builder (with a reason).
        Unsupported(String),
    }

    /// Genuinely malformed SQL — surfaced to the UI as a parse error.
    #[derive(Debug)]
    pub struct BridgeParseError {
        pub message: String,
        pub line: Option<u64>,
        pub column: Option<u64>,
    }

    fn unsupported(reason: &str) -> Bridged {
        Bridged::Unsupported(reason.to_string())
    }

    // ── Direction 1: Query → SQL (deterministic) ────────────────────────────

    /// Quote an identifier with double quotes, escaping embedded quotes.
    fn quote_ident(name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    /// Render a `Cell` as a safe SQL literal.
    fn render_literal(cell: &Cell) -> String {
        match cell {
            Cell::Number(n) => {
                if n.fract() == 0.0 && n.is_finite() {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                }
            }
            Cell::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Cell::Text(s) => format!("'{}'", s.replace('\'', "''")),
            Cell::Null => "NULL".to_string(),
        }
    }

    fn agg_keyword(func: AggFn) -> &'static str {
        match func {
            AggFn::Sum => "SUM",
            AggFn::Avg => "AVG",
            AggFn::Count => "COUNT",
            AggFn::Min => "MIN",
            AggFn::Max => "MAX",
        }
    }

    /// The aggregate expression, e.g. `SUM("revenue")` or `COUNT(*)`.
    fn agg_expr(agg: &Aggregation) -> String {
        match (agg.func, agg.column.as_deref()) {
            (AggFn::Count, _) => "COUNT(*)".to_string(),
            (func, Some(col)) => format!("{}({})", agg_keyword(func), quote_ident(col)),
            (func, None) => format!("{}(*)", agg_keyword(func)),
        }
    }

    /// A stable, readable alias for the metric column.
    fn agg_alias(agg: &Aggregation) -> String {
        match (agg.func, agg.column.as_deref()) {
            (AggFn::Count, _) => "count".to_string(),
            (func, Some(col)) => format!("{}_{}", agg_keyword(func).to_lowercase(), col),
            (func, None) => agg_keyword(func).to_lowercase(),
        }
    }

    fn op_symbol(op: Operator) -> &'static str {
        match op {
            Operator::Eq => "=",
            Operator::Neq => "<>",
            Operator::Gt => ">",
            Operator::Gte => ">=",
            Operator::Lt => "<",
            Operator::Lte => "<=",
            // contains / in_list are rendered specially, never via this.
            Operator::Contains | Operator::InList => "",
        }
    }

    /// Render a single filter as a SQL predicate. Returns `None` for an
    /// ill-formed filter (e.g. missing value), which is simply skipped.
    fn filter_to_sql(f: &Filter) -> Option<String> {
        let col = quote_ident(&f.column);
        match f.operator {
            Operator::Contains => {
                let raw = match &f.value {
                    Some(Cell::Text(t)) => t.clone(),
                    Some(other) => other.as_key(),
                    None => return None,
                };
                let pattern = format!("%{}%", raw.replace('\'', "''"));
                Some(format!("{} LIKE '{}'", col, pattern))
            }
            Operator::InList => {
                let values = f.values.as_ref()?;
                if values.is_empty() {
                    return None;
                }
                let rendered: Vec<String> = values.iter().map(render_literal).collect();
                Some(format!("{} IN ({})", col, rendered.join(", ")))
            }
            op => {
                let v = f.value.as_ref()?;
                Some(format!("{} {} {}", col, op_symbol(op), render_literal(v)))
            }
        }
    }

    /// Emit clean SQL for `query`. Always succeeds.
    pub fn query_to_sql(query: &Query, table: &str) -> String {
        let mut sql = format!(
            "SELECT {}, {} AS {}\nFROM {}",
            quote_ident(&query.group_by),
            agg_expr(&query.aggregation),
            quote_ident(&agg_alias(&query.aggregation)),
            quote_ident(table),
        );

        let predicates: Vec<String> = query.filters.iter().filter_map(filter_to_sql).collect();
        if !predicates.is_empty() {
            sql.push_str(&format!("\nWHERE {}", predicates.join(" AND ")));
        }

        sql.push_str(&format!("\nGROUP BY {}", quote_ident(&query.group_by)));

        if let Some(dir) = query.sort {
            let kw = match dir {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            sql.push_str(&format!("\nORDER BY {} {}", agg_expr(&query.aggregation), kw));
        }

        if let Some(limit) = query.limit {
            sql.push_str(&format!("\nLIMIT {}", limit));
        }

        sql
    }

    // ── Direction 2: SQL → Query (best-effort) ──────────────────────────────

    /// Internal classification of a single SELECT projection item.
    enum Proj {
        Dim(String),
        Agg(Aggregation),
        Unsupported(String),
    }

    /// Internal failure while mapping a WHERE leaf — carries a human reason.
    struct FilterErr(String);

    fn filter_err(reason: &str) -> FilterErr {
        FilterErr(reason.to_string())
    }

    /// The last segment of a (possibly qualified) identifier expression.
    fn ident_name(expr: &Expr) -> Option<String> {
        match expr {
            Expr::Identifier(id) => Some(id.value.clone()),
            Expr::CompoundIdentifier(ids) => ids.last().map(|i| i.value.clone()),
            _ => None,
        }
    }

    /// Swap the direction of an ordered comparison (for `literal op column`).
    fn flip(op: Operator) -> Operator {
        match op {
            Operator::Gt => Operator::Lt,
            Operator::Lt => Operator::Gt,
            Operator::Gte => Operator::Lte,
            Operator::Lte => Operator::Gte,
            other => other,
        }
    }

    fn value_to_cell(v: &Value) -> Option<Cell> {
        match v {
            Value::Number(s, _) => s.parse::<f64>().ok().map(Cell::Number),
            Value::SingleQuotedString(s) | Value::DoubleQuotedString(s) => {
                Some(Cell::Text(s.clone()))
            }
            Value::Boolean(b) => Some(Cell::Bool(*b)),
            Value::Null => Some(Cell::Null),
            _ => None,
        }
    }

    /// A literal-bearing expression → `Cell` (handles negative numbers).
    fn expr_to_cell(expr: &Expr) -> Option<Cell> {
        match expr {
            Expr::Value(v) => value_to_cell(v),
            Expr::UnaryOp {
                op: UnaryOperator::Minus,
                expr,
            } => {
                if let Expr::Value(Value::Number(s, _)) = expr.as_ref() {
                    s.parse::<f64>().ok().map(|n| Cell::Number(-n))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn classify_aggregate(f: &Function) -> Proj {
        if f.over.is_some() {
            return Proj::Unsupported("Window functions aren't supported in the builder.".into());
        }
        if f.filter.is_some() || !f.within_group.is_empty() {
            return Proj::Unsupported("This aggregate can't be shown in the builder.".into());
        }

        let name = f
            .name
            .0
            .last()
            .map(|i| i.value.to_uppercase())
            .unwrap_or_default();
        let func = match name.as_str() {
            "SUM" => AggFn::Sum,
            "AVG" => AggFn::Avg,
            "COUNT" => AggFn::Count,
            "MIN" => AggFn::Min,
            "MAX" => AggFn::Max,
            other => {
                return Proj::Unsupported(format!(
                    "{}(…) isn't a builder aggregate — use SUM, AVG, COUNT, MIN or MAX.",
                    other
                ));
            }
        };

        let list = match &f.args {
            FunctionArguments::List(l) => l,
            FunctionArguments::None => {
                return Proj::Unsupported("Aggregates need a column or *.".into());
            }
            FunctionArguments::Subquery(_) => {
                return Proj::Unsupported("Subquery arguments aren't supported in the builder.".into());
            }
        };
        if list.duplicate_treatment == Some(DuplicateTreatment::Distinct) {
            return Proj::Unsupported("DISTINCT aggregates aren't supported in the builder.".into());
        }
        if !list.clauses.is_empty() {
            return Proj::Unsupported("This aggregate can't be shown in the builder.".into());
        }
        if list.args.len() != 1 {
            return Proj::Unsupported("Aggregates must take exactly one column or *.".into());
        }
        let arg_expr = match &list.args[0] {
            FunctionArg::Unnamed(e) => e,
            FunctionArg::Named { .. } => {
                return Proj::Unsupported("Named arguments aren't supported in the builder.".into());
            }
        };

        match func {
            // The builder's COUNT is COUNT(*); a counted column is immaterial.
            AggFn::Count => match arg_expr {
                FunctionArgExpr::Wildcard => Proj::Agg(Aggregation {
                    column: None,
                    func: AggFn::Count,
                }),
                FunctionArgExpr::Expr(e) if ident_name(e).is_some() => Proj::Agg(Aggregation {
                    column: None,
                    func: AggFn::Count,
                }),
                _ => Proj::Unsupported("COUNT supports only * or a column in the builder.".into()),
            },
            other => {
                let col = match arg_expr {
                    FunctionArgExpr::Expr(e) => match ident_name(e) {
                        Some(c) => c,
                        None => {
                            return Proj::Unsupported(
                                "Aggregates must take a single column in the builder.".into(),
                            );
                        }
                    },
                    FunctionArgExpr::Wildcard | FunctionArgExpr::QualifiedWildcard(_) => {
                        return Proj::Unsupported(format!(
                            "{} needs a metric column, not *.",
                            agg_keyword(other)
                        ));
                    }
                };
                Proj::Agg(Aggregation {
                    column: Some(col),
                    func: other,
                })
            }
        }
    }

    fn classify_projection(expr: &Expr) -> Proj {
        match expr {
            Expr::Identifier(_) | Expr::CompoundIdentifier(_) => {
                // Safe: ident_name returns Some for both arms.
                Proj::Dim(ident_name(expr).unwrap())
            }
            Expr::Function(f) => classify_aggregate(f),
            _ => Proj::Unsupported(
                "Only a plain column and a single aggregate (SUM/AVG/COUNT/MIN/MAX) can be shown in the builder.".into(),
            ),
        }
    }

    /// Convert a single WHERE leaf predicate into a `Filter`.
    fn leaf_to_filter(expr: &Expr) -> Result<Filter, FilterErr> {
        match expr {
            Expr::BinaryOp { left, op, right } => {
                let operator = match op {
                    BinaryOperator::Eq => Operator::Eq,
                    BinaryOperator::NotEq => Operator::Neq,
                    BinaryOperator::Gt => Operator::Gt,
                    BinaryOperator::GtEq => Operator::Gte,
                    BinaryOperator::Lt => Operator::Lt,
                    BinaryOperator::LtEq => Operator::Lte,
                    _ => {
                        return Err(filter_err(
                            "Only =, <>, >, >=, <, <= comparisons can be shown in the builder.",
                        ));
                    }
                };
                if let (Some(col), Some(cell)) = (ident_name(left), expr_to_cell(right)) {
                    Ok(Filter {
                        column: col,
                        operator,
                        value: Some(cell),
                        values: None,
                    })
                } else if let (Some(col), Some(cell)) = (ident_name(right), expr_to_cell(left)) {
                    Ok(Filter {
                        column: col,
                        operator: flip(operator),
                        value: Some(cell),
                        values: None,
                    })
                } else {
                    Err(filter_err(
                        "Each condition must compare a column to a literal value.",
                    ))
                }
            }
            Expr::Like {
                negated,
                any,
                expr,
                pattern,
                escape_char,
            } => {
                if *negated {
                    return Err(filter_err("NOT LIKE can't be shown in the builder."));
                }
                if *any {
                    return Err(filter_err("LIKE ANY can't be shown in the builder."));
                }
                if escape_char.is_some() {
                    return Err(filter_err("LIKE … ESCAPE can't be shown in the builder."));
                }
                let col =
                    ident_name(expr).ok_or_else(|| filter_err("LIKE must apply to a column."))?;
                let pat = match pattern.as_ref() {
                    Expr::Value(Value::SingleQuotedString(s)) => s.clone(),
                    _ => return Err(filter_err("LIKE pattern must be a simple string.")),
                };
                // Only a bare `%text%` substring pattern maps to `contains`.
                if pat.len() >= 2 && pat.starts_with('%') && pat.ends_with('%') {
                    let inner = &pat[1..pat.len() - 1];
                    if inner.contains('%') || inner.contains('_') {
                        return Err(filter_err(
                            "Only a simple substring LIKE ('%text%') maps to “contains”.",
                        ));
                    }
                    Ok(Filter {
                        column: col,
                        operator: Operator::Contains,
                        value: Some(Cell::Text(inner.to_string())),
                        values: None,
                    })
                } else {
                    Err(filter_err(
                        "Only a substring LIKE ('%text%') maps to “contains”.",
                    ))
                }
            }
            Expr::InList {
                expr,
                list,
                negated,
            } => {
                if *negated {
                    return Err(filter_err("NOT IN can't be shown in the builder."));
                }
                let col =
                    ident_name(expr).ok_or_else(|| filter_err("IN must apply to a column."))?;
                let mut values = Vec::with_capacity(list.len());
                for item in list {
                    match expr_to_cell(item) {
                        Some(c) => values.push(c),
                        None => {
                            return Err(filter_err("IN lists must contain only literal values."));
                        }
                    }
                }
                if values.is_empty() {
                    return Err(filter_err("IN lists must contain at least one value."));
                }
                Ok(Filter {
                    column: col,
                    operator: Operator::InList,
                    value: None,
                    values: Some(values),
                })
            }
            Expr::Nested(_) => Err(filter_err(
                "Parenthesized conditions can't be shown in the builder.",
            )),
            _ => Err(filter_err("This WHERE condition can't be shown in the builder.")),
        }
    }

    /// Flatten an AND-only conjunction into a flat list of filters. OR / NOT /
    /// nested parens short-circuit to an `Unsupported` reason.
    fn flatten_and(expr: &Expr, out: &mut Vec<Filter>) -> Result<(), FilterErr> {
        match expr {
            Expr::BinaryOp {
                left,
                op: BinaryOperator::And,
                right,
            } => {
                flatten_and(left, out)?;
                flatten_and(right, out)
            }
            Expr::BinaryOp {
                op: BinaryOperator::Or,
                ..
            } => Err(filter_err("OR conditions can't be shown in the builder.")),
            Expr::UnaryOp {
                op: UnaryOperator::Not,
                ..
            } => Err(filter_err("NOT conditions can't be shown in the builder.")),
            Expr::Nested(_) => Err(filter_err(
                "Parenthesized conditions can't be shown in the builder.",
            )),
            other => {
                out.push(leaf_to_filter(other)?);
                Ok(())
            }
        }
    }

    /// True if an ORDER BY expression refers to the selected metric — either as
    /// the aggregate expression itself, or by the alias it was given in SELECT.
    fn order_matches_metric(expr: &Expr, agg: &Aggregation, projection: &[SelectItem]) -> bool {
        if let Expr::Function(f) = expr {
            if let Proj::Agg(parsed) = classify_aggregate(f) {
                if parsed.func == agg.func && parsed.column == agg.column {
                    return true;
                }
            }
        }
        if let Some(name) = ident_name(expr) {
            for item in projection {
                if let SelectItem::ExprWithAlias { expr: e, alias } = item {
                    if matches!(e, Expr::Function(_)) && alias.value == name {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn to_bridge_parse_error(err: ParserError) -> BridgeParseError {
        let message = err.to_string();
        let dig = |label: &str| -> Option<u64> {
            message.find(label).and_then(|pos| {
                let rest = &message[pos + label.len()..];
                let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                num.parse::<u64>().ok()
            })
        };
        let line = dig("Line: ");
        let column = dig("Column: ");
        BridgeParseError {
            message,
            line,
            column,
        }
    }

    /// Best-effort mapping of a SQL string to a builder `Query`.
    pub fn sql_to_query(sql: &str) -> Result<Bridged, BridgeParseError> {
        let dialect = GenericDialect {};
        let statements = Parser::parse_sql(&dialect, sql).map_err(to_bridge_parse_error)?;

        if statements.len() != 1 {
            return Ok(unsupported("Only a single SELECT statement is supported."));
        }
        let query = match &statements[0] {
            Statement::Query(q) => q,
            _ => return Ok(unsupported("Only SELECT queries can be shown in the builder.")),
        };

        if query.with.is_some() {
            return Ok(unsupported("WITH / CTE queries aren't supported in the builder."));
        }

        let select = match query.body.as_ref() {
            SetExpr::Select(s) => s.as_ref(),
            SetExpr::Query(_) => {
                return Ok(unsupported("Subqueries aren't supported in the builder."))
            }
            SetExpr::SetOperation { .. } => {
                return Ok(unsupported(
                    "UNION / EXCEPT / INTERSECT aren't supported in the builder.",
                ))
            }
            _ => return Ok(unsupported("This query can't be shown in the builder.")),
        };

        // Reject clauses outside the supported subset.
        if select.distinct.is_some() {
            return Ok(unsupported("DISTINCT isn't supported in the builder."));
        }
        if select.having.is_some() {
            return Ok(unsupported("HAVING isn't supported in the builder."));
        }
        if select.top.is_some() {
            return Ok(unsupported("TOP isn't supported in the builder."));
        }
        if !select.named_window.is_empty() || select.qualify.is_some() {
            return Ok(unsupported("Window functions aren't supported in the builder."));
        }
        if !select.cluster_by.is_empty()
            || !select.distribute_by.is_empty()
            || !select.sort_by.is_empty()
            || !select.lateral_views.is_empty()
            || select.into.is_some()
            || select.prewhere.is_some()
            || select.connect_by.is_some()
        {
            return Ok(unsupported("This query can't be shown in the builder."));
        }

        // FROM: exactly one table, no joins, not a subquery.
        if select.from.len() != 1 {
            return Ok(unsupported(
                "Querying multiple tables isn't supported in the builder.",
            ));
        }
        let twj = &select.from[0];
        if !twj.joins.is_empty() {
            return Ok(unsupported("JOINs aren't supported in the builder."));
        }
        if !matches!(twj.relation, TableFactor::Table { .. }) {
            return Ok(unsupported(
                "Only a simple table source is supported in the builder.",
            ));
        }

        // Projection: exactly one dimension + one aggregate (order-independent).
        if select.projection.iter().any(|item| {
            matches!(
                item,
                SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(..)
            )
        }) {
            return Ok(unsupported("SELECT * isn't supported in the builder."));
        }
        if select.projection.len() != 2 {
            return Ok(unsupported(
                "The builder shows exactly one dimension and one metric.",
            ));
        }
        let mut dim: Option<String> = None;
        let mut agg: Option<Aggregation> = None;
        for item in &select.projection {
            let expr = match item {
                SelectItem::UnnamedExpr(e) => e,
                SelectItem::ExprWithAlias { expr, .. } => expr,
                SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(..) => {
                    return Ok(unsupported("SELECT * isn't supported in the builder."));
                }
            };
            match classify_projection(expr) {
                Proj::Dim(name) => {
                    if dim.is_some() {
                        return Ok(unsupported("Only one dimension is supported in the builder."));
                    }
                    dim = Some(name);
                }
                Proj::Agg(a) => {
                    if agg.is_some() {
                        return Ok(unsupported("Only one metric is supported in the builder."));
                    }
                    agg = Some(a);
                }
                Proj::Unsupported(reason) => return Ok(Bridged::Unsupported(reason)),
            }
        }
        let (dim, agg) = match (dim, agg) {
            (Some(d), Some(a)) => (d, a),
            _ => {
                return Ok(unsupported(
                    "The builder needs one dimension column and one aggregate (SUM/AVG/COUNT/MIN/MAX).",
                ))
            }
        };

        // GROUP BY: exactly the selected dimension.
        let group_exprs = match &select.group_by {
            GroupByExpr::Expressions(exprs, modifiers) => {
                if !modifiers.is_empty() {
                    return Ok(unsupported("GROUP BY modifiers aren't supported in the builder."));
                }
                exprs
            }
            GroupByExpr::All(_) => {
                return Ok(unsupported("GROUP BY ALL isn't supported in the builder."))
            }
        };
        if group_exprs.len() != 1 {
            return Ok(unsupported("The builder groups by exactly one dimension."));
        }
        match ident_name(&group_exprs[0]) {
            Some(name) if name == dim => {}
            _ => return Ok(unsupported("GROUP BY must match the selected dimension.")),
        }

        // WHERE: a flat AND-conjunction of simple predicates.
        let mut filters: Vec<Filter> = Vec::new();
        if let Some(selection) = &select.selection {
            if let Err(FilterErr(reason)) = flatten_and(selection, &mut filters) {
                return Ok(Bridged::Unsupported(reason));
            }
        }

        // ORDER BY: a single expression on the metric.
        let mut sort: Option<SortDir> = None;
        if let Some(order_by) = &query.order_by {
            if order_by.exprs.len() != 1 {
                return Ok(unsupported("The builder sorts by a single metric."));
            }
            let obx = &order_by.exprs[0];
            if obx.with_fill.is_some() {
                return Ok(unsupported("ORDER BY … WITH FILL isn't supported in the builder."));
            }
            if !order_matches_metric(&obx.expr, &agg, &select.projection) {
                return Ok(unsupported("ORDER BY must sort by the selected metric."));
            }
            // SQL default (asc = None) is ASC.
            sort = Some(match obx.asc {
                Some(false) => SortDir::Desc,
                _ => SortDir::Asc,
            });
        }

        // LIMIT / OFFSET / FETCH.
        if query.offset.is_some() {
            return Ok(unsupported("OFFSET isn't supported in the builder."));
        }
        if query.fetch.is_some() {
            return Ok(unsupported("FETCH isn't supported in the builder."));
        }
        if !query.limit_by.is_empty() {
            return Ok(unsupported("LIMIT BY isn't supported in the builder."));
        }
        let mut limit: Option<usize> = None;
        if let Some(limit_expr) = &query.limit {
            match limit_expr {
                Expr::Value(Value::Number(s, _)) => match s.parse::<usize>() {
                    Ok(n) => limit = Some(n),
                    Err(_) => {
                        return Ok(unsupported("LIMIT must be a non-negative integer."))
                    }
                },
                _ => return Ok(unsupported("Only a numeric LIMIT is supported in the builder.")),
            }
        }

        Ok(Bridged::Mapped(Query {
            filters,
            group_by: dim,
            aggregation: agg,
            sort,
            limit,
        }))
    }
}

// ---------------------------------------------------------------------------
// Bridge WASM boundary — exposed on the existing Rust engine worker
// ---------------------------------------------------------------------------

/// Builder → SQL. Deterministic; the dataset table is the shared `dataset`.
#[wasm_bindgen]
pub fn query_to_sql(query_js: JsValue) -> Result<JsValue, JsValue> {
    let query: Query = serde_wasm_bindgen::from_value(query_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse query: {e}")))?;
    let sql = bridge::query_to_sql(&query, bridge::DATASET_TABLE);
    Ok(JsValue::from_str(&sql))
}

#[derive(Serialize)]
struct MappedJs<'a> {
    ok: bool,
    query: &'a Query,
}

#[derive(Serialize)]
struct UnsupportedJs {
    ok: bool,
    reason: String,
}

#[derive(Serialize)]
struct ParseErrJs {
    kind: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u64>,
}

/// SQL → Query (best-effort). Resolves to a `SqlToQueryResult`
/// (`{ ok:true, query }` | `{ ok:false, reason }`); a genuine parse error is
/// thrown (rejects the JS promise) as `{ kind:"parse", message, line?, column? }`.
#[wasm_bindgen]
pub fn sql_to_query(sql: &str) -> Result<JsValue, JsValue> {
    let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    match bridge::sql_to_query(sql) {
        Ok(bridge::Bridged::Mapped(query)) => MappedJs { ok: true, query: &query }
            .serialize(&ser)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {e}"))),
        Ok(bridge::Bridged::Unsupported(reason)) => UnsupportedJs { ok: false, reason }
            .serialize(&ser)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {e}"))),
        Err(pe) => {
            let payload = ParseErrJs {
                kind: "parse",
                message: pe.message,
                line: pe.line,
                column: pe.column,
            }
            .serialize(&ser)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize error: {e}")))?;
            Err(payload)
        }
    }
}

// ---------------------------------------------------------------------------
// Native unit tests (run with `cargo test` — no WASM toolchain needed)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, Cell)]) -> Row {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn sample() -> Vec<Row> {
        vec![
            row(&[("region", Cell::Text("APAC".into())), ("rev", Cell::Number(100.0))]),
            row(&[("region", Cell::Text("APAC".into())), ("rev", Cell::Number(200.0))]),
            row(&[("region", Cell::Text("EMEA".into())), ("rev", Cell::Number(50.0))]),
        ]
    }

    #[test]
    fn sums_by_group() {
        let q = Query {
            filters: vec![],
            group_by: "region".into(),
            aggregation: Aggregation { column: Some("rev".into()), func: AggFn::Sum },
            sort: Some(SortDir::Desc),
            limit: None,
        };
        let out = run_query(&sample(), &q);
        assert_eq!(out.rows_matched, 3);
        assert_eq!(out.points[0].label, "APAC");
        assert_eq!(out.points[0].value, 300.0);
        assert_eq!(out.points[1].value, 50.0);
    }

    #[test]
    fn filters_then_counts() {
        let q = Query {
            filters: vec![Filter {
                column: "rev".into(),
                operator: Operator::Gte,
                value: Some(Cell::Number(100.0)),
                values: None,
            }],
            group_by: "region".into(),
            aggregation: Aggregation { column: None, func: AggFn::Count },
            sort: None,
            limit: None,
        };
        let out = run_query(&sample(), &q);
        assert_eq!(out.rows_matched, 2);
        assert_eq!(out.metric_label, "COUNT(*)");
    }
}

// ---------------------------------------------------------------------------
// Bridge tests — Query↔SQL, both directions + the round-trip property
// ---------------------------------------------------------------------------

#[cfg(test)]
mod bridge_tests {
    use super::bridge::{query_to_sql, sql_to_query, Bridged, DATASET_TABLE};
    use super::{AggFn, Aggregation, Cell, Filter, Operator, Query, SortDir};

    // ---- builders -------------------------------------------------------
    fn query(
        filters: Vec<Filter>,
        group_by: &str,
        aggregation: Aggregation,
        sort: Option<SortDir>,
        limit: Option<usize>,
    ) -> Query {
        Query {
            filters,
            group_by: group_by.into(),
            aggregation,
            sort,
            limit,
        }
    }

    fn sum(col: &str) -> Aggregation {
        Aggregation {
            column: Some(col.into()),
            func: AggFn::Sum,
        }
    }
    fn count() -> Aggregation {
        Aggregation {
            column: None,
            func: AggFn::Count,
        }
    }
    fn scalar(column: &str, operator: Operator, value: Cell) -> Filter {
        Filter {
            column: column.into(),
            operator,
            value: Some(value),
            values: None,
        }
    }

    fn mapped(sql: &str) -> Query {
        match sql_to_query(sql).expect("valid SQL should not be a parse error") {
            Bridged::Mapped(q) => q,
            Bridged::Unsupported(reason) => panic!("expected Mapped, got Unsupported: {reason}"),
        }
    }
    fn reason(sql: &str) -> String {
        match sql_to_query(sql).expect("valid SQL should not be a parse error") {
            Bridged::Unsupported(reason) => reason,
            Bridged::Mapped(_) => panic!("expected Unsupported, got Mapped"),
        }
    }

    /// The core property: for any supported query, sqlToQuery(queryToSql(q)) == q.
    fn assert_roundtrip(q: Query) {
        let sql = query_to_sql(&q, DATASET_TABLE);
        let back = mapped(&sql);
        assert_eq!(back, q, "round-trip mismatch for generated SQL:\n{sql}");
    }

    // ---- Direction 1 + round-trip: every operator ------------------------
    #[test]
    fn roundtrip_scalar_operators() {
        let ops = [
            (Operator::Eq, Cell::Text("APAC".into()), "region"),
            (Operator::Neq, Cell::Text("APAC".into()), "region"),
            (Operator::Gt, Cell::Number(1000.0), "revenue"),
            (Operator::Gte, Cell::Number(1000.0), "revenue"),
            (Operator::Lt, Cell::Number(50.0), "units"),
            (Operator::Lte, Cell::Number(50.0), "units"),
        ];
        for (op, value, col) in ops {
            assert_roundtrip(query(
                vec![scalar(col, op, value)],
                "region",
                sum("revenue"),
                Some(SortDir::Desc),
                Some(50),
            ));
        }
    }

    #[test]
    fn roundtrip_contains() {
        assert_roundtrip(query(
            vec![scalar("category", Operator::Contains, Cell::Text("Pro".into()))],
            "region",
            sum("revenue"),
            None,
            None,
        ));
    }

    #[test]
    fn roundtrip_in_list_text_and_numeric() {
        assert_roundtrip(query(
            vec![Filter {
                column: "region".into(),
                operator: Operator::InList,
                value: None,
                values: Some(vec![Cell::Text("APAC".into()), Cell::Text("EMEA".into())]),
            }],
            "region",
            sum("revenue"),
            None,
            None,
        ));
        assert_roundtrip(query(
            vec![Filter {
                column: "year".into(),
                operator: Operator::InList,
                value: None,
                values: Some(vec![Cell::Number(2023.0), Cell::Number(2024.0)]),
            }],
            "region",
            count(),
            None,
            None,
        ));
    }

    #[test]
    fn roundtrip_sort_and_limit() {
        assert_roundtrip(query(vec![], "region", count(), Some(SortDir::Asc), Some(10)));
        assert_roundtrip(query(vec![], "channel", sum("units"), Some(SortDir::Desc), Some(5)));
        // No sort, no limit.
        assert_roundtrip(query(vec![], "region", sum("revenue"), None, None));
    }

    #[test]
    fn roundtrip_multiple_anded_filters() {
        assert_roundtrip(query(
            vec![
                scalar("region", Operator::Eq, Cell::Text("APAC".into())),
                scalar("units", Operator::Gte, Cell::Number(10.0)),
                Filter {
                    column: "channel".into(),
                    operator: Operator::InList,
                    value: None,
                    values: Some(vec![Cell::Text("Online".into()), Cell::Text("Retail".into())]),
                },
            ],
            "region",
            sum("revenue"),
            Some(SortDir::Desc),
            Some(25),
        ));
    }

    // ---- Direction 2: explicit parse mappings ----------------------------
    #[test]
    fn parses_full_query() {
        let q = mapped(
            "SELECT region, SUM(revenue) AS total FROM sales \
             WHERE units >= 10 GROUP BY region ORDER BY SUM(revenue) DESC LIMIT 5",
        );
        assert_eq!(q.group_by, "region");
        assert_eq!(q.aggregation, sum("revenue"));
        assert_eq!(q.sort, Some(SortDir::Desc));
        assert_eq!(q.limit, Some(5));
        assert_eq!(q.filters.len(), 1);
        assert_eq!(q.filters[0].operator, Operator::Gte);
    }

    #[test]
    fn order_by_alias_maps_to_sort() {
        let q = mapped("SELECT region, SUM(revenue) AS total FROM t GROUP BY region ORDER BY total ASC");
        assert_eq!(q.sort, Some(SortDir::Asc));
    }

    #[test]
    fn like_maps_to_contains() {
        let q = mapped("SELECT region, COUNT(*) AS c FROM t WHERE category LIKE '%Pro%' GROUP BY region");
        assert_eq!(q.filters[0].operator, Operator::Contains);
        assert_eq!(q.filters[0].value, Some(Cell::Text("Pro".into())));
    }

    #[test]
    fn in_list_maps() {
        let q = mapped("SELECT region, SUM(revenue) AS s FROM t WHERE region IN ('APAC','EMEA') GROUP BY region");
        assert_eq!(q.filters[0].operator, Operator::InList);
        assert_eq!(
            q.filters[0].values,
            Some(vec![Cell::Text("APAC".into()), Cell::Text("EMEA".into())])
        );
    }

    #[test]
    fn literal_on_left_flips_operator() {
        // 100 < revenue  ==>  revenue > 100
        let q = mapped("SELECT region, SUM(revenue) AS s FROM t WHERE 100 < revenue GROUP BY region");
        assert_eq!(q.filters[0].column, "revenue");
        assert_eq!(q.filters[0].operator, Operator::Gt);
        assert_eq!(q.filters[0].value, Some(Cell::Number(100.0)));
    }

    #[test]
    fn count_star_maps_to_count() {
        let q = mapped("SELECT region, COUNT(*) AS c FROM t GROUP BY region");
        assert_eq!(q.aggregation, count());
    }

    // ---- Direction 2: ok:false (valid SQL, not builder-representable) -----
    #[test]
    fn join_is_unsupported() {
        let r = reason(
            "SELECT a.region, SUM(b.revenue) AS s FROM sales a \
             JOIN extra b ON a.id = b.id GROUP BY a.region",
        );
        assert!(r.contains("JOIN"), "got: {r}");
    }

    #[test]
    fn or_is_unsupported() {
        let r = reason(
            "SELECT region, SUM(revenue) AS s FROM t \
             WHERE region = 'APAC' OR region = 'EMEA' GROUP BY region",
        );
        assert!(r.contains("OR"), "got: {r}");
    }

    #[test]
    fn multiple_metrics_unsupported() {
        let r = reason("SELECT SUM(revenue) AS s, AVG(units) AS a FROM t GROUP BY region");
        assert!(r.to_lowercase().contains("metric"), "got: {r}");
    }

    #[test]
    fn cte_is_unsupported() {
        let r = reason(
            "WITH x AS (SELECT * FROM t) SELECT region, SUM(revenue) AS s FROM x GROUP BY region",
        );
        assert!(r.contains("CTE"), "got: {r}");
    }

    #[test]
    fn select_star_unsupported() {
        let r = reason("SELECT * FROM t GROUP BY region");
        assert!(r.contains('*'), "got: {r}");
    }

    #[test]
    fn group_by_mismatch_unsupported() {
        let r = reason("SELECT region, SUM(revenue) AS s FROM t GROUP BY channel");
        assert!(r.to_lowercase().contains("group by"), "got: {r}");
    }

    #[test]
    fn having_unsupported() {
        let r = reason(
            "SELECT region, SUM(revenue) AS s FROM t GROUP BY region HAVING SUM(revenue) > 10",
        );
        assert!(r.contains("HAVING"), "got: {r}");
    }

    // ---- Genuinely malformed SQL → parse error (not ok:false) -------------
    #[test]
    fn malformed_sql_rejects_as_parse_error() {
        let err = sql_to_query("SELECT FROM WHERE").expect_err("should be a parse error");
        assert!(!err.message.is_empty());
    }
}
