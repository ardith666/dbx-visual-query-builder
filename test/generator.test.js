import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/generator.js";

const users = { id: "u", name: "users" };
const orders = { id: "o", name: "orders", alias: "ord" };

// Condition shape follows PRD §10.3: a join condition names columns only, the
// tables come from the join's own leftTableId / rightTableId.
const onUserId = { leftColumn: "id", rightColumn: "user_id" };

const twoTable = {
  tables: [users, orders],
  select: [
    { tableId: "u", column: "id" },
    { tableId: "o", column: "total", alias: "amount" },
  ],
  joins: [
    {
      type: "LEFT",
      leftTableId: "u",
      rightTableId: "o",
      conditions: [onUserId],
    },
  ],
};

test("bare table selects *", () => {
  assert.equal(generate({ tables: [users] }, "postgres"), 'SELECT *\nFROM "users";');
});

test("two tables with a LEFT JOIN and an alias", () => {
  assert.equal(
    generate(twoTable, "postgres"),
    [
      'SELECT "users"."id", "ord"."total" AS "amount"',
      'FROM "users"',
      'LEFT JOIN "orders" AS "ord" ON "users"."id" = "ord"."user_id";',
    ].join("\n"),
  );
});

test("MySQL uses backticks throughout", () => {
  assert.equal(
    generate(twoTable, "mysql"),
    [
      "SELECT `users`.`id`, `ord`.`total` AS `amount`",
      "FROM `users`",
      "LEFT JOIN `orders` AS `ord` ON `users`.`id` = `ord`.`user_id`;",
    ].join("\n"),
  );
});

test("DISTINCT and aggregates", () => {
  const model = {
    tables: [users],
    distinct: true,
    select: [
      { tableId: "u", column: "status" },
      { tableId: "u", column: "id", aggregate: "COUNT", alias: "n" },
    ],
    groupBy: [{ tableId: "u", column: "status" }],
    having: [{ tableId: "u", column: "id", aggregate: "COUNT", operator: ">", value: 3 }],
  };
  assert.equal(
    generate(model, "postgres"),
    [
      'SELECT DISTINCT "users"."status", COUNT("users"."id") AS "n"',
      'FROM "users"',
      'GROUP BY "users"."status"',
      'HAVING COUNT("users"."id") > 3;',
    ].join("\n"),
  );
});

test("COUNT(*) is allowed to take a star", () => {
  const model = {
    tables: [users],
    select: [{ tableId: "u", column: "*", aggregate: "COUNT" }],
  };
  assert.equal(generate(model, "postgres"), 'SELECT COUNT(*)\nFROM "users";');
});

test("an aggregate other than COUNT cannot take a star", () => {
  const model = { tables: [users], select: [{ tableId: "u", column: "*", aggregate: "SUM" }] };
  assert.throws(() => generate(model, "postgres"), /SUM\(\*\) is not valid SQL/);
});

test("filters join with AND then OR, first row never has a leading connector", () => {
  const model = {
    tables: [users],
    filters: [
      { tableId: "u", column: "status", operator: "=", value: "active" },
      { tableId: "u", column: "age", operator: ">", value: 17, connector: "AND" },
      { tableId: "u", column: "name", operator: "LIKE", value: "A%", connector: "OR" },
    ],
  };
  assert.equal(
    generate(model, "postgres"),
    [
      `SELECT *`,
      `FROM "users"`,
      `WHERE "users"."status" = 'active'`,
      `  AND "users"."age" > 17`,
      `  OR "users"."name" LIKE 'A%';`,
    ].join("\n"),
  );
});

test("IS NULL and IS NOT NULL take no value", () => {
  const model = {
    tables: [users],
    filters: [
      { tableId: "u", column: "deleted_at", operator: "IS NULL" },
      { tableId: "u", column: "email", operator: "IS NOT NULL" },
    ],
  }
  assert.match(generate(model, "postgres"), /WHERE "users"\."deleted_at" IS NULL/);
  assert.match(generate(model, "postgres"), /AND "users"\."email" IS NOT NULL;/);
});

test("BETWEEN and IN render their value lists", () => {
  const between = {
    tables: [users],
    filters: [{ tableId: "u", column: "age", operator: "BETWEEN", value: [18, 65] }],
  };
  assert.match(generate(between, "postgres"), /BETWEEN 18 AND 65;/);

  const inList = {
    tables: [users],
    filters: [{ tableId: "u", column: "status", operator: "IN", value: ["paid", "shipped"] }],
  };
  assert.match(generate(inList, "postgres"), /IN \('paid', 'shipped'\);/);
});

test("ORDER BY multi-column and LIMIT", () => {
  const model = {
    tables: [users],
    orderBy: [
      { tableId: "u", column: "status", direction: "ASC" },
      { tableId: "u", column: "id", direction: "DESC" },
    ],
    limit: 50,
  };
  assert.match(generate(model, "postgres"), /ORDER BY "users"\."status" ASC, "users"\."id" DESC/);
  assert.match(generate(model, "postgres"), /LIMIT 50;$/);
});

test("a join without an ON condition is rejected", () => {
  const model = {
    tables: [users, orders],
    joins: [{ type: "INNER", leftTableId: "u", rightTableId: "o", conditions: [] }],
  };
  assert.throws(() => generate(model, "postgres"), /needs at least one ON condition/);
});

test("a joined table is emitted once, never twice in FROM", () => {
  const sql = generate(twoTable, "postgres");
  assert.equal(sql.match(/FROM/g).length, 1);
  assert.equal(sql.match(/JOIN/g).length, 1);
});

test("a self-join on the same table id is rejected", () => {
  const model = {
    tables: [users, orders],
    joins: [{ type: "INNER", leftTableId: "u", rightTableId: "u", conditions: [onUserId] }],
  };
  assert.throws(() => generate(model, "postgres"), /same table on both sides/);
});

test("CROSS JOIN needs no ON and refuses one", () => {
  const ok = { tables: [users, orders], joins: [{ type: "CROSS", leftTableId: "u", rightTableId: "o" }] };
  assert.match(generate(ok, "postgres"), /CROSS JOIN "orders" AS "ord";/);

  const bad = {
    tables: [users, orders],
    joins: [
      {
        type: "CROSS",
        leftTableId: "u",
        rightTableId: "o",
        conditions: [onUserId],
      },
    ],
  };
  assert.throws(() => generate(bad, "postgres"), /CROSS JOIN cannot carry an ON condition/);
});

test("a dangling table reference is rejected, never silently resolved", () => {
  const model = {
    tables: [users],
    select: [{ tableId: "gone", column: "id" }],
  };
  assert.throws(() => generate(model, "postgres"), /references unknown table: gone/);
});

test("an unknown dialect is rejected before any SQL is produced", () => {
  assert.throws(() => generate({ tables: [users] }, "oracle"), /unsupported dialect: oracle/);
});

test("LIMIT is refused on a dialect that has none", () => {
  // Prevents silently emitting SQL the database cannot parse.
  const model = { tables: [users], limit: 10 };
  assert.throws(() => generate(model, "mssql"), /unsupported dialect/);
});

test("an unknown operator is rejected", () => {
  const model = { tables: [users], filters: [{ tableId: "u", column: "a", operator: "DROP", value: 1 }] };
  assert.throws(() => generate(model, "postgres"), /unknown operator: DROP/);
});

test("a null filter value renders as NULL, not an empty literal", () => {
  const model = { tables: [users], filters: [{ tableId: "u", column: "deleted_at", operator: "=", value: null }] };
  assert.match(generate(model, "postgres"), /= NULL;/);
});

test("an injected value stays a single literal in generated SQL", () => {
  const model = {
    tables: [users],
    filters: [{ tableId: "u", column: "name", operator: "=", value: "x\\' OR 1=1 --" }],
  };
  const sql = generate(model, "mysql");
  assert.match(sql, /WHERE `users`\.`name` = 'x\\\\'' OR 1=1 --';/);
  // The statement must still be a single SELECT: one FROM, one terminator.
  assert.equal(sql.match(/FROM/g).length, 1);
  assert.equal(sql.match(/;/g).length, 1);
  assert.equal(sql.includes("UNION"), false);
});

test("a value that looks like a column name cannot become one", () => {
  const model = {
    tables: [users],
    filters: [{ tableId: "u", column: "name", operator: "=", value: "id" }],
  };
  assert.match(generate(model, "postgres"), /"users"\."name" = 'id';/);
});

// --- FROM-table selection -----------------------------------------------------
// Regression: the real failure was
//   FROM `jenis_produk` LEFT JOIN `jenis_produk` ON ... `produk_jenis_produk`...
// -> "Not unique table/alias" plus a table that never appeared in FROM.
const junction = { id: "pjp", name: "produk_jenis_produk" };
const child = { id: "jp", name: "jenis_produk" };
const tn = { id: "tn", name: "tenant" };
const prod = { id: "pr", name: "produk" };

const starModel = {
  tables: [junction, child, tn, prod],
  joins: [
    { type: "LEFT", leftTableId: "pjp", rightTableId: "jp", conditions: [{ leftColumn: "jenis_produk_id", rightColumn: "id" }] },
    { type: "LEFT", leftTableId: "pjp", rightTableId: "tn", conditions: [{ leftColumn: "tenant_id", rightColumn: "id" }] },
    { type: "LEFT", leftTableId: "pjp", rightTableId: "pr", conditions: [{ leftColumn: "produk_id", rightColumn: "id" }] },
  ],
  select: [
    { tableId: "jp", column: "nama" },
    { tableId: "tn", column: "nama" },
    { tableId: "pr", column: "nama" },
  ],
};

test("the join child becomes FROM, not the first table added", () => {
  const sql = generate(starModel, "mysql");
  assert.match(sql, /FROM `produk_jenis_produk`/);
  // No table may appear twice, which is what "Not unique table/alias" means.
  const names = [...sql.matchAll(/(?:FROM|JOIN) `([^`]+)`/g)].map((m) => m[1]);
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4, `duplicate table in: ${names.join(", ")}`);
});

test("every table in the model is reached exactly once", () => {
  const sql = generate(starModel, "mysql");
  for (const name of ["produk_jenis_produk", "jenis_produk", "tenant", "produk"]) {
    assert.ok(sql.includes(`\`${name}\``), `${name} missing from SQL`);
  }
});

test("the same model works whatever order the tables were added in", () => {
  const shuffled = { ...starModel, tables: [prod, tn, child, junction] };
  const a = generate(starModel, "mysql");
  const b = generate(shuffled, "mysql");
  assert.equal(a, b, "table order must not change the SQL");
});

test("a table that is never joined is rejected instead of silently dropped", () => {
  // One table, no joins: valid.
  const single = { tables: [child], joins: [], select: [{ tableId: "jp", column: "nama" }] };
  assert.match(generate(single, "mysql"), /FROM `jenis_produk`/);

  // Two tables but only an invalid self-join: reports the self-join.
  const half = {
    tables: [child, prod],
    joins: [{ type: "INNER", leftTableId: "jp", rightTableId: "jp", conditions: [{ leftColumn: "id", rightColumn: "id" }] }],
  };
  assert.throws(() => generate(half, "mysql"), /same table on both sides/);
});

test("a table with no path from the FROM table is rejected", () => {
  // jenis_produk -> tenant is a join, but `produk` is never attached.
  const stranded = {
    tables: [child, tn, prod],
    joins: [{ type: "LEFT", leftTableId: "jp", rightTableId: "tn", conditions: [{ leftColumn: "id", rightColumn: "id" }] }],
  };
  assert.throws(() => generate(stranded, "mysql"), /"produk" is never joined/);
});

test("a disconnected join is rejected", () => {
  const model = {
    tables: [child, tn, prod],
    joins: [
      { type: "LEFT", leftTableId: "jp", rightTableId: "tn", conditions: [{ leftColumn: "id", rightColumn: "id" }] },
      { type: "LEFT", leftTableId: "pr", rightTableId: "pr", conditions: [{ leftColumn: "id", rightColumn: "id" }] },
    ],
  };
  assert.throws(() => generate(model, "mysql"), /same table on both sides|not connected/);
});

test("two tables with the same name and no alias are rejected", () => {
  const model = { tables: [{ id: "a", name: "t" }, { id: "b", name: "t" }] };
  assert.throws(() => generate(model, "mysql"), /share the name "t"/);
});

test("an alias resolves the duplicate name", () => {
  const model = {
    tables: [{ id: "a", name: "t" }, { id: "b", name: "t", alias: "t2" }],
    joins: [{ type: "LEFT", leftTableId: "a", rightTableId: "b", conditions: [{ leftColumn: "id", rightColumn: "id" }] }],
    select: [{ tableId: "a", column: "id" }],
  };
  assert.match(generate(model, "mysql"), /FROM `t`\nLEFT JOIN `t` AS `t2`/);
});
