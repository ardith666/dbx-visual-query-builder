// Metadata queries. Per-dialek on purpose: G4.1 proved that
// `information_schema.constraint_column_usage` does not exist on MySQL, so one
// shared query would fail on the pilot database. Everything here is read-only
// and must pass the host's single-statement gate.

import { literalString } from "./dialect.js";

const MAX_ROWS = 500;

// Host caps `maxRows` at 5000 and defaults to 500. Table lists routinely exceed
// that (G2.1 returned truncated:true at 50 rows across all databases), so the
// UI paginates with LIMIT/OFFSET rather than trying to fetch everything.
// `dbType` is NOT in the workbench context when the plugin is opened from a
// table context-menu: the host sends {connectionId, database, schema, table}
// only. The connection menu sends dbType, but that is the fallback path.
// Every queryData response carries `dbType`, so the first successful query is
// enough to learn the dialect without the host.plans:read permission.
export async function listDatabases(plugin, connectionId) {
  const result = await plugin.queryData({
    connectionId,
    sql: "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
    maxRows: MAX_ROWS,
  });
  if (result.dbType) plugin.dialect = result.dbType;
  return result.rows.map((row) => row[0]);
}

export async function listTables(plugin, connectionId, database) {
  const result = await plugin.queryData({
    connectionId,
    database,
    sql:
      "SELECT table_name, table_type FROM information_schema.tables " +
      `WHERE table_schema = ${literalString(pluginDialect(plugin), database)} ` +
      "AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name",
    maxRows: MAX_ROWS,
  });
  return result.rows.map((row) => ({ name: row[0], type: row[1] }));
}

export async function listColumns(plugin, connectionId, database, table) {
  // The dedicated API is narrower than information_schema but is the supported
  // path: it reports dataType / nullable / precision and never leaks keys.
  const meta = await plugin.getTableMetadata({ connectionId, database, table });
  return meta.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable }));
}

// Foreign keys, shaped per DBMS.
//
// MySQL: key_column_usage alone carries referenced_table_name/column_name.
// PostgreSQL/SQLite: the referenced pair lives in constraint_column_usage, so
// the same join is required. Verified: MySQL rejects the PostgreSQL form with
// "Unknown table 'CONSTRAINT_COLUMN_USAGE' in information_schema".
export async function listForeignKeys(plugin, connectionId, database) {
  const d = pluginDialect(plugin);
  let sql;
  if (d === "mysql") {
    sql =
      "SELECT table_name, column_name, referenced_table_name, referenced_column_name " +
      "FROM information_schema.key_column_usage " +
      `WHERE table_schema = ${literalString(d, database)} ` +
      "AND referenced_table_name IS NOT NULL " +
      "ORDER BY table_name, column_name";
  } else {
    sql =
      "SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table_name, " +
      "ccu.column_name AS referenced_column_name " +
      "FROM information_schema.table_constraints tc " +
      "JOIN information_schema.key_column_usage kcu " +
      "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema " +
      "JOIN information_schema.constraint_column_usage ccu " +
      "  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema " +
      "WHERE tc.constraint_type = 'FOREIGN KEY' " +
      `AND tc.table_schema = ${literalString(d, database)} ` +
      "ORDER BY tc.table_name, kcu.column_name";
  }
  const result = await plugin.queryData({ connectionId, database, sql, maxRows: MAX_ROWS });
  return result.rows.map(([table, column, refTable, refColumn]) => ({
    table,
    column,
    refTable,
    refColumn,
  }));
}

// The dialect comes from the workbench context (connection menu) or, failing
// that, from the first queryData response -- see listDatabases.
function pluginDialect(plugin) {
  const d = plugin?.dialect;
  if (!d) throw new Error("database dialect is not known yet");
  return d;
}
