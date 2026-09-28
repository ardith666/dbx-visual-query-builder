import { test } from "node:test";
import assert from "node:assert/strict";
import { resultHeaders } from "../src/headers.js";

test("a unique column name is left alone", () => {
  const out = resultHeaders(["id", "nama"], [{ tableName: "users", column: "id" }, { tableName: "users", column: "nama" }]);
  assert.deepEqual(out, ["id", "nama"]);
});

test("duplicate unaliased names get their source table", () => {
  // The exact case from praktikum-basis-data: `nama` on three tables.
  const select = [
    { tableName: "jenis_produk", column: "nama" },
    { tableName: "tenant", column: "nama" },
    { tableName: "produk", column: "nama" },
  ];
  const out = resultHeaders(["nama", "nama", "nama"], select);
  assert.deepEqual(out, ["nama · jenis_produk", "nama · tenant", "nama · produk"]);
});

test("an alias disambiguates, so no table suffix is added", () => {
  const select = [
    { tableName: "jenis_produk", column: "nama", alias: "jenis" },
    { tableName: "tenant", column: "nama", alias: "tenant_nama" },
  ];
  const out = resultHeaders(["jenis", "tenant_nama"], select);
  assert.deepEqual(out, ["jenis", "tenant_nama"]);
});

test("only the colliding columns are suffixed, not the whole row", () => {
  const select = [
    { tableName: "a", column: "nama" },
    { tableName: "b", column: "nama" },
    { tableName: "b", column: "id" },
  ];
  const out = resultHeaders(["nama", "nama", "id"], select);
  assert.deepEqual(out, ["nama · a", "nama · b", "id"]);
});

test("a partial collision suffixes both sides of that name", () => {
  // `id` appears once in SELECT but the table also has a PK `id` elsewhere:
  // only the two `nama` columns should be touched.
  const select = [
    { tableName: "orders", column: "nama" },
    { tableName: "customers", column: "nama" },
  ];
  const out = resultHeaders(["nama", "nama", "total"], [...select, { tableName: "orders", column: "total" }]);
  assert.equal(out[2], "total");
  assert.ok(out[0].includes("orders"));
});

test("more result columns than select items still renders", () => {
  // Aggregates or driver-side renaming can shift the mapping; never throw.
  const out = resultHeaders(["a", "b", "c", "d"], [{ tableName: "t", column: "a" }]);
  assert.equal(out.length, 4);
  assert.equal(out[0], "a");
});

test("no select list is tolerated", () => {
  assert.deepEqual(resultHeaders(["x", "y"], []), ["x", "y"]);
  assert.deepEqual(resultHeaders(["x", "y"], undefined), ["x", "y"]);
});

test("an aggregate is labelled by its plain column name", () => {
  const select = [
    { tableName: "orders", column: "total", aggregate: "SUM", alias: "revenue" },
  ];
  assert.deepEqual(resultHeaders(["revenue"], select), ["revenue"]);
});

test("a missing tableName degrades to the bare name", () => {
  const out = resultHeaders(["nama", "nama"], [{ column: "nama" }, { column: "nama" }]);
  assert.deepEqual(out, ["nama", "nama"]);
});
