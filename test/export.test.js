import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCsv, toXlsx, toPdf } from "../src/export.js";

const columns = [{ name: "nama" }, { name: "qty" }];
const rows = [
  ["Makanan, berat", 3],
  ["O'Brien", 10],
  [null, 0],
  ["数据😀", 7],
];

const dir = mkdtempSync(join(tmpdir(), "vqb-export-"));
const save = (name, bytes) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

// --- CSV ---------------------------------------------------------------------

test("CSV quotes delimiters, quotes and newlines, and keeps NULL empty", () => {
  const csv = toCsv(columns, rows, { bom: false });
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "nama,qty");
  assert.equal(lines[1], '"Makanan, berat",3', "a comma forces quoting");
  assert.equal(lines[2], "O'Brien,10", "an apostrophe needs no quoting in CSV");
  assert.equal(lines[3], ",0", "NULL becomes an empty field, not the text NULL");
  assert.equal(lines[4], "数据😀,7");
});

test("CSV starts with a BOM so Excel reads UTF-8", () => {
  assert.equal(toCsv(columns, rows)[0], "\uFEFF");
});

test("CSV quotes only what RFC 4180 requires", () => {
  const csv = toCsv([{ name: "c" }], [["'"], ['"'], ["a\nb"], ["plain"]], { bom: false });
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[1], "'", "a bare apostrophe is a literal, not a delimiter");
  assert.equal(lines[2], '""""', "a double quote is doubled and wrapped");
  assert.equal(lines[3], '"a\nb"', "an embedded newline is quoted");
  assert.equal(lines[4], "plain");
});

// --- XLSX --------------------------------------------------------------------

test("XLSX is a real ZIP that unzip can read", () => {
  const path = save("out.xlsx", toXlsx(columns, rows));
  const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
  assert.ok(listing.includes("[Content_Types].xml"));
  assert.ok(listing.includes("xl/workbook.xml"));
  assert.ok(listing.includes("xl/worksheets/sheet1.xml"));
  assert.ok(listing.includes("_rels/.rels"));
  execFileSync("unzip", ["-t", path], { encoding: "utf8" });
});

test("XLSX sheet contains the header and every row", () => {
  const path = save("rows.xlsx", toXlsx(columns, rows));
  const xml = execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.ok(xml.includes(">nama<"), "header cell");
  assert.ok(xml.includes(">Makanan, berat<") || xml.includes(">Makanan, berat<"), "row 1 data");
  assert.ok(xml.includes("O&apos;Brien"), "apostrophe escaped in XML");
  assert.ok(xml.includes("数据😀"), "unicode survives as UTF-8");
  assert.equal((xml.match(/<row /g) ?? []).length, rows.length + 1, "header + 4 data rows");
});

test("XLSX writes numbers as numbers, not text", () => {
  const path = save("nums.xlsx", toXlsx([{ name: "n" }], [[42], [3.5]]));
  const xml = execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.ok(xml.includes("<v>42</v>"));
  assert.ok(xml.includes("<v>3.5</v>"));
});

test("XLSX column letters roll over from Z to AA", () => {
  const wide = Array.from({ length: 28 }, (_, i) => ({ name: `c${i}` }));
  const path = save("wide.xlsx", toXlsx(wide, [["v"]]));
  const xml = execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.ok(xml.includes('r="A1"'));
  assert.ok(xml.includes('r="Z1"'));
  assert.ok(xml.includes('r="AA1"'));
});

test("XLSX escapes XML metacharacters in user data", () => {
  const path = save("esc.xlsx", toXlsx([{ name: "a&b<c>" }], [["<tag> & \"q\""]]));
  const xml = execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.ok(xml.includes("a&amp;b&lt;c&gt;"));
  assert.ok(xml.includes("&lt;tag&gt;"));
  assert.ok(!xml.includes("<tag>"));
});

// --- PDF ---------------------------------------------------------------------

test("PDF is a valid document with a correct xref offset", () => {
  const { bytes, pages } = toPdf(columns, rows);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.equal(pages, 1);

  const startxref = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
  // The offset must be a BYTE offset, which is why the writer never measures a
  // JS string. This is the check that catches a regression there.
  assert.equal(
    text.slice(startxref, startxref + 4),
    "xref",
    "startxref must land exactly on the xref table",
  );
});

test("PDF byte offsets stay correct with non-ASCII text", () => {
  // The middle-dot bug: a JS string length is UTF-16 units, UTF-8 bytes are
  // not, so every offset after a non-ASCII char was wrong.
  const { bytes } = toPdf([{ name: "nama" }], [["数据"], ["Makanan"], ["Perawatan"]]);
  const text = Buffer.from(bytes).toString("latin1");
  const startxref = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
});

test("PDF /Length matches the actual stream length", () => {
  const { bytes } = toPdf(columns, rows, { rowsPerPage: 2 });
  const text = Buffer.from(bytes).toString("latin1");
  const match = /<< \/Length (\d+) >>\s*stream\n/.exec(text);
  assert.ok(match, "a content stream dictionary exists");
  const declared = Number(match[1]);
  const start = match.index + match[0].length;
  const end = text.indexOf("\nendstream", start);
  assert.equal(Buffer.byteLength(text.slice(start, end), "latin1"), declared, "/Length must be exact or readers reject the file");
});

test("PDF paginates long results", () => {
  const many = Array.from({ length: 100 }, (_, i) => [`row ${i}`, i]);
  const { pages } = toPdf(columns, many, { rowsPerPage: 45 });
  assert.equal(pages, 3);
  const text = Buffer.from(toPdf(columns, many, { rowsPerPage: 45 }).bytes).toString("latin1");
  assert.equal((text.match(/\/Type \/Page[^s]/g) ?? []).length, 3);
});

test("PDF reports characters it cannot encode instead of hiding them", () => {
  const { lost } = toPdf(columns, [["数据😀", 1]]);
  // Two CJK chars plus the emoji cannot be represented in WinAnsi.
  assert.ok(lost >= 2, `expected lost>=2, got ${lost}`);
  const clean = toPdf(columns, [["plain ascii", 1]]);
  assert.equal(clean.lost, 0);
});

test("PDF escapes parentheses and backslashes in data", () => {
  const text = Buffer.from(toPdf([{ name: "a" }], [["(paren) \\ backslash"]]).bytes).toString("latin1");
  assert.ok(text.includes("\\(paren\\)"), "parens escaped so they do not end the string");
  assert.ok(text.includes("\\\\ backslash"));
});

test("PDF of an empty result still produces one readable page", () => {
  const { pages, bytes } = toPdf(columns, []);
  assert.equal(pages, 1);
  assert.ok(Buffer.from(bytes).toString("latin1").includes("/Type /Catalog"));
});

test("every exporter is byte-deterministic", () => {
  assert.deepEqual(toXlsx(columns, rows), toXlsx(columns, rows));
  assert.equal(toCsv(columns, rows), toCsv(columns, rows));
  assert.deepEqual(toPdf(columns, rows).bytes, toPdf(columns, rows).bytes);
  void readFileSync;
});

// --- Diagram print document --------------------------------------------------
import { diagramHtml } from "../src/export.js";

const tables = [
  { id: "pjp", name: "produk_jenis_produk", columns: [{ name: "produk_id", dataType: "int" }, { name: "tenant_id", dataType: "int" }] },
  { id: "jp", name: "jenis_produk", columns: [{ name: "id", dataType: "int" }, { name: "nama", dataType: "varchar(255)" }] },
];
const pos = { pjp: { x: 20, y: 30 }, jp: { x: 330, y: 30 } };
const edges = [{ child: tables[0], parent: tables[1], from: "1", to: "N" }];

test("diagram HTML is a complete standalone document", () => {
  const html = diagramHtml({ tables, pos, edges, title: "Test" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("</html>"));
  assert.ok(html.includes("<title>Test</title>"));
});

test("diagram HTML includes every table and column", () => {
  const html = diagramHtml({ tables, pos, edges });
  for (const t of tables) assert.ok(html.includes(t.name), `${t.name} missing`);
  assert.ok(html.includes("produk_id"));
  assert.ok(html.includes("varchar(255)"));
});

test("diagram HTML draws an edge with both cardinality labels", () => {
  const html = diagramHtml({ tables, pos, edges });
  assert.ok(html.includes("<path d=\"M"), "a curve is drawn");
  assert.ok(html.includes(">1</text>"));
  assert.ok(html.includes(">N</text>"));
});

test("diagram HTML escapes table and column names", () => {
  const html = diagramHtml({
    tables: [{ id: "x", name: "<script>alert(1)</script>", columns: [{ name: "a&b" }] }],
    pos: { x: 0, y: 0 },
    edges: [],
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("a&amp;b"));
});

test("diagram HTML works with no edges and no positions", () => {
  const html = diagramHtml({ tables, pos: undefined, edges: [] });
  assert.ok(html.includes("produk_jenis_produk"));
  assert.ok(!html.includes("<path d=\"M"));
});

// --- Results print document ---------------------------------------------------
import { tableHtml } from "../src/export.js";

test("results HTML is a standalone printable document", () => {
  const html = tableHtml({ columns, labels: ["nama", "qty"], rows, sql: "SELECT 1" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));
  assert.ok(html.includes("@media print"), "print stylesheet present");
  assert.ok(html.includes("SELECT 1"), "the SQL is included so the printout is self-explanatory");
});

test("results HTML prefers the disambiguated labels", () => {
  const html = tableHtml({
    columns: [{ name: "nama" }, { name: "nama" }],
    labels: ["nama · jenis_produk", "nama · tenant"],
    rows: [["a", "b"]],
  });
  assert.ok(html.includes("nama · jenis_produk"));
  assert.ok(html.includes("nama · tenant"));
});

test("results HTML marks NULL and wraps long values", () => {
  const html = tableHtml({ columns, rows: [[null, "x".repeat(200)]] });
  assert.ok(html.includes('class="null">NULL<'), "NULL is styled, not blank");
  assert.ok(html.includes('class="wrap"'), "a long value gets a wrapping cell");
});

test("results HTML escapes user data", () => {
  const html = tableHtml({ columns: [{ name: "<b>" }], rows: [["<script>x</script>"]] });
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("results HTML of an empty result says so", () => {
  const html = tableHtml({ columns, rows: [] });
  assert.ok(html.includes("No rows."));
});

// --- PDF text colour ----------------------------------------------------------

test("PDF resets the fill to black after the header band", () => {
  // The band is painted 0.85 grey; without an explicit reset every following
  // text run inherits it and the rows come out grey.
  const text = Buffer.from(toPdf(columns, rows).bytes).toString("latin1");
  const band = text.indexOf("0.85 0.85 0.85 rg");
  assert.ok(band > 0, "header band is drawn");
  const after = text.slice(band);
  assert.ok(after.includes("0 0 0 rg"), "fill is reset to black right after the band");
  assert.ok(after.indexOf("0 0 0 rg") < after.indexOf("(nama)") + 1, "reset precedes the first data cell");
  assert.equal((text.match(/0\.85 0\.85 0\.85 rg/g) ?? []).length, 1, "grey is never re-applied to text");
});
