// Runs the real generator against a real SQLite file, because the README claims
// SQLite support and nothing had ever executed a generated statement there.
//
//   node test/sqlite.mjs
import { execFileSync } from "node:child_process";
import { generate } from "../src/generator.js";

const DB = "/tmp/vqb-test.db";

const COLORS = "\u001b[32m"; const RED = "\u001b[31m"; const DIM = "\u001b[2m"; const OFF = "\u001b[0m";
let pass = 0, fail = 0;
const failures = [];

function sqlite(sql) {
  try {
    return { rows: execFileSync("sqlite3", ["-header", "-separator", "|", DB, sql], { encoding: "utf8" }).trim() };
  } catch (error) {
    return { error: String(error.stderr ?? error.message).trim() };
  }
}

function scenario(name, model, expectRows) {
  let sql;
  try {
    sql = generate(model, "sqlite").replace(/;\s*$/, "");
  } catch (error) {
    fail++; failures.push(`${name} -- generator threw: ${error.message}`);
    console.log(`  ${RED}FAIL${OFF}  ${name}  (generator: ${error.message})`);
    return;
  }
  const result = sqlite(sql);
  if (result.error) {
    fail++; failures.push(`${name} -- ${result.error}`);
    console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${result.error}`);
    return;
  }
  const lines = result.rows ? result.rows.split("\n").length - 1 : 0;
  if (expectRows !== undefined && lines !== expectRows) {
    fail++; failures.push(`${name} -- expected ${expectRows} rows, got ${lines}`);
    console.log(`  ${RED}FAIL${OFF}  ${name}  (expected ${expectRows} rows, got ${lines})`);
    return;
  }
  pass++;
  console.log(`  ${COLORS}PASS${OFF}  ${name}  ${DIM}${lines} row(s)${OFF}`);
}

const kategori = { id: "k", name: "kategori" };
const produk = { id: "p", name: "produk" };
const base = () => ({ tables: [kategori, produk] });
const onKategoriId = { leftColumn: "kategori_id", rightColumn: "id" };

console.log("\nSQLite dialect -- generated SQL executed against /tmp/vqb-test.db\n");

scenario("SELECT * from one table", { tables: [produk] }, 5);

scenario("DISTINCT with ORDER BY and LIMIT", {
  tables: [produk],
  distinct: true,
  select: [{ tableId: "p", column: "kategori_id" }],
  orderBy: [{ tableId: "p", column: "kategori_id", direction: "ASC" }],
  limit: 2,
}, 2);

scenario("COUNT(*) with GROUP BY and HAVING", {
  tables: [produk],
  select: [
    { tableId: "p", column: "kategori_id" },
    { tableId: "p", column: "id", aggregate: "COUNT", alias: "n" },
  ],
  groupBy: [{ tableId: "p", column: "kategori_id" }],
  having: [{ tableId: "p", column: "id", aggregate: "COUNT", operator: ">", value: 1 }],
  orderBy: [{ tableId: "p", column: "kategori_id", direction: "ASC" }],
}, 2);

scenario("INNER JOIN on a real foreign key", {
  ...base(),
  select: [{ tableId: "k", column: "nama", alias: "kategori" }, { tableId: "p", column: "nama" }],
  joins: [{ type: "INNER", leftTableId: "p", rightTableId: "k", conditions: [onKategoriId] }],
}, 5);

scenario("LEFT JOIN keeps products whose category does not exist", {
  ...base(),
  select: [{ tableId: "p", column: "nama" }],
  joins: [{ type: "LEFT", leftTableId: "p", rightTableId: "k", conditions: [onKategoriId] }],
  filters: [{ tableId: "k", column: "id", operator: "IS NULL" }],
}, 0);


scenario("IS NULL filter", {
  tables: [produk],
  filters: [{ tableId: "p", column: "discontinued_at", operator: "IS NULL" }],
}, 4);

scenario("BETWEEN on a numeric range", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "harga", operator: "BETWEEN", value: [3000, 4000] }],
  orderBy: [{ tableId: "p", column: "harga", direction: "ASC" }],
}, 3);

scenario("IN list of strings", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "nama", operator: "IN", value: ["Teh Botol", "Kopi Kapal"] }],
}, 2);

scenario("LIKE with a wildcard (only Aqua Botol starts with A)", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "nama", operator: "LIKE", value: "A%" }],
}, 1);

scenario("RIGHT JOIN (SQLite has it from 3.39)", {
  ...base(),
  select: [{ tableId: "k", column: "nama" }],
  joins: [{ type: "RIGHT", leftTableId: "p", rightTableId: "k", conditions: [onKategoriId] }],
}, 5);

scenario("an injected literal stays a value, not syntax", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "nama", operator: "=", value: "x' OR '1'='1" }],
}, 0);

scenario("a literal containing a quote round-trips", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "nama", operator: "=", value: "O'Brien" }],
}, 0);

scenario("a unicode literal round-trips", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "nama", operator: "=", value: "数据😀" }],
}, 0);

scenario("IS NOT NULL filter", {
  tables: [produk],
  select: [{ tableId: "p", column: "nama" }],
  filters: [{ tableId: "p", column: "discontinued_at", operator: "IS NOT NULL" }],
  orderBy: [{ tableId: "p", column: "nama", direction: "ASC" }],
}, 1);

// The generated statement must never be able to write.
console.log("\n  write attempts must be refused by SQLite's own read path\n");
for (const [name, sql] of [
  ["DROP TABLE", "DROP TABLE produk"],
  ["DELETE", "DELETE FROM produk"],
  ["UPDATE", "UPDATE produk SET nama='x'"],
  ["INSERT", "INSERT INTO produk VALUES (9,1,'x',1,1,NULL)"],
]) {
  const r = sqlite(`PRAGMA query_only=ON; ${sql};`);
  const refused = /readonly|not authorized|attempt to write|query_only/i.test(r.error ?? "");
  if (refused) { pass++; console.log(`  ${COLORS}PASS${OFF}  ${name} refused`); }
  else if (r.error) { pass++; console.log(`  ${COLORS}PASS${OFF}  ${name} errored: ${r.error.split("\n")[0]}`); }
  else { fail++; failures.push(`${name} was NOT refused`); console.log(`  ${RED}FAIL${OFF}  ${name} was NOT refused`); }
}

// And the table must be untouched afterwards.
const after = sqlite("SELECT count(*) FROM produk");
console.log(`\n  products still present after the write attempts: ${after.rows}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);