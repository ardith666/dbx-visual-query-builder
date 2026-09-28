// Query model -> SQL. Pure, no DOM, no host API: the whole generator is
// testable without DBX, which is why every dialect case gets a golden test.
import { quoteIdent, literalString, literalNumber, literalBool, isSupported, SUPPORTS_LIMIT } from "./dialect.js";

export const AGGREGATES = ["COUNT", "SUM", "AVG", "MIN", "MAX"];

const JOIN_SQL = {
  INNER: "INNER JOIN",
  LEFT: "LEFT JOIN",
  RIGHT: "RIGHT JOIN",
  FULL: "FULL OUTER JOIN",
  CROSS: "CROSS JOIN",
};

const BINARY_OPS = ["=", "<>", ">", ">=", "<", "<="];

export const OPERATORS = [...BINARY_OPS, "LIKE", "NOT LIKE", "IN", "NOT IN", "BETWEEN", "IS NULL", "IS NOT NULL"];

function fail(message) {
  throw new Error(message);
}

// A model is only ever rendered if every table it names still exists. A dropped
// table must not silently produce SQL that reads a different table.
function indexTables(model) {
  const index = new Map();
  for (const table of model.tables ?? []) {
    if (!table.id) fail("table is missing an id");
    if (index.has(table.id)) fail(`duplicate table id: ${table.id}`);
    index.set(table.id, table);
  }
  return index;
}

function refOf(dbType, index, tableId, column, what) {
  const table = index.get(tableId);
  if (!table) fail(`${what} references unknown table: ${tableId}`);
  if (!column) fail(`${what} is missing a column name`);
  return `${quoteIdent(dbType, table.alias || table.name)}.${quoteIdent(dbType, column)}`;
}

function quoteTable(dbType, table) {
  const name = quoteIdent(dbType, table.name);
  const alias = table.alias && table.alias !== table.name ? ` AS ${quoteIdent(dbType, table.alias)}` : "";
  return name + alias;
}

function renderSelectItem(dbType, index, item) {
  const ref = refOf(dbType, index, item.tableId, item.column, "SELECT item");
  if (!item.aggregate) return item.alias ? `${ref} AS ${quoteIdent(dbType, item.alias)}` : ref;
  if (!AGGREGATES.includes(item.aggregate)) fail(`unknown aggregate: ${item.aggregate}`);
  if (item.column === "*") {
    // COUNT(*) counts rows. SUM(*) / AVG(*) / MIN(*) / MAX(*) are not valid.
    if (item.aggregate !== "COUNT") fail(`${item.aggregate}(*) is not valid SQL; name a column`);
    return item.alias ? `COUNT(*) AS ${quoteIdent(dbType, item.alias)}` : "COUNT(*)";
  }
  const expr = `${item.aggregate}(${ref})`;
  return item.alias ? `${expr} AS ${quoteIdent(dbType, item.alias)}` : expr;
}

function renderFilter(dbType, index, filter) {
  if (!OPERATORS.includes(filter.operator)) fail(`unknown operator: ${filter.operator}`);
  if (filter.operator !== "IS NULL" && filter.operator !== "IS NOT NULL" && filter.value === undefined) {
    fail(`${filter.operator} needs a value`);
  }
  const left = refOf(dbType, index, filter.tableId, filter.column, "WHERE");

  if (filter.operator === "IS NULL" || filter.operator === "IS NOT NULL") {
    return `${left} ${filter.operator}`;
  }
  if (filter.operator === "BETWEEN") {
    const values = filter.value;
    if (!Array.isArray(values) || values.length !== 2) fail("BETWEEN needs exactly two values");
    return `${left} BETWEEN ${renderValue(dbType, values[0])} AND ${renderValue(dbType, values[1])}`;
  }
  if (filter.operator === "IN" || filter.operator === "NOT IN") {
    const values = filter.value;
    if (!Array.isArray(values) || values.length === 0) fail(`${filter.operator} needs a non-empty list`);
    return `${left} ${filter.operator} (${values.map((v) => renderValue(dbType, v)).join(", ")})`;
  }
  return `${left} ${filter.operator} ${renderValue(dbType, filter.value)}`;
}

function renderValue(dbType, value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return literalNumber(value);
  if (typeof value === "boolean") return literalBool(dbType, value);
  return literalString(dbType, value);
}

function renderHaving(dbType, index, having) {
  if (!having.operator) fail("HAVING needs an operator");
  if (having.aggregate) {
    if (!AGGREGATES.includes(having.aggregate)) fail(`unknown aggregate: ${having.aggregate}`);
    const ref = having.column === "*" ? "*" : refOf(dbType, index, having.tableId, having.column, "HAVING");
    if (having.column === "*" && having.aggregate !== "COUNT") {
      fail(`${having.aggregate}(*) is not valid SQL; name a column`);
    }
    return `${having.aggregate}(${ref}) ${having.operator} ${renderValue(dbType, having.value)}`;
  }
  if (having.expression) {
    return `${having.expression} ${having.operator} ${renderValue(dbType, having.value)}`;
  }
  const ref = refOf(dbType, index, having.tableId, having.column, "HAVING");
  return `${ref} ${having.operator} ${renderValue(dbType, having.value)}`;
}

// Pick the FROM table: one that is never the right-hand side of a join.
// Using tables[0] instead produced `FROM a LEFT JOIN a` with `b` never joined
// -- duplicate alias at the server, and a missing table in the query.
export function planFrom(model, index) {
  const tables = model.tables ?? [];
  if (tables.length === 0) fail("no tables in the model");
  const joins = model.joins ?? [];

  const names = new Set();
  for (const table of tables) {
    const key = table.alias || table.name;
    if (names.has(key)) fail(`two tables share the name "${key}"; give one an alias`);
    names.add(key);
  }

  const rightSides = new Set(joins.map((j) => j.rightTableId));
  const root = tables.find((t) => !rightSides.has(t.id)) ?? tables[0];

  // Validate before planning, so a self-join reports itself instead of
  // surfacing as a confusing "not connected" further down.
  for (const join of joins) {
    if (join.leftTableId === join.rightTableId) fail("JOIN cannot reference the same table on both sides");
    if (!index.has(join.leftTableId) || !index.has(join.rightTableId)) {
      fail("JOIN references a table that is not in the model");
    }
  }

  // Order joins so each one's left side is already in scope, otherwise the
  // SQL references a table that FROM never introduced.
  const inScope = new Set([root.id]);
  const ordered = [];
  const pool = [...joins];
  let guard = pool.length + 1;
  while (pool.length && guard-- > 0) {
    const i = pool.findIndex((j) => inScope.has(j.leftTableId));
    if (i === -1) break;
    const [join] = pool.splice(i, 1);
    ordered.push(join);
    inScope.add(join.rightTableId);
  }
  if (pool.length) fail("these joins are not connected to the rest of the query");
  for (const table of tables) {
    if (!inScope.has(table.id)) fail(`table "${table.name}" is never joined into the query`);
  }
  void index;
  return { root, ordered };
}

export function generate(model, dbType) {
  if (!isSupported(dbType)) fail(`unsupported dialect: ${dbType}`);
  const index = indexTables(model);
  const tables = model.tables ?? [];
  if (tables.length === 0) fail("no tables in the model");

  const select = model.select ?? [];
  const clauses = [];

  const distinct = model.distinct ? "DISTINCT " : "";
  const columns = select.length
    ? select.map((item) => renderSelectItem(dbType, index, item)).join(", ")
    : "*";
  clauses.push(`SELECT ${distinct}${columns}`);

  const { root, ordered } = planFrom(model, index);
  let sql = clauses.join("\n") + `\nFROM ${quoteTable(dbType, root)}`;

  for (const join of ordered) {
    if (!JOIN_SQL[join.type]) fail(`unknown join type: ${join.type}`);
    const left = index.get(join.leftTableId);
    const right = index.get(join.rightTableId);
    if (!left || !right) fail("JOIN references a table that is not in the model");
    if (left.id === right.id) fail("JOIN cannot reference the same table on both sides");

    let on = "";
    if (join.type !== "CROSS") {
      const conditions = join.conditions ?? [];
      if (conditions.length === 0) fail(`${join.type} JOIN needs at least one ON condition`);
      // A condition names columns only (PRD §10.3); the tables come from the
      // join's own left/right ids, so a condition cannot smuggle in a table.
      on = " ON " + conditions
        .map((c) => `${refOf(dbType, index, join.leftTableId, c.leftColumn, "JOIN")} = ${refOf(dbType, index, join.rightTableId, c.rightColumn, "JOIN")}`)
        .join(" AND ");
    } else if ((join.conditions ?? []).length > 0) {
      fail("CROSS JOIN cannot carry an ON condition");
    }
    const alias = join.alias ? ` AS ${quoteIdent(dbType, join.alias)}` : "";
    sql += `\n${JOIN_SQL[join.type]} ${quoteTable(dbType, right)}${alias}${on}`;
  }

  const filters = (model.filters ?? []).filter(Boolean);
  if (filters.length) {
    // A leading OR would change precedence, so the first row is AND-forced.
    const parts = filters.map((f, i) => {
      const rendered = renderFilter(dbType, index, f);
      if (i === 0) return rendered;
      const connector = f.connector === "OR" ? "OR" : "AND";
      return `${connector} ${rendered}`;
    });
    sql += `\nWHERE ${parts.join("\n  ")}`;
  }

  const groupBy = model.groupBy ?? [];
  if (groupBy.length) {
    sql += `\nGROUP BY ${groupBy.map((g) => refOf(dbType, index, g.tableId, g.column, "GROUP BY")).join(", ")}`;
  }

  const having = (model.having ?? []).filter(Boolean);
  if (having.length) {
    sql += `\nHAVING ${having.map((h) => renderHaving(dbType, index, h)).join(" AND ")}`;
  }

  const orderBy = model.orderBy ?? [];
  if (orderBy.length) {
    const parts = orderBy.map((o) => {
      const direction = o.direction === "DESC" ? " DESC" : " ASC";
      return `${refOf(dbType, index, o.tableId, o.column, "ORDER BY")}${direction}`;
    });
    sql += `\nORDER BY ${parts.join(", ")}`;
  }

  if (model.limit !== undefined && model.limit !== null) {
    const n = literalNumber(model.limit);
    if (Number(n) < 0) fail("LIMIT cannot be negative");
    if (!SUPPORTS_LIMIT[dbType]) fail(`LIMIT is not native on ${dbType}; the model must express it another way`);
    sql += `\nLIMIT ${n}`;
  }

  return sql + ";";
}
