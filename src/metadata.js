// Metadata queries. Per-dialect on purpose: G4.1 proved that
// `information_schema.constraint_column_usage` does not exist on MySQL, so one
// shared query would fail on the pilot database. Everything here is read-only
// and must pass the host's single-statement gate.
//
// A "database" and a "schema" are not the same thing. In MySQL they are the
// same namespace, but on PostgreSQL `information_schema.schemata` lists the
// schemas of the *current* database; the databases themselves live in
// `pg_database`. Treating the two as interchangeable is what made the picker
// list `public`/`pg_catalog` as "databases" and made `listTables` ask for a
// schema named after the database. The host's workbench context carries both
// (`{ connectionId, database, schema, table }`), so callers pass both here.

import { literalString } from "./dialect.js";

const MAX_ROWS = 500;

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

// Host caps `maxRows` at 5000 and defaults to 500. Table lists routinely exceed
// that, so the UI paginates with LIMIT/OFFSET rather than fetching everything.
// Every queryData response carries `dbType`. A table context-menu invocation
// carries no `dbType` (the host sends {connectionId, database, schema, table}),
// so the first query is where the dialect comes from. `SELECT 1` works on every
// SQL dialect; using `information_schema.schemata` as the probe would fail on
// SQLite before we could learn it is SQLite.
async function ensureDialect(plugin, connectionId) {
  if (plugin?.dialect) return plugin.dialect;
  const result = await plugin.queryData({ connectionId, sql: "SELECT 1 AS probe", maxRows: 1 });
  if (!result.dbType) throw new Error("the host did not report a database dialect");
  plugin.dialect = result.dbType;
  return plugin.dialect;
}

function unsupported(what, dialect) {
  throw new Error(`${what} is not supported on ${dialect} connections`);
}

// The databases (not schemas) a connection exposes.
export async function listDatabases(plugin, connectionId) {
  const d = await ensureDialect(plugin, connectionId);
  let sql;
  if (d === "postgres") {
    // `datallowconn = false` databases cannot be queried, and templates are
    // templates. pg_database is a shared catalog, so it lists every database on
    // the server rather than the current one's schemas.
    sql =
      "SELECT datname FROM pg_database " +
      "WHERE datistemplate = false AND datallowconn " +
      "ORDER BY datname";
  } else if (d === "mysql") {
    sql = "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name";
  } else if (d === "sqlite") {
    // SQLite calls its single database "main" (plus anything ATTACHed). A very
    // old SQLite may reject the table-valued pragma, but `main` still exists.
    try {
      const result = await plugin.queryData({
        connectionId,
        sql: "SELECT name FROM pragma_database_list ORDER BY name",
        maxRows: MAX_ROWS,
      });
      return result.rows.map((row) => row[0]);
    } catch {
      return ["main"];
    }
  } else {
    unsupported("Listing databases", d);
  }
  const result = await plugin.queryData({ connectionId, sql, maxRows: MAX_ROWS });
  return result.rows.map((row) => row[0]);
}

// Schemas inside one database. On MySQL a schema *is* a database, so the
// picker is not needed there; PostgreSQL is the case that needs both levels.
export async function listSchemas(plugin, connectionId, database) {
  const d = await ensureDialect(plugin, connectionId);
  if (d === "postgres") {
    const result = await plugin.queryData({
      connectionId,
      database,
      sql:
        "SELECT schema_name FROM information_schema.schemata " +
        `WHERE schema_name NOT IN ${SYSTEM_SCHEMAS} ` +
        "AND schema_name NOT LIKE 'pg_toast%' " +
        "AND schema_name NOT LIKE 'pg_temp%' " +
        "ORDER BY schema_name",
      maxRows: MAX_ROWS,
    });
    return result.rows.map((row) => row[0]);
  }
  if (d === "mysql") return database ? [database] : [];
  if (d === "sqlite") return ["main"];
  unsupported("Listing schemas", d);
}

// Tables inside one database + schema. The schema filter must never be the
// database name on PostgreSQL: `table_schema = 'app'` matches nothing when the
// database is `app` and the schema is `public`. That bug is why the sidebar
// showed "No tables." right after the context menu had already supplied one.
export async function listTables(plugin, connectionId, database, schema = "") {
  const d = await ensureDialect(plugin, connectionId);
  let sql;
  if (d === "sqlite") {
    sql =
      "SELECT name, type FROM sqlite_master " +
      "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' " +
      "ORDER BY name";
  } else if (d === "mysql") {
    // MySQL has no separate schema level: database and schema are the same.
    const scope = database ? `table_schema = ${literalString(d, database)}` : "table_schema = DATABASE()";
    sql =
      "SELECT table_name, table_type FROM information_schema.tables " +
      `WHERE ${scope} AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name`;
  } else if (d === "postgres") {
    const scope = schema
      ? `table_schema = ${literalString(d, schema)}`
      : `table_schema NOT IN ${SYSTEM_SCHEMAS} ` +
        "AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp%'";
    sql =
      "SELECT table_name, table_type, table_schema FROM information_schema.tables " +
      `WHERE ${scope} AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name`;
  } else {
    unsupported("Listing tables", d);
  }
  const result = await plugin.queryData({ connectionId, database, sql, maxRows: MAX_ROWS });
  return result.rows.map((row) => ({
    name: row[0],
    type: row[1],
    // PostgreSQL returns the real schema; the other dialects have exactly one
    // implicit scope, so name it explicitly rather than inventing one.
    schema: d === "postgres" ? row[2] : d === "sqlite" ? "main" : database,
  }));
}

export async function listColumns(plugin, connectionId, database, table, schema = "") {
  // The dedicated API is narrower than information_schema but is the supported
  // path: it reports dataType / nullable / precision and never leaks keys. The
  // host rejects a database without an open session, so only send identity
  // values that actually exist (empty strings are not identities). SQLite has
  // no separate database/schema identity to send; its metadata path uses the
  // connection's own pool.
  const d = plugin?.dialect;
  const request = { connectionId, table };
  if (d !== "sqlite") {
    if (database) request.database = database;
    if (schema) request.schema = schema;
  }
  const meta = await plugin.getTableMetadata(request);
  return meta.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable }));
}

// Foreign keys, shaped per DBMS.
//
// MySQL: key_column_usage alone carries referenced_table_name/column_name.
// PostgreSQL/SQLite: the referenced pair lives in constraint_column_usage, so
// the same join is required. Verified: MySQL rejects the PostgreSQL form with
// "Unknown table 'CONSTRAINT_COLUMN_USAGE' in information_schema".
//
// The PostgreSQL filter is the table's schema, not the database. Using the
// database name here returned zero rows, so auto-join never fired on Postgres.
export async function listForeignKeys(plugin, connectionId, database, schema = "") {
  const d = await ensureDialect(plugin, connectionId);
  let sql;
  if (d === "mysql") {
    sql =
      "SELECT table_name, column_name, referenced_table_name, referenced_column_name " +
      "FROM information_schema.key_column_usage " +
      `WHERE table_schema = ${literalString(d, database)} ` +
      "AND referenced_table_name IS NOT NULL " +
      "ORDER BY table_name, column_name";
  } else if (d === "sqlite") {
    // Foreign keys are not in information_schema. The table-valued pragma
    // exposes the same table/column/referenced pair for every real table.
    sql =
      'SELECT m.name AS table_name, p."from" AS column_name, ' +
      'p."table" AS referenced_table_name, p."to" AS referenced_column_name ' +
      "FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) p " +
      "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' " +
      "ORDER BY m.name, p.id";
  } else if (d === "postgres") {
    const scope = schema
      ? `AND tc.table_schema = ${literalString(d, schema)} `
      : `AND tc.table_schema NOT IN ${SYSTEM_SCHEMAS} ` +
        "AND tc.table_schema NOT LIKE 'pg_toast%' AND tc.table_schema NOT LIKE 'pg_temp%' ";
    sql =
      "SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table_name, " +
      "ccu.column_name AS referenced_column_name " +
      "FROM information_schema.table_constraints tc " +
      "JOIN information_schema.key_column_usage kcu " +
      "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema " +
      "JOIN information_schema.constraint_column_usage ccu " +
      "  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema " +
      "WHERE tc.constraint_type = 'FOREIGN KEY' " +
      scope +
      "ORDER BY tc.table_name, kcu.column_name";
  } else {
    unsupported("Listing foreign keys", d);
  }
  const result = await plugin.queryData({ connectionId, database, sql, maxRows: MAX_ROWS });
  return result.rows.map(([table, column, refTable, refColumn]) => ({
    table,
    column,
    refTable,
    refColumn,
  }));
}
