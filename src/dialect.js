// Dialect adapters. ponytail: only what the generator actually needs.
// Grammar is modelled on DBX's own `normalize_dialect` (crates/dbx-sql-core/src/sql_risk.rs)
// so our dialect names match the `dbType` values the host reports.

const IDENT_QUOTE = {
  postgres: '"',
  mysql: "`",
  sqlite: '"',
  mssql: '"',
  oracle: '"',
};

export const SUPPORTED = ["postgres", "mysql", "sqlite"];

export function isSupported(dbType) {
  return SUPPORTED.includes(dbType);
}

export function quoteIdent(dbType, name) {
  const q = IDENT_QUOTE[dbType] ?? '"';
  // Double the closing quote. This is the ANSI rule; MySQL backticks behave the
  // same. Backslash is NOT special inside a quoted identifier, so a name like
  // `a\b` needs no backslash handling here.
  return q + String(name).split(q).join(q + q) + q;
}

// Serialize a string literal.
//
// Order matters. MySQL treats backslash as an escape character unless
// NO_BACKSLASH_ESCAPES is set (verified: sql_mode on the practice MySQL does
// NOT set it), so the backslash must be doubled *before* the apostrophe is
// doubled. Doing apostrophes first turns `x\'` into `x'''` -- still a single
// literal, but the value round-trips wrong. Doing backslash first is correct
// for every dialect: in ANSI dialects a backslash is an ordinary character, and
// doubling it would corrupt the value.
//
// Verified on MySQL 8.0.45 against `WHERE name = 'x\'' OR 1=1 -- '`:
//   apostrophe-only  -> 2 rows leaked
//   backslash-first  -> 0 rows
export function literalString(dbType, value) {
  const text = String(value);
  if (dbType === "mysql") return "'" + text.split("\\").join("\\\\").split("'").join("''") + "'";
  return "'" + text.split("'").join("''") + "'";
}

export function literalNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${value}`);
  return String(n);
}

export function literalBool(dbType, value) {
  if (dbType === "sqlite") return value ? "1" : "0";
  return value ? "TRUE" : "FALSE";
}

export function literalNull() {
  return "NULL";
}

// `LIMIT n` is not valid SQL Server / Oracle; the MVP only claims LIMIT on
// dialects where it is native and drops the clause elsewhere rather than
// emitting a `TOP` rewrite the model does not describe.
export const SUPPORTS_LIMIT = {
  postgres: true,
  mysql: true,
  sqlite: true,
  mssql: false,
  oracle: false,
};
