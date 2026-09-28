import { test } from "node:test";
import assert from "node:assert/strict";
import { joinForForeignKey, missingJoins, activeRelations, tableName, tidyLayout } from "../src/relationships.js";

const fks = [
  { table: "produk_jenis_produk", column: "jenis_produk_id", refTable: "jenis_produk", refColumn: "id" },
  { table: "produk_jenis_produk", column: "produk_id", refTable: "produk", refColumn: "id" },
  { table: "produk_jenis_produk", column: "tenant_id", refTable: "tenant", refColumn: "id" },
];

const both = {
  tables: [
    { id: "pjp", name: "produk_jenis_produk" },
    { id: "jp", name: "jenis_produk" },
  ],
  joins: [],
  select: [],
};

test("an FK between two present tables yields a join", () => {
  const j = joinForForeignKey(both, fks[0]);
  assert.equal(j.type, "LEFT");
  assert.equal(j.leftTableId, "pjp");
  assert.equal(j.rightTableId, "jp");
  assert.deepEqual(j.conditions, [{ leftColumn: "jenis_produk_id", rightColumn: "id" }]);
});

test("an FK whose second table is absent yields nothing", () => {
  const solo = { tables: [{ id: "pjp", name: "produk_jenis_produk" }], joins: [], select: [] };
  assert.equal(joinForForeignKey(solo, fks[0]), null);
});

test("a self-referencing foreign key yields nothing", () => {
  const selfFk = [{ table: "employee", column: "manager_id", refTable: "employee", refColumn: "id" }];
  const model = { tables: [{ id: "e", name: "employee" }], joins: [], select: [] };
  assert.equal(joinForForeignKey(model, selfFk[0]), null);
});

test("missingJoins lists FK joins not already in the model", () => {
  const out = missingJoins(both, fks);
  assert.deepEqual(out.map((j) => j.key), ["produk_jenis_produk.jenis_produk"]);
});

test("an auto-joined pair is not offered again", () => {
  const joined = {
    ...both,
    joins: [{ leftTableId: "pjp", rightTableId: "jp", type: "LEFT", conditions: [] }],
  };
  assert.deepEqual(missingJoins(joined, fks), []);
});

test("three related tables all get auto-joined", () => {
  const three = {
    tables: [
      { id: "pjp", name: "produk_jenis_produk" },
      { id: "jp", name: "jenis_produk" },
      { id: "tn", name: "tenant" },
    ],
    joins: [],
    select: [],
  };
  assert.equal(missingJoins(three, fks).length, 2);
});

test("unrelated tables never get a join, however many columns they share", () => {
  const unrelated = {
    tables: [{ id: "a", name: "orders" }, { id: "b", name: "customers" }],
    joins: [],
    select: [],
  };
  assert.deepEqual(missingJoins(unrelated, fks), []);
});

test("selecting the child FK column lights the relation", () => {
  const model = {
    ...both,
    select: [{ tableId: "pjp", column: "jenis_produk_id" }],
  };
  assert.ok(activeRelations(model, fks).has("produk_jenis_produk->jenis_produk"));
});

test("selecting the parent PK column lights the same relation", () => {
  const model = { ...both, select: [{ tableId: "jp", column: "id" }] };
  assert.ok(activeRelations(model, fks).has("produk_jenis_produk->jenis_produk"));
});

test("selecting an unrelated column lights nothing", () => {
  const model = { ...both, select: [{ tableId: "pjp", column: "qty" }] };
  assert.equal(activeRelations(model, fks).size, 0);
});

test("tableName resolves an id and tolerates an unknown one", () => {
  assert.equal(tableName(both, "jp"), "jenis_produk");
  assert.equal(tableName(both, "nope"), "");
});

const GEO = { cardW: 208, gapX: 90, gapY: 200, viewportW: 1000 };

test("tidy produces one slot per table", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 9, 12]) {
    assert.equal(tidyLayout(n, GEO).length, n, `n=${n}`);
  }
});

test("tidy keeps every table inside the viewport width", () => {
  const slots = tidyLayout(4, GEO);
  for (const s of slots) {
    assert.ok(s.x >= 0, "no negative x");
    assert.ok(s.x + GEO.cardW <= GEO.viewportW, `card overflows: ${s.x} + ${GEO.cardW}`);
  }
});

test("tidy centres the grid", () => {
  // 2 columns => width 208*2 + 90 = 506, viewport 1000 => origin x = 247.
  const slots = tidyLayout(4, GEO);
  assert.equal(slots[0].x, 247);
  assert.equal(slots[1].x, 247 + 208 + 90);
  assert.equal(slots[2].y, slots[0].y + GEO.gapY);
});

test("tidy never stacks two tables at the same spot", () => {
  const slots = tidyLayout(9, GEO);
  assert.equal(new Set(slots.map((s) => `${s.x},${s.y}`)).size, 9);
});

test("tidy falls back to a left origin when the grid is wider than the viewport", () => {
  const slots = tidyLayout(25, { ...GEO, viewportW: 300 });
  assert.equal(slots[0].x, 0);
  assert.ok(slots.every((s) => s.x >= 0));
});

test("tidy of one table is centred", () => {
  const slots = tidyLayout(1, GEO); // 208 wide in 1000 => x = 396
  assert.equal(slots[0].x, 396);
});

// --- cardinality ---------------------------------------------------------------
import { edgeLabels } from "../src/relationships.js";

const fkSimple = [
  { table: "orders", column: "user_id", refTable: "users", refColumn: "id" },
];

test("a plain foreign key is N:1 (parent labelled 1, child N)", () => {
  const label = edgeLabels(fkSimple);
  assert.deepEqual(label(fkSimple[0]), { parent: "1", child: "N" });
});

test("a junction table reads as M:N", () => {
  // order_items references both orders and products, and nothing references
  // it -- that is the textbook junction.
  const fks = [
    { table: "order_items", column: "order_id", refTable: "orders", refColumn: "id" },
    { table: "order_items", column: "product_id", refTable: "products", refColumn: "id" },
  ];
  const label = edgeLabels(fks);
  assert.deepEqual(label(fks[0]), { parent: "M", child: "N" });
});

test("a table that others reference is never treated as a junction", () => {
  // users is referenced by orders, so it is not a bridge even with two outgoing FKs.
  const fks = [
    { table: "users", column: "org_id", refTable: "orgs", refColumn: "id" },
    { table: "users", column: "team_id", refTable: "teams", refColumn: "id" },
    { table: "orders", column: "user_id", refTable: "users", refColumn: "id" },
  ];
  const label = edgeLabels(fks);
  assert.deepEqual(label(fks[0]), { parent: "1", child: "N" });
});
