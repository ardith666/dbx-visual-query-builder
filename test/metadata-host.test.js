import { test } from "node:test";
import assert from "node:assert/strict";
import { listDatabases, listSchemas, listTables, listForeignKeys, listColumns } from "../src/metadata.js";

// A stand-in for the host bridge, shaped like the one DBX actually hands a
// plugin opened from a table context-menu: the context has no `dbType`, and
// `queryData` responses carry it instead. `dialect: undefined` forces the
// SELECT 1 probe exactly as the real bridge does.
function fakeHost({ dbType = "postgres", probe = false, rows = {} } = {}) {
  const calls = [];
  const host = {
    dialect: probe ? undefined : dbType,
    calls,
    async queryData(params) {
      calls.push({ ...params });
      const sql = params.sql;
      if (/^SELECT 1 AS probe/.test(sql.trim())) {
        host.dialect = dbType;
        return { dbType, columns: [{ name: "probe" }], rows: [[1]], truncated: false, elapsedMs: 1 };
      }
      for (const [fragment, value] of Object.entries(rows)) {
        if (sql.includes(fragment)) {
          return { dbType, columns: [{ name: "x" }], rows: value, truncated: false, elapsedMs: 1 };
        }
      }
      return { dbType, columns: [], rows: [], truncated: false, elapsedMs: 1 };
    },
    async getTableMetadata(request) {
      calls.push({ getTableMetadata: request });
      return {
        columns: [{ name: "id", dataType: "int", nullable: false }],
        fieldCapabilities: { precision: "supported" },
      };
    },
  };
  return host;
}

test("listDatabases probes the dialect when the context has none", async () => {
  // A table context-menu invocation has no dbType, so the first query is the
  // only place it can come from. The probe must work on SQLite too, which is
  // why it is SELECT 1 and not information_schema.schemata.
  const host = fakeHost({ dbType: "postgres", probe: true, rows: { pg_database: [["app"], ["other"]] } });
  assert.equal(host.dialect, undefined);
  const dbs = await listDatabases(host, "conn-1");
  assert.deepEqual(dbs, ["app", "other"]);
  assert.match(host.calls[0].sql, /^SELECT 1 AS probe/);
  assert.match(host.calls[1].sql, /pg_database/);
  assert.equal(host.dialect, "postgres");
});

test("PostgreSQL databases come from pg_database, not schemata", async () => {
  const host = fakeHost({ dbType: "postgres", rows: { pg_database: [["clamav-port"], ["warehouse"]] } });
  const dbs = await listDatabases(host, "c");
  assert.deepEqual(dbs, ["clamav-port", "warehouse"]);
  assert.match(host.calls.at(-1).sql, /datistemplate = false/);
  assert.ok(!host.calls.at(-1).sql.includes("schemata"), "schemata lists the current database's schemas");
});

test("MySQL databases still come from information_schema.schemata", async () => {
  const host = fakeHost({ dbType: "mysql", rows: { schemata: [["app"], ["reporting"]] } });
  assert.deepEqual(await listDatabases(host, "c"), ["app", "reporting"]);
  assert.match(host.calls.at(-1).sql, /information_schema\.schemata/);
});

test("SQLite databases come from pragma_database_list", async () => {
  const host = fakeHost({ dbType: "sqlite", rows: { pragma_database_list: [["main"]] } });
  assert.deepEqual(await listDatabases(host, "c"), ["main"]);
  assert.match(host.calls.at(-1).sql, /pragma_database_list/);
});

test("PostgreSQL schemas exclude the system namespaces", async () => {
  const host = fakeHost({ dbType: "postgres", rows: { schemata: [["app"], ["public"]] } });
  const schemas = await listSchemas(host, "c", "clamav-port");
  assert.deepEqual(schemas, ["app", "public"]);
  const sql = host.calls.at(-1).sql;
  assert.match(sql, /schema_name NOT IN \('pg_catalog', 'information_schema'\)/);
  assert.match(sql, /NOT LIKE 'pg_toast%'/);
  assert.equal(host.calls.at(-1).database, "clamav-port");
});

test("MySQL and SQLite do not invent a schema query", async () => {
  const mysql = fakeHost({ dbType: "mysql" });
  assert.deepEqual(await listSchemas(mysql, "c", "app"), ["app"]);
  assert.equal(mysql.calls.length, 0);

  const sqlite = fakeHost({ dbType: "sqlite" });
  assert.deepEqual(await listSchemas(sqlite, "c", "main"), ["main"]);
  assert.equal(sqlite.calls.length, 0);
});

test("PostgreSQL tables are filtered by schema, not by the database name", async () => {
  // This is the reported bug: table_schema was set to `clamav-port`, so the
  // sidebar said "No tables." even though the schema was `public`.
  const host = fakeHost({
    dbType: "postgres",
    rows: { "table_schema = 'public'": [["auth_group_permissions", "BASE TABLE", "public"]] },
  });
  const tables = await listTables(host, "c", "clamav-port", "public");
  const sql = host.calls.at(-1).sql;
  assert.match(sql, /table_schema = 'public'/);
  assert.ok(!sql.includes("'clamav-port'"), "the database name is not a schema");
  assert.deepEqual(tables, [{ name: "auth_group_permissions", type: "BASE TABLE", schema: "public" }]);
});

test("PostgreSQL table listing without a schema covers user schemas only", async () => {
  const host = fakeHost({ dbType: "postgres", rows: {} });
  await listTables(host, "c", "app");
  const sql = host.calls.at(-1).sql;
  assert.match(sql, /table_schema NOT IN \('pg_catalog', 'information_schema'\)/);
  assert.match(sql, /NOT LIKE 'pg_toast%'/);
});

test("MySQL tables are filtered by the database", async () => {
  const host = fakeHost({ dbType: "mysql", rows: { "table_schema = 'app'": [["produk", "BASE TABLE"]] } });
  const tables = await listTables(host, "c", "app");
  assert.match(host.calls.at(-1).sql, /table_schema = 'app'/);
  assert.deepEqual(tables, [{ name: "produk", type: "BASE TABLE", schema: "app" }]);
});

test("SQLite tables come from sqlite_master", async () => {
  const host = fakeHost({ dbType: "sqlite", rows: { sqlite_master: [["produk", "table"]] } });
  const tables = await listTables(host, "c", "main", "main");
  assert.match(host.calls.at(-1).sql, /FROM sqlite_master/);
  assert.deepEqual(tables, [{ name: "produk", type: "table", schema: "main" }]);
});

test("a quote in a schema name cannot escape the literal", async () => {
  const host = fakeHost({ dbType: "postgres", rows: {} });
  await listTables(host, "c", "app", "evil' OR 1=1 --");
  const sql = host.calls.at(-1).sql;
  assert.ok(sql.includes("table_schema = 'evil'' OR 1=1 --'"), "schema name must be a single literal");
});

test("listColumns passes database and schema to getTableMetadata", async () => {
  const host = fakeHost({ dbType: "postgres" });
  const cols = await listColumns(host, "c", "app", "produk", "public");
  assert.deepEqual(host.calls.at(-1).getTableMetadata, {
    connectionId: "c",
    database: "app",
    schema: "public",
    table: "produk",
  });
  assert.deepEqual(cols, [{ name: "id", dataType: "int", nullable: false }]);
});

test("SQLite column metadata omits database and schema identity", async () => {
  // The SQLite metadata pool is connection-scoped; sending "main" as a database
  // would ask the host for a session identity SQLite does not expose.
  const host = fakeHost({ dbType: "sqlite" });
  await listColumns(host, "c", "main", "produk", "main");
  assert.deepEqual(host.calls.at(-1).getTableMetadata, { connectionId: "c", table: "produk" });
});

test("PostgreSQL foreign keys are filtered by schema", async () => {
  const host = fakeHost({
    dbType: "postgres",
    rows: { constraint_column_usage: [["orders", "user_id", "users", "id"]] },
  });
  const fks = await listForeignKeys(host, "c", "clamav-port", "public");
  const sql = host.calls.at(-1).sql;
  assert.match(sql, /constraint_column_usage/);
  assert.match(sql, /tc\.table_schema = 'public'/);
  assert.ok(!sql.includes("'clamav-port'"), "the database name is not a schema");
  assert.deepEqual(fks, [{ table: "orders", column: "user_id", refTable: "users", refColumn: "id" }]);
});

test("the MySQL foreign-key form avoids constraint_column_usage", async () => {
  const host = fakeHost({
    dbType: "mysql",
    rows: { referenced_table_name: [["orders", "user_id", "users", "id"]] },
  });
  const fks = await listForeignKeys(host, "c", "app");
  const sql = host.calls.at(-1).sql;
  assert.ok(!sql.includes("constraint_column_usage"), "MySQL rejects that view (probe G4.1)");
  assert.match(sql, /table_schema = 'app'/);
  assert.match(sql, /referenced_table_name IS NOT NULL/);
  assert.deepEqual(fks, [{ table: "orders", column: "user_id", refTable: "users", refColumn: "id" }]);
});

test("SQLite foreign keys come from pragma_foreign_key_list", async () => {
  const host = fakeHost({
    dbType: "sqlite",
    rows: { pragma_foreign_key_list: [["orders", "user_id", "users", "id"]] },
  });
  const fks = await listForeignKeys(host, "c", "main", "main");
  const sql = host.calls.at(-1).sql;
  assert.match(sql, /pragma_foreign_key_list/);
  assert.ok(!sql.includes("information_schema"), "SQLite has no information_schema");
  assert.deepEqual(fks, [{ table: "orders", column: "user_id", refTable: "users", refColumn: "id" }]);
});

test("metadata calls fail loudly on a dialect they do not understand", async () => {
  const host = fakeHost({ dbType: "oracle" });
  await assert.rejects(() => listTables(host, "c", "app"), /not supported on oracle/);
  await assert.rejects(() => listForeignKeys(host, "c", "app"), /not supported on oracle/);
});
