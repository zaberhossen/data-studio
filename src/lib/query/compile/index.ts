/**
 * The IR compile layer — barrel export.
 */

export { compileIR, CompileError } from "./compile";
export type { CompiledSql, CompiledColumn, ColumnRole } from "./compile";
export type { Dialect, DialectId } from "./dialect";
export { DuckDbDialect } from "./duckdb";
export { PostgresDialect } from "./postgres";
export { MySqlDialect } from "./mysql";
export { dialectFor } from "./dialects";
export { rustFastPath } from "./capability";
export { queryV1ToIR } from "./migrate";
export { chooseExecution } from "./route";
