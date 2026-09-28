import { test } from "node:test";
import assert from "node:assert/strict";
import { listDatabases, listTables, listForeignKeys, listColumns } from "../src/metadata.js";

// A stand-in for the host bridge, shaped like the one DBX actually hands a
// plugin opened from a table context-menu: the context has no `dbType`, and
// `queryData` responses carry it instead.
function fakeHost({ dbType = "mysql", rows = {} } = {}) {
  const calls = [];
  return {
    dialect: undefined,
    calls,
    async queryData({ sql, database }) {
      calls.push({ sql, database });
      for (const [fragment, value] of Object.entries(rows)) {
        if (sql.includes(fragment)) return { dbType, columns: [{ name: "x" }], rows: value, truncated: false, elapsedMs: 1 };
      }
      return { dbType, columns: [], rows: [], truncated: false, elapsedMs: 1 };
    },
    async getTableMetadata() {
      return {
        columns: [{ name: "id", dataType: "int", nullable: false }],
        fieldCapabilities: { precision: "supported" },
      };
    },
  };
}

test("listDatabases learns the dialect from the response when context lacks it", async () => {
  // This is the bug: a table context-menu invocation has no dbType, so the
  // first query is the only place the dialect can come from.
  const host = fakeHost({ dbType: "mysql", rows: { schemata: [["a"], ["b"]] } });
  assert.equal(host.dialect, undefined);
  const dbs = await listDatabases(host, "conn-1");
  assert.deepEqual(dbs, ["a", "b"]);
  assert.equal(host.dialect, "mysql");
});

test("the PostgreSQL form is used when the dialect is not MySQL", async () => {
  const host = fakeHost({ dbType: "postgres", rows: { "FOREIGN KEY": [["orders", "user_id", "users", "id"]] } });
  await listDatabases(host, "c");
  await listForeignKeys(host, "c", "app");
  const fkSql = host.calls.at(-1).sql;
  assert.ok(fkSql.includes("constraint_column_usage"), "postgres must use constraint_column_usage");
  assert.ok(fkSql.includes("referential_constraints") === false);
});

test("the MySQL form avoids constraint_column_usage", async () => {
  const host = fakeHost({ dbType: "mysql", rows: { referenced_table_name: [["orders", "user_id", "users", "id"]] } });
  await listDatabases(host, "c");
  const fks = await listForeignKeys(host, "c", "app");
  const fkSql = host.calls.at(-1).sql;
  assert.ok(!fkSql.includes("constraint_column_usage"), "MySQL rejects that view (probe G4.1)");
  assert.ok(fkSql.includes("referenced_table_name IS NOT NULL"));
  assert.deepEqual(fks, [{ table: "orders", column: "user_id", refTable: "users", refColumn: "id" }]);
});

test("listTables filters by the requested database", async () => {
  const host = fakeHost({ dbType: "mysql", rows: { "table_schema = 'praktikum-basis-data'": [["produk", "BASE TABLE"]] } });
  await listDatabases(host, "c");
  const tables = await listTables(host, "c", "praktikum-basis-data");
  const sql = host.calls.at(-1).sql;
  assert.ok(sql.includes("table_schema = 'praktikum-basis-data'"), "must not return every database's tables");
  assert.ok(sql.includes("table_type IN ('BASE TABLE', 'VIEW')"));
  assert.deepEqual(tables, [{ name: "produk", type: "BASE TABLE" }]);
});

test("a quote in a database name cannot escape the literal", async () => {
  const host = fakeHost({ dbType: "mysql", rows: {} });
  await listDatabases(host, "c");
  await listTables(host, "c", "evil' OR 1=1 --");
  const sql = host.calls.at(-1).sql;
  assert.ok(sql.includes("table_schema = 'evil'' OR 1=1 --'"), "database name must be a single literal");
  assert.equal(sql.split("'").length - 1, 8, "quote count must stay balanced around two literals plus the type filter");
});

test("metadata calls fail loudly when the dialect is still unknown", async () => {
  const host = fakeHost();
  await assert.rejects(() => listTables(host, "c", "app"), /dialect is not known/);
});

test("listColumns returns name, type and nullability", async () => {
  const host = fakeHost();
  const cols = await listColumns(host, "c", "app", "produk");
  assert.deepEqual(cols, [{ name: "id", dataType: "int", nullable: false }]);
});
